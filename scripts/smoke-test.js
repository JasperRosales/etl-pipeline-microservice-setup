// End-to-end smoke test (Issue 7, Day 7): extract -> transform -> load
// against fixture data, asserting row counts and cross-run duplicate
// protection. Requires the stack to be running (.\start-etl.ps1).
//
//   npm run smoke
//
// How it works:
//   1. Serves the fixture rows from a throwaway Sheets endpoint inside this
//      process and starts a throwaway extractor on port 3099 with
//      LOG_DIR=logs\smoke, so the real .env, ports, and service logs stay
//      untouched.
//   2. Drives the REAL transformer (3002) and loader (3003) over HTTP.
//   3. Asserts: 3 fixture rows -> 2 valid + 1 rejected; loading the same rows
//      again under a different run_id inserts 0 and skips 2; exactly 2
//      SMOKE- rows exist in the database no matter how often you rerun.
//   4. Asserts the structured event logs received the run (logs\*.jsonl,
//      one JSON object per line).
//
// Fixture rows keep fixed timestamps so their dedupe_hash never changes:
// rerunning the test is what proves "inserted only once".

"use strict";

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");
const { once } = require("events");

const Database = require("better-sqlite3");

const projectRoot = path.resolve(__dirname, "..");

let config;
try {
  config = require(path.join(projectRoot, "services", "shared", "config"));
} catch (err) {
  console.error(`Smoke test cannot load configuration: ${err.message}`);
  process.exit(1);
}

const FIXTURE_ROWS = [
  { id: "SMOKE-001", amount: "10.00", currency: "USD", timestamp: "2026-01-01T12:00:00.000Z", row: 2 },
  { id: "SMOKE-002", amount: "5.25", currency: "USD", timestamp: "2026-01-01T12:05:00.000Z", row: 3 },
  { id: "SMOKE-BAD", amount: "not-a-number", currency: "USD", timestamp: "2026-01-01T12:10:00.000Z", row: 4 },
];
const TEMP_EXTRACTOR_PORT = 3099;
const SMOKE_LOG_DIR = path.join(projectRoot, "logs", "smoke");

let failures = 0;
let mock = null;
let extractor = null;

function check(name, ok, detail) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : ` (${detail})`}`);
  if (!ok) failures++;
}

function tailFile(file, maxChars = 2000) {
  try {
    const raw = fs.readFileSync(file, "utf8");
    return raw.slice(-maxChars).trim() || "(empty)";
  } catch {
    return "(no file)";
  }
}

// node:http with agent:false, like scripts/health-check.js: keep-alive sockets
// racing a forced process exit can trip a libuv assertion on Windows.
function request(method, url, payload) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
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
            /* callers validate status + shape */
          }
          resolve({ status: res.statusCode, data, raw: body });
        });
      }
    );
    req.setTimeout(15000, () => req.destroy(new Error("request timed out after 15s")));
    req.on("error", reject);
    req.end(payload === undefined ? undefined : JSON.stringify(payload));
  });
}

async function isHealthy(url, expectService) {
  try {
    const res = await request("GET", url);
    return res.status === 200 && res.data && res.data.status === "ok" && res.data.service === expectService;
  } catch {
    return false;
  }
}

async function waitFor(url, service, tries = 50, delayMs = 100) {
  for (let i = 0; i < tries; i++) {
    if (await isHealthy(url, service)) return true;
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return false;
}

function startMockSheets() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname === "/sheet" && url.searchParams.get("token") === "smoke-token") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(FIXTURE_ROWS));
        return;
      }
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { code: "forbidden", message: "bad token" } }));
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function startTempExtractor(mockPort) {
  fs.mkdirSync(SMOKE_LOG_DIR, { recursive: true });
  const outFd = fs.openSync(path.join(SMOKE_LOG_DIR, "extractor.out.log"), "w");
  const errFd = fs.openSync(path.join(SMOKE_LOG_DIR, "extractor.err.log"), "w");
  const child = spawn(process.execPath, [path.join(projectRoot, "services", "extractor", "index.js")], {
    cwd: projectRoot,
    env: {
      ...process.env, // explicit values below win; dotenv never overrides existing vars
      PORT_EXTRACTOR: String(TEMP_EXTRACTOR_PORT),
      SHEETS_ENDPOINT: `http://127.0.0.1:${mockPort}/sheet`,
      API_TOKEN: "smoke-token",
      LOG_DIR: "./logs/smoke",
    },
    stdio: ["ignore", outFd, errFd],
  });
  fs.closeSync(outFd);
  fs.closeSync(errFd);
  child.on("error", (err) => console.error(`fixture extractor spawn error: ${err.message}`));
  return child;
}

async function stopTempExtractor(child) {
  if (!child || child.exitCode !== null) return;
  try {
    fs.writeFileSync(path.join(SMOKE_LOG_DIR, "extractor.stop"), "smoke");
  } catch {
    /* fall through to the kill path */
  }
  const outcome = await Promise.race([
    once(child, "exit").then(() => "exited"),
    new Promise((resolve) => setTimeout(() => resolve("timeout"), 5000)),
  ]);
  if (outcome === "timeout") {
    child.kill();
    await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 2000))]);
  }
}

async function cleanup() {
  const child = extractor;
  const server = mock;
  extractor = null;
  mock = null;
  await stopTempExtractor(child);
  if (server) await new Promise((resolve) => server.close(resolve));
}

function countSmokeRows() {
  const db = new Database(config.dbPath, { readonly: true });
  try {
    return db.prepare(`SELECT COUNT(*) AS n FROM transactions WHERE external_id LIKE 'SMOKE-%'`).get().n;
  } finally {
    db.close();
  }
}

function getRun(runId) {
  const db = new Database(config.dbPath, { readonly: true });
  try {
    return db.prepare("SELECT run_id, rows_in, rows_out FROM etl_runs WHERE run_id = ?").get(runId);
  } finally {
    db.close();
  }
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return { lines: [], allParse: false };
  const lines = fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "");
  let allParse = lines.length > 0;
  for (const line of lines) {
    try {
      JSON.parse(line);
    } catch {
      allParse = false;
    }
  }
  return { lines, allParse };
}

async function main() {
  const transformerUrl = `http://${config.host}:${config.services.transformer.port}`;
  const loaderUrl = `http://${config.host}:${config.services.loader.port}`;
  const extractorUrl = `http://${config.host}:${TEMP_EXTRACTOR_PORT}`;

  console.log("Smoke test: extract -> transform -> load (fixture data)\n");

  // 0. The real transformer and loader must be running.
  const [transformerUp, loaderUp] = await Promise.all([
    isHealthy(`${transformerUrl}/health`, "transformer"),
    isHealthy(`${loaderUrl}/health`, "loader"),
  ]);
  check("stack is running (transformer + loader)", transformerUp && loaderUp,
    transformerUp && loaderUp ? "both healthy" : "run .\\start-etl.ps1 first");
  if (!transformerUp || !loaderUp) return;

  try {
    // 1. Fixture endpoint + throwaway extractor.
    mock = await startMockSheets();
    extractor = startTempExtractor(mock.address().port);
    const extractorUp = await waitFor(`${extractorUrl}/health`, "extractor");
    check(`fixture extractor is up on port ${TEMP_EXTRACTOR_PORT}`, extractorUp,
      extractorUp ? "healthy" : tailFile(path.join(SMOKE_LOG_DIR, "extractor.err.log")));
    if (!extractorUp) return;

    // 2. extract
    const extract = await request("POST", `${extractorUrl}/extract`, {});
    check("extract: fixture returns 3 rows",
      extract.status === 200 && extract.data && extract.data.rows === 3 && extract.data.transactions.length === 3,
      `status=${extract.status} rows=${extract.data ? extract.data.rows : "n/a"}`);
    if (extract.status !== 200 || !extract.data) return;
    const runA = extract.data.run_id;

    // 3. transform
    const transform = await request("POST", `${transformerUrl}/transform`, { transactions: extract.data.transactions });
    const t = transform.data || {};
    check("transform: 3 in -> 2 out + 1 rejected (invalid_amount)",
      t.rows_in === 3 && t.rows_out === 2 && Array.isArray(t.rejected) &&
        t.rejected.length === 1 && t.rejected[0].reason === "invalid_amount",
      `rows_in=${t.rows_in} rows_out=${t.rows_out} rejected=${Array.isArray(t.rejected) ? t.rejected.length : "n/a"}`);
    if (!Array.isArray(t.transactions) || t.transactions.length !== 2) return;

    // 4. load A: fresh database inserts 2, a rerun skips 2 - both are correct.
    const before = countSmokeRows();
    const loadA = await request("POST", `${loaderUrl}/load`, { run_id: runA, transactions: t.transactions });
    const a = loadA.data || {};
    const expectedInsert = before === 0 ? 2 : 0;
    check("load A: inserts only the rows the database is missing",
      loadA.status === 200 && a.inserted === expectedInsert && a.skipped_duplicates === 2 - expectedInsert,
      `before=${before} inserted=${a.inserted} skipped=${a.skipped_duplicates}`);

    // 5. load B: the same rows under a fresh run_id -> pure duplicate.
    const runB = `smoke-${crypto.randomUUID()}`;
    const loadB = await request("POST", `${loaderUrl}/load`, { run_id: runB, transactions: t.transactions });
    const b = loadB.data || {};
    check("load B: same rows again -> 0 inserted, 2 skipped",
      loadB.status === 200 && b.inserted === 0 && b.skipped_duplicates === 2,
      `inserted=${b.inserted} skipped=${b.skipped_duplicates}`);

    // 6. database state
    const count = countSmokeRows();
    check("database holds exactly 2 SMOKE- rows", count === 2, `count=${count}`);
    const runBRow = getRun(runB);
    check("etl_runs recorded the duplicate run with rows_out=0",
      Boolean(runBRow) && runBRow.rows_out === 0, runBRow ? `rows_out=${runBRow.rows_out}` : "missing");

    // 7. structured event logs (Issue 7)
    const loaderLog = readJsonl(path.join(config.logDir, "loader.jsonl"));
    check("loader.jsonl: every line is one JSON event",
      loaderLog.lines.length > 0 && loaderLog.allParse, `${loaderLog.lines.length} lines`);
    const loadLines = loaderLog.lines.filter(
      (line) => line.includes('"event":"load"') && line.includes(`"run_id":"${runA}"`)
    );
    check("loader.jsonl: exactly one load line for the smoke run_id",
      loadLines.length === 1, `lines=${loadLines.length}`);
    const smokeExtractorLog = readJsonl(path.join(SMOKE_LOG_DIR, "extractor.jsonl"));
    check("fixture extractor logged the extract (logs\\smoke\\extractor.jsonl)",
      smokeExtractorLog.allParse && smokeExtractorLog.lines.some((line) => line.includes(`"run_id":"${runA}"`)),
      `${smokeExtractorLog.lines.length} lines`);
  } finally {
    await cleanup();
  }
}

main()
  .then(() => {
    if (failures === 0) {
      console.log("\nSmoke test PASSED (all checks green).");
    } else {
      console.log(`\nSmoke test FAILED: ${failures} check(s) failed.`);
    }
    process.exitCode = failures === 0 ? 0 : 1;
  })
  .catch(async (err) => {
    await cleanup();
    console.error(`\nSmoke test FAILED with an unexpected error: ${err.stack || err.message}`);
    process.exitCode = 1;
  });
