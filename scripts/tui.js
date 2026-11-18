// Terminal UI for the local ETL stack: start/stop services, watch health,
// tail logs and run the pipeline, tests and DB scripts from one screen.
// Works on Windows, Linux and macOS with no extra dependencies.
//
//   npm run tui
//
// Services are started the same way as start-etl.ps1 (detached node process
// per service, stdout/stderr in logs/<service>.out.log / .err.log, PIDs in
// logs/service-pids.json), so stop-etl.ps1 and the TUI can stop each other's
// services. Stopping writes logs/<service>.stop (the graceful channel in
// services/shared/app.js) and sends SIGTERM where signals exist; anything
// still alive after 4s is killed.

"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

let config;
try {
  config = require("../services/shared/config");
} catch (err) {
  console.error(`[tui] ${err.message}`);
  process.exit(1);
}

const ROOT = config.projectRoot;
const LOG_DIR = config.logDir;
const PID_FILE = path.join(LOG_DIR, "service-pids.json");
const NODE = process.execPath;
const WIN = process.platform === "win32";
const SERVICES = Object.values(config.services).map((s) => s.name);

fs.mkdirSync(LOG_DIR, { recursive: true });
fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

// ---------- state ----------
const state = {
  sel: 0,
  sample: -1, // index into sampleCsvs() of the last test CSV run with v
  health: {}, // name -> { ok, uptime }
  view: "log", // "log" (selected service) | "job" (last action output)
  job: null, // { title, lines, proc, code }
  scroll: 0, // lines scrolled up from the bottom of the output pane
  msg: "",
  busy: new Set(), // services being started/stopped
  dbReady: false,
};

// ---------- terminal helpers ----------
const ESC = "\x1b[";
const c = {
  dim: (s) => `${ESC}2m${s}${ESC}0m`,
  bold: (s) => `${ESC}1m${s}${ESC}0m`,
  inv: (s) => `${ESC}7m${s}${ESC}0m`,
  red: (s) => `${ESC}31m${s}${ESC}0m`,
  green: (s) => `${ESC}32m${s}${ESC}0m`,
  yellow: (s) => `${ESC}33m${s}${ESC}0m`,
  cyan: (s) => `${ESC}36m${s}${ESC}0m`,
};
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

// Cuts s to w visible columns, keeping colour codes intact.
function fit(s, w) {
  let out = "";
  let n = 0;
  for (let i = 0; i < s.length; ) {
    if (s[i] === "\x1b") {
      const m = /^\x1b\[[0-9;]*[A-Za-z]/.exec(s.slice(i));
      if (m) {
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    if (n >= w) break;
    out += s[i++];
    n++;
  }
  return out + `${ESC}0m` + " ".repeat(Math.max(0, w - n));
}

function tail(file, max) {
  try {
    const st = fs.statSync(file);
    const len = Math.min(st.size, 64 * 1024);
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(file, "r");
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    return buf.toString("utf8").split(/\r?\n/).filter(Boolean).slice(-max);
  } catch {
    return [];
  }
}

// ---------- PID bookkeeping (same format as start-etl.ps1) ----------
function readPids() {
  try {
    const data = JSON.parse(fs.readFileSync(PID_FILE, "utf8").replace(/^﻿/, ""));
    const list = Array.isArray(data) ? data : [data];
    return Object.fromEntries(list.map((e) => [e.Service, e.ProcessId]));
  } catch {
    return {};
  }
}

function writePids(pids) {
  const list = Object.entries(pids).map(([Service, ProcessId]) => ({ Service, ProcessId }));
  if (list.length) fs.writeFileSync(PID_FILE, JSON.stringify(list, null, 2));
  else fs.rmSync(PID_FILE, { force: true });
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

// ---------- health ----------
function probe(name) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: config.host, port: config.services[name].port, path: "/health", agent: false, timeout: 1500 },
      (res) => {
        let raw = "";
        res.on("data", (d) => (raw += d));
        res.on("end", () => {
          let body = {};
          try {
            body = JSON.parse(raw);
          } catch {}
          resolve({ ok: res.statusCode === 200, uptime: body.uptime_s });
        });
      }
    );
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve({ ok: false }));
  });
}

async function pollHealth() {
  const results = await Promise.all(SERVICES.map(probe));
  SERVICES.forEach((n, i) => (state.health[n] = results[i]));
  render();
}

// ---------- service control ----------
function initDb() {
  if (state.dbReady) return true;
  const r = spawnSync(NODE, [path.join(ROOT, "scripts", "init-db.js")], { cwd: ROOT, encoding: "utf8" });
  if (r.status !== 0) {
    state.msg = c.red(`init-db failed: ${(r.stderr || r.stdout || "").trim().split("\n").pop()}`);
    return false;
  }
  state.dbReady = true;
  return true;
}

function startService(name) {
  const pids = readPids();
  if (alive(pids[name]) || state.health[name]?.ok) {
    state.msg = `${name} is already running`;
    return;
  }
  if (!initDb()) return;
  const dir = path.join(ROOT, "services", name);
  fs.rmSync(path.join(LOG_DIR, `${name}.stop`), { force: true });
  const outFile = path.join(LOG_DIR, `${name}.out.log`);
  const errFile = path.join(LOG_DIR, `${name}.err.log`);
  const pid = WIN ? spawnHiddenWindows(dir, outFile, errFile) : spawnDetached(dir, outFile, errFile);
  if (!pid) {
    state.msg = c.red(`could not start ${name}`);
    return;
  }
  pids[name] = pid;
  writePids(pids);
  state.msg = `started ${name} (pid ${pid})`;
}

function spawnDetached(dir, outFile, errFile) {
  const out = fs.openSync(outFile, "w");
  const err = fs.openSync(errFile, "w");
  const child = spawn(NODE, ["index.js"], { cwd: dir, detached: true, stdio: ["ignore", out, err] });
  fs.closeSync(out);
  fs.closeSync(err);
  child.unref();
  return child.pid;
}

// On Windows a detached child gets its own console window, and Node's
// windowsHide does not hide it (nodejs/node#21825). Start-Process with
// -WindowStyle Hidden runs the service with no window and fully detached,
// so it keeps running after the TUI exits.
function spawnHiddenWindows(dir, outFile, errFile) {
  const q = (s) => `'${String(s).replace(/'/g, "''")}'`;
  const cmd =
    `$p = Start-Process -FilePath ${q(NODE)} -ArgumentList 'index.js' -WorkingDirectory ${q(dir)} ` +
    `-RedirectStandardOutput ${q(outFile)} -RedirectStandardError ${q(errFile)} -WindowStyle Hidden -PassThru; $p.Id`;
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", cmd], {
    encoding: "utf8",
    windowsHide: true,
  });
  const pid = Number((r.stdout || "").trim().split(/\r?\n/).pop());
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function stopService(name) {
  return new Promise((resolve) => {
    const pids = readPids();
    const pid = pids[name];
    if (!alive(pid) && !state.health[name]?.ok) {
      delete pids[name];
      writePids(pids);
      return resolve();
    }
    state.busy.add(name);
    // Graceful channel watched by every service (also reaches services
    // started outside the TUI), plus SIGTERM where the OS supports it.
    fs.writeFileSync(path.join(LOG_DIR, `${name}.stop`), "");
    if (!WIN && alive(pid)) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {}
    }
    const deadline = Date.now() + 4000;
    const timer = setInterval(async () => {
      const up = alive(pid) || (await probe(name)).ok;
      if (up && Date.now() < deadline) return;
      clearInterval(timer);
      if (up && alive(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
      fs.rmSync(path.join(LOG_DIR, `${name}.stop`), { force: true });
      const now = readPids();
      delete now[name];
      writePids(now);
      state.busy.delete(name);
      state.health[name] = { ok: false };
      resolve();
    }, 300);
  });
}

async function stopAll() {
  state.msg = "stopping all services...";
  render();
  await Promise.all(SERVICES.map(stopService));
  state.msg = "all services stopped";
}

function startAll() {
  // Same order as start-etl.ps1: scheduler last, after its targets.
  for (const n of SERVICES) startService(n);
  state.msg = "started all services";
}

async function restart(name) {
  state.msg = `restarting ${name}...`;
  render();
  await stopService(name);
  startService(name);
}

// ---------- jobs (pipeline, tests, scripts) ----------
function runJob(title, args) {
  if (state.job?.proc) {
    state.msg = "a job is already running (c to cancel)";
    return;
  }
  const job = { title, lines: [], proc: null, code: null };
  const proc = spawn(NODE, args, { cwd: ROOT, windowsHide: true });
  job.proc = proc;
  let partial = "";
  const onData = (d) => {
    const parts = (partial + d.toString("utf8")).split(/\r?\n/);
    partial = parts.pop();
    job.lines.push(...parts);
    if (job.lines.length > 3000) job.lines.splice(0, job.lines.length - 3000);
    render();
  };
  proc.stdout.on("data", onData);
  proc.stderr.on("data", onData);
  proc.on("close", (code) => {
    if (partial) job.lines.push(partial);
    job.proc = null;
    job.code = code;
    state.msg = code === 0 ? c.green(`${title}: done`) : c.red(`${title}: exit ${code}`);
    render();
  });
  state.job = job;
  state.view = "job";
  state.scroll = 0;
  state.msg = `${title}: running...`;
}

const SAMPLE_DIR = path.join(ROOT, "data", "samples", "csv");
const sampleCsvs = () => {
  try {
    return fs.readdirSync(SAMPLE_DIR).filter((f) => f.endsWith(".csv")).sort();
  } catch {
    return [];
  }
};

const testFiles = () =>
  fs
    .readdirSync(path.join(ROOT, "test"))
    .filter((f) => f.endsWith(".test.js"))
    .map((f) => path.join("test", f));

// ---------- rendering ----------
function fmtUptime(s) {
  if (s === undefined) return "";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

function ago(ts) {
  const s = Math.max(0, Math.floor((Date.now() - new Date(ts).getTime()) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`;
}

const short = (s, n = 24) => (String(s).length > n ? String(s).slice(0, n - 1) + "…" : String(s));

// Turns a service's latest work event (logs/<service>.jsonl) into a short
// indicator: what it produced last time it was called, and how long ago.
const INDICATORS = {
  extract: (e) => [`${e.rows} rows${e.rejected ? ` · ${c.yellow(`${e.rejected} rej`)}` : ""}`, "ok"],
  transform: (e) => [`${e.rows_in}→${e.rows_out}${e.rejected ? ` · ${c.yellow(`${e.rejected} rej`)}` : ""}`, "ok"],
  load: (e) => [`${c.green(`+${e.inserted} new`)} · ${e.skipped_duplicates} dup`, "ok"],
  report: (e) => [`${e.date}: ${e.transactions_count} tx`, "ok"],
  notify: (e) => [`${e.delivered === false ? c.yellow("undelivered ") : ""}${short(e.subject, 22)}`, "ok"],
  pipeline_ok: (e) =>
    [`${c.green("✓")} +${e.inserted} · ${e.skipped} dup${e.rejected ? ` · ${c.yellow(`${e.rejected} rej`)}` : ""} · ${e.duration_ms}ms`, "ok"],
  batch_rejected: (e) => [c.red(`✗ neglected: ${e.percent}% bad (${e.bad}/${e.total})`), "warn"],
  cron_scheduled: (e) => [c.dim(`waiting · cron ${e.cron}`), "idle"],
  tick_skipped: () => [c.yellow("tick skipped (run busy)"), "warn"],
  retry: (e) => [c.yellow(`retry ${e.attempt}: ${short(e.target, 18)}`), "warn"],
};
const QUIET = new Set(["startup", "shutdown", "extract_rejected"]);

function indicator(name) {
  const lines = tail(path.join(LOG_DIR, `${name}.jsonl`), 200);
  let errors = 0;
  let found = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    let e;
    try {
      e = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    // Only this run of the service. The scheduler logs cron_scheduled just
    // before its startup line, so look one line further for it.
    if (e.event === "startup") {
      if (!found && i > 0 && lines[i - 1].includes('"cron_scheduled"')) found = JSON.parse(lines[i - 1]);
      break;
    }
    if (e.level === "error") errors++;
    if (!found && !QUIET.has(e.event)) found = e;
  }
  if (!found) return c.dim("no activity yet");
  let text;
  if (found.level === "error") text = c.red(`✗ ${found.event}: ${short(found.message || found.error || "", 28)}`);
  else if (INDICATORS[found.event]) text = INDICATORS[found.event](found)[0];
  else text = found.event;
  const errText = errors && found.level !== "error" ? c.red(` ${errors} err`) : "";
  return `${text}${errText} ${c.dim(ago(found.ts))}`;
}

function prettyLog(line) {
  if (!line.startsWith("{")) return line;
  try {
    const { ts, level, event, service, ...rest } = JSON.parse(line);
    const t = ts ? new Date(ts).toTimeString().slice(0, 8) : "";
    const extra = Object.entries(rest)
      .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v) : v}`)
      .join(" ");
    const lvl = level === "error" ? c.red("ERR") : level === "warn" ? c.yellow("WRN") : c.dim("inf");
    return `${c.dim(t)} ${lvl} ${c.bold(event)} ${extra}`;
  } catch {
    return line;
  }
}

// Splits long plain lines so nothing is cut off on narrow (phone) screens.
function wrap(lines, w) {
  const out = [];
  for (const l of lines) {
    if (/^=+$/.test(l)) {
      out.push("─".repeat(w)); // the pipeline's ===== rules, sized to the pane
      continue;
    }
    if (l.length <= w) {
      out.push(l);
      continue;
    }
    out.push(l.slice(0, w));
    for (let i = w; i < l.length; i += w - 1) out.push(" " + l.slice(i, i + w - 1));
  }
  return out;
}

function outputLines(max, w) {
  if (state.view === "job" && state.job) {
    return wrap(state.job.lines, w).map((l) =>
      /\b(FAIL|DOWN|FAILED|NEGLECTED|not ok)\b/.test(l) ? c.red(l) : /\b(PASS|OK|UP|DONE|ok)\b/.test(l) ? c.green(l) : l
    );
  }
  const name = SERVICES[state.sel];
  const err = wrap(tail(path.join(LOG_DIR, `${name}.err.log`), max).map((l) => prettyLog(l).replace(ANSI, "")), w).map(c.red);
  const out = wrap(tail(path.join(LOG_DIR, `${name}.out.log`), max).map((l) => prettyLog(l).replace(ANSI, "")), w);
  return [...out, ...err];
}

// ---------- look ----------
const fg = (n) => (s) => `${ESC}38;5;${n}m${s}${ESC}0m`;
const RAMP = [196, 202, 208, 214, 220]; // red -> orange -> yellow, like salsa
const accent = fg(208);
const SPIN = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
const spin = () => SPIN[Math.floor(Date.now() / 100) % SPIN.length];

// "SALSA" in ANSI Shadow block letters, 40 columns wide.
const LOGO = [
  "███████╗ █████╗ ██╗     ███████╗ █████╗ ",
  "██╔════╝██╔══██╗██║     ██╔════╝██╔══██╗",
  "███████╗███████║██║     ███████╗███████║",
  "╚════██║██╔══██║██║     ╚════██║██╔══██║",
  "███████║██║  ██║███████╗███████║██║  ██║",
  "╚══════╝╚═╝  ╚═╝╚══════╝╚══════╝╚═╝  ╚═╝",
];

// Colours the logo with a left-to-right ramp; the shadow strokes stay dark red.
function logoLines(W) {
  const pad = " ".repeat(Math.max(0, Math.floor((W - LOGO[0].length) / 2)));
  return LOGO.map((row) => {
    let out = "";
    [...row].forEach((ch, x) => {
      if (ch === " ") out += " ";
      else if (ch === "█") out += `${ESC}38;5;${RAMP[Math.floor((x / row.length) * RAMP.length)]}m${ch}`;
      else out += `${ESC}38;5;88m${ch}`;
    });
    return pad + out + `${ESC}0m`;
  });
}

const visible = (s) => s.replace(ANSI, "").length;
const center = (s, W) => " ".repeat(Math.max(0, Math.floor((W - visible(s)) / 2))) + s;

// Rounded panel with a title on the left and an optional note on the right.
function box(title, note, body, W) {
  const inner = W - 4;
  const left = `╭─ ${title} `;
  const right = note ? ` ${note} ─╮` : "─╮";
  const fill = Math.max(0, W - visible(left) - visible(right));
  const top = c.dim("╭─ ") + c.bold(accent(title)) + c.dim(" " + "─".repeat(fill)) + (note ? ` ${note} ` + c.dim("─╮") : c.dim("─╮"));
  return [top, ...body.map((l) => c.dim("│ ") + fit(l, inner) + c.dim(" │")), c.dim("╰" + "─".repeat(W - 2) + "╯")];
}

// Key hints as "key label" chips, wrapped to the screen width.
function keyLines(W) {
  const keys = [
    ["↑↓", "select"], ["s", "start"], ["x", "stop"], ["r", "restart"], ["a", "all on"], ["z", "all off"],
    ["p", "pipeline"], ["b", "bad data"], ["v", "test csv"], ["h", "health"], ["t", "tests"],
    ["l", "logs/output"], ["j/k", "scroll"], ["i", "db init"], ["e", "db seed"], ["c", "cancel"],
    ["q", "quit"], ["Q", "stop+quit"],
  ];
  const lines = [];
  let cur = "";
  for (const [k, label] of keys) {
    const chip = `${c.bold(accent(k))} ${c.dim(label)}`;
    if (cur && visible(cur) + 2 + visible(chip) > W - 1) {
      lines.push(cur);
      cur = "";
    }
    cur += (cur ? "  " : " ") + chip;
  }
  if (cur) lines.push(cur);
  return lines;
}

function render() {
  const W = process.stdout.columns || 80;
  const H = process.stdout.rows || 24;
  const pids = readPids();
  const up = SERVICES.filter((n) => state.health[n]?.ok).length;
  const rows = [];

  // Header: the big SALSA logo when there is room, one line otherwise.
  const upText = up === SERVICES.length ? c.green(`● ${up}/${SERVICES.length} up`) : up ? c.yellow(`● ${up}/${SERVICES.length} up`) : c.red(`● 0/${SERVICES.length} up`);
  const clock = c.dim(new Date().toTimeString().slice(0, 8));
  const big = W >= 44 && H >= 34;
  if (big) {
    rows.push(...logoLines(W));
    rows.push(center(`${c.dim("POS ETL control")}  ${upText}  ${clock}`, W));
  } else {
    const word = [..."SALSA"].map((ch, i) => `${ESC}1;38;5;${RAMP[i]}m${ch}`).join("") + `${ESC}0m`;
    rows.push(` ${word} ${c.dim("ETL")}  ${upText}  ${clock}`);
  }

  // Services panel.
  const svc = SERVICES.map((n, i) => {
    const h = state.health[n] || {};
    const pid = pids[n];
    const dot = state.busy.has(n) ? c.yellow(spin()) : h.ok ? c.green("●") : alive(pid) ? c.yellow("◐") : c.red("○");
    const sel = i === state.sel;
    const name = sel ? c.bold(accent(`▶ ${n.padEnd(11)}`)) : `  ${n.padEnd(11)}`;
    return `${name} ${dot} ${c.dim(fmtUptime(h.uptime).padEnd(4))} ${indicator(n)}`;
  });
  rows.push(...box("Services", c.dim(`reject limit ${Math.round(config.maxRejectRatio * 100)}%`), svc, W));

  // Output panel: selected service's log, or the last job's output.
  const selName = SERVICES[state.sel];
  const selPid = pids[selName];
  let title;
  let note;
  if (state.view === "job" && state.job) {
    title = state.job.title;
    note = state.job.proc ? c.yellow(`${spin()} running`) : state.job.code === 0 ? c.green("✓ ok") : c.red(`✗ exit ${state.job.code}`);
  } else {
    title = `${selName} :${config.services[selName].port}`;
    note = c.dim(alive(selPid) ? `pid ${selPid}` : state.health[selName]?.ok ? "external" : "stopped");
  }
  if (state.scroll) note += c.dim(` ↑${state.scroll}`);

  const keys = keyLines(W);
  const footer = 1 + keys.length; // message + keys
  const paneH = Math.max(3, H - rows.length - 2 - footer); // 2 = output box borders
  const all = outputLines(paneH + 500, W - 4);
  const maxScroll = Math.max(0, all.length - paneH);
  state.scroll = Math.min(state.scroll, maxScroll);
  const end = all.length - state.scroll;
  const pane = all.slice(Math.max(0, end - paneH), end);
  while (pane.length < paneH) pane.push("");
  rows.push(...box(title, note, pane, W));

  rows.push(` ${accent("›")} ${state.msg || c.dim("ready")}`);
  rows.push(...keys);

  const frame = rows.slice(0, H).map((r) => fit(r, W));
  process.stdout.write(`${ESC}H` + frame.join("\r\n") + `${ESC}J`);
}

// Animate spinners only while something is in progress.
setInterval(() => {
  if (state.job?.proc || state.busy.size) render();
}, 120).unref();

// ---------- input ----------
let quitting = false;
function exit(code = 0) {
  process.stdout.write(`${ESC}?25h${ESC}?1049l`);
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  const running = SERVICES.filter((n) => state.health[n]?.ok).length;
  if (running) console.log(`${running} service(s) still running. Stop them with: npm run tui (z) or stop-etl.ps1`);
  process.exit(code);
}

async function onKey(key) {
  if (quitting) return;
  const name = SERVICES[state.sel];
  switch (key) {
    case "\x1b[A":
      state.sel = (state.sel + SERVICES.length - 1) % SERVICES.length;
      state.view = "log";
      state.scroll = 0;
      break;
    case "\x1b[B":
      state.sel = (state.sel + 1) % SERVICES.length;
      state.view = "log";
      state.scroll = 0;
      break;
    case "k":
    case "\x1b[5~":
      state.scroll += 5;
      break;
    case "j":
    case "\x1b[6~":
      state.scroll = Math.max(0, state.scroll - 5);
      break;
    case "l":
      state.view = state.view === "log" && state.job ? "job" : "log";
      state.scroll = 0;
      break;
    case "s":
      startService(name);
      state.view = "log";
      break;
    case "x":
      state.msg = `stopping ${name}...`;
      render();
      await stopService(name);
      state.msg = `stopped ${name}`;
      break;
    case "r":
      await restart(name);
      break;
    case "a":
      startAll();
      break;
    case "z":
      await stopAll();
      break;
    case "p":
      runJob("pipeline", ["scripts/run-pipeline.js"]);
      break;
    case "v": {
      const files = sampleCsvs();
      if (!files.length) {
        state.msg = "no test CSVs (run node scripts/make-sample-csvs.js)";
        break;
      }
      state.sample = (state.sample + 1) % files.length;
      const file = files[state.sample];
      runJob(`csv ${state.sample + 1}/${files.length}: ${file}`, ["scripts/run-pipeline.js", "--csv", path.join("data", "samples", "csv", file)]);
      break;
    }
    case "b":
      runJob("pipeline (bad data)", ["scripts/run-pipeline.js", "--input", "data/samples/bad-transactions.json"]);
      break;
    case "h":
      runJob("health", ["scripts/health-check.js"]);
      break;
    case "t":
      runJob("tests", ["--test", ...testFiles()]);
      break;
    case "i":
      runJob("db init", ["scripts/init-db.js"]);
      break;
    case "e":
      runJob("db seed", ["scripts/seed-db.js"]);
      break;
    case "c":
      if (state.job?.proc) {
        state.job.proc.kill();
        state.msg = "job cancelled";
      }
      break;
    case "Q":
      quitting = true;
      await stopAll();
      return exit(0);
    case "q":
    case "\x03": // Ctrl-C
      quitting = true;
      return exit(0);
  }
  render();
}

if (!process.stdin.isTTY) {
  console.error("[tui] needs an interactive terminal");
  process.exit(1);
}

process.stdout.write(`${ESC}?1049h${ESC}?25l${ESC}2J`);
process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  // Split pasted/batched input into single keys and escape sequences.
  const keys = d.match(/\x1b\[[0-9;]*[~A-Za-z]|[\s\S]/g) || [];
  keys.reduce((p, k) => p.then(() => onKey(k)), Promise.resolve());
});
process.stdout.on("resize", render);
process.on("SIGTERM", () => exit(0));
process.on("uncaughtException", (err) => {
  process.stdout.write(`${ESC}?25h${ESC}?1049l`);
  console.error(err);
  process.exit(1);
});

render();
pollHealth();
setInterval(pollHealth, 2000);
