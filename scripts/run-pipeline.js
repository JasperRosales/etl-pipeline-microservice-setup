// Walks the whole pipeline once, calling each service in order and printing
// what every one of them returns. Requires the stack to be running
// (.\start-etl.ps1).
//
//   npm run pipeline                         one run, short output
//   npm run pipeline -- --full               print complete responses
//   npm run pipeline -- --since 2026-10-12T00:00:00Z
//   npm run pipeline -- --date 2026-10-01 --tz +08:00
//
// Steps (docs/http-contract.md section 5):
//   1. GET  /health          every service
//   2. POST /extract         extractor   -> raw transactions + run_id
//   3. POST /transform       transformer -> cleaned rows + dedupe_hash, rejects
//   4. POST /load            loader      -> inserted / skipped_duplicates
//   5. POST /notify          notifier    -> notification_id
//   6. GET  /report/daily    reporter    -> sales summary for one day
//   7. GET  /report/activity reporter    -> recent runs + notifications
//
// Each step feeds the next one, like the scheduler does on its cron tick. The
// difference is that this script runs once, now, and shows every response.
// Loading is idempotent, so a rerun loads 0 new rows and skips the rest as
// duplicates.

"use strict";

const http = require("http");

let config;
try {
  config = require("../services/shared/config");
} catch (err) {
  console.error(`[pipeline] ${err.message}`);
  process.exit(1);
}

function arg(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const FULL = process.argv.includes("--full");
const SINCE = arg("--since");
const DATE = arg("--date");
const TZ = arg("--tz");
const PREVIEW_ROWS = 2;

const url = (service, route) => `http://${config.host}:${config.services[service].port}${route}`;

// node:http with agent:false, like scripts/health-check.js: keep-alive sockets
// racing process exit can trip a libuv assertion on Windows.
function request(method, target, payload) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      target,
      { method, headers: payload === undefined ? {} : { "Content-Type": "application/json" }, agent: false },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => {
          let data = null;
          try {
            data = JSON.parse(body);
          } catch {
            /* reported below */
          }
          resolve({ status: res.statusCode, data, raw: body });
        });
      }
    );
    req.setTimeout(10000, () => req.destroy(new Error("timed out after 10s")));
    req.on("error", reject);
    req.end(payload === undefined ? undefined : JSON.stringify(payload));
  });
}

// Shortens long arrays so the console stays readable; --full disables it.
function preview(value) {
  if (FULL || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    const head = value.slice(0, PREVIEW_ROWS).map(preview);
    if (value.length > PREVIEW_ROWS) head.push(`... ${value.length - PREVIEW_ROWS} more (use --full)`);
    return head;
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = preview(v);
  return out;
}

function header(n, title) {
  console.log(`\n${"=".repeat(70)}\n ${n}. ${title}\n${"=".repeat(70)}`);
}

async function step(n, title, method, service, route, payload) {
  header(n, title);
  const target = url(service, route);
  console.log(`${method} ${target}`);
  if (payload !== undefined) {
    // Rows sent are the previous step's output, already printed: show a count.
    const shown = FULL
      ? payload
      : Object.fromEntries(Object.entries(payload).map(([k, v]) => [k, Array.isArray(v) ? `[${v.length} rows]` : v]));
    console.log(`request: ${JSON.stringify(shown)}`);
  }
  const res = await request(method, target, payload);
  console.log(`status:  ${res.status}`);
  console.log(JSON.stringify(res.data === null ? res.raw : preview(res.data), null, 2));
  if (res.status < 200 || res.status >= 300 || res.data === null) {
    const msg = res.data && res.data.error ? `${res.data.error.code}: ${res.data.error.message}` : `HTTP ${res.status}`;
    throw new Error(`${service}${route} failed (${msg})`);
  }
  return res.data;
}

// Local calendar date of an ISO instant at offset tz ("+08:00", "Z", or the
// machine's offset when absent), so the default report day matches the data.
function localDate(iso, tz) {
  const t = new Date(iso);
  let offsetMin = -t.getTimezoneOffset();
  if (tz) {
    const m = /^([+-])(\d{2}):(\d{2})$/.exec(tz);
    offsetMin = tz === "Z" ? 0 : m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : offsetMin;
  }
  return new Date(t.getTime() + offsetMin * 60000).toISOString().slice(0, 10);
}

async function main() {
  console.log("ETL pipeline run: calling each service in order");

  // 1. Health of every service, so a missing one is obvious before step 2.
  header(1, "GET /health on every service");
  const down = [];
  for (const svc of Object.values(config.services)) {
    try {
      const res = await request("GET", url(svc.name, "/health"));
      console.log(`  ${res.status === 200 ? "UP  " : "DOWN"} ${svc.name.padEnd(12)} ${res.raw}`);
      if (res.status !== 200) down.push(svc.name);
    } catch (err) {
      console.log(`  DOWN ${svc.name.padEnd(12)} ${err.code || err.message}`);
      down.push(svc.name);
    }
  }
  const required = ["extractor", "transformer", "loader", "notifier", "reporter"];
  const missing = required.filter((s) => down.includes(s));
  if (missing.length) throw new Error(`not running: ${missing.join(", ")}. Start the stack with .\\start-etl.ps1`);

  const extracted = await step(2, "Extractor: read the CSV", "POST", "extractor", "/extract", SINCE ? { since: SINCE } : {});
  const transformed = await step(3, "Transformer: validate, clean, dedupe", "POST", "transformer", "/transform", {
    transactions: extracted.transactions,
  });
  const loaded = await step(4, "Loader: write to SQLite", "POST", "loader", "/load", {
    run_id: extracted.run_id,
    transactions: transformed.transactions,
  });

  const rejected = [...(extracted.rejected || []), ...transformed.rejected];
  const reasons = {};
  for (const r of rejected) reasons[r.reason] = (reasons[r.reason] || 0) + 1;
  const reasonText = rejected.length ? ` [${Object.entries(reasons).map(([k, v]) => `${k}: ${v}`).join(", ")}]` : "";
  const summary = `run ${extracted.run_id}: extracted ${extracted.rows}, loaded ${loaded.inserted}, duplicates ${loaded.skipped_duplicates}, rejected ${rejected.length}${reasonText}`;

  await step(5, "Notifier: record the outcome", "POST", "notifier", "/notify", {
    channel: "log",
    subject: "ETL run completed (manual)",
    body: summary,
  });

  // Default report day: the newest transaction in this batch, else today.
  const newest = extracted.transactions.reduce(
    (max, tx) => (typeof tx.transaction_ts === "string" && tx.transaction_ts > max ? tx.transaction_ts : max),
    ""
  );
  const date = DATE || localDate(newest || new Date().toISOString(), TZ);
  const query = new URLSearchParams({ date });
  if (TZ) query.set("tz", TZ);
  await step(6, `Reporter: daily report for ${date}`, "GET", "reporter", `/report/daily?${query}`);
  await step(7, "Reporter: recent activity", "GET", "reporter", "/report/activity?limit=5");

  console.log(`\n${"=".repeat(70)}\n DONE  ${summary}\n${"=".repeat(70)}`);
}

main().catch((err) => {
  console.error(`\nPipeline run FAILED: ${err.message}`);
  process.exitCode = 1;
});
