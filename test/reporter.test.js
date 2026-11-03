// Reporter: day-range validation (unit) and /report/daily + /report/activity
// against a temp database (HTTP).

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const Database = require("better-sqlite3");
const { dayRange, parseTz } = require("../services/reporter/day-range");
const { tempDir, isolatedEnv, runNode, request, startService } = require("./helpers");

test("dayRange maps a local date to the UTC instants of that day", () => {
  assert.deepEqual(dayRange("2026-11-04", "+08:00"), {
    start: "2026-11-03T16:00:00.000Z",
    end: "2026-11-04T16:00:00.000Z",
    tz: "+08:00",
  });
  assert.equal(dayRange("2026-11-04", "Z").start, "2026-11-04T00:00:00.000Z");
  assert.equal(dayRange("2026-11-04", "-05:30").start, "2026-11-04T05:30:00.000Z");
});

test("dayRange defaults to this machine's offset", () => {
  const r = dayRange("2026-11-04");
  const local = new Date(2026, 10, 4, 0, 0, 0).toISOString();
  assert.equal(r.start, local);
});

test("dayRange rejects bad dates and offsets", () => {
  for (const date of [undefined, "", "2026-1-4", "2026-02-30", "2026-13-01", "yesterday", "2026-11-04T00:00"]) {
    assert.match(dayRange(date, "Z").error, /date/, String(date));
  }
  for (const tz of ["8", "+8:00", "+15:00", "+08:60", "UTC", "+0800"]) {
    assert.equal(parseTz(tz), null, tz);
    assert.match(dayRange("2026-11-04", tz).error, /tz/, tz);
  }
});

test("/report/daily and /report/activity read the pipeline's output", async (t) => {
  const dbPath = path.join(tempDir("etl-test-db-"), "pos.db");
  const init = runNode(`require("./scripts/init-db.js")`, isolatedEnv({ DB_PATH: dbPath, LOG_DIR: tempDir("etl-test-logs-") }));
  assert.equal(init.status, 0, init.stderr);

  const db = new Database(dbPath);
  const ins = db.prepare(`INSERT INTO transactions (external_id, source, amount_minor, currency, transaction_ts, payload_json, dedupe_hash)
                          VALUES (?, 's', ?, 'PHP', ?, ?, ?)`);
  const sale = (id, amount, ts, store, pay, items) =>
    ins.run(id, amount, ts, JSON.stringify({ store_id: store, payment_method: pay, items }), id);
  // 2026-11-04 in Manila (+08:00) runs from 2026-11-03T16:00Z to 2026-11-04T16:00Z.
  sale("A", 29800, "2026-11-03T23:30:00.000Z", "STORE-LIPA", "gcash", [{ sku: "SAL-001", name: "Salsa", qty: 2, unit_price: "149.00" }]);
  sale("B", 9900, "2026-11-04T15:59:59Z", "STORE-LIPA", "cash", [{ sku: "CHP-001", name: "Chips", qty: 1, unit_price: "99.00" }]);
  sale("C", 14900, "2026-11-03T10:00:00.000Z", "STORE-NASUGBU", "cash", [{ sku: "SAL-001", name: "Salsa", qty: 1, unit_price: "149.00" }]); // previous local day
  db.prepare(`INSERT INTO etl_runs (run_id, started_at, finished_at, status, rows_in, rows_out) VALUES ('r1', '2026-11-04T01:00:00Z', '2026-11-04T01:00:00Z', 'completed', 3, 3)`).run();
  db.prepare(`INSERT INTO notifications (channel, subject, body, sent_at) VALUES ('log', 'ETL run completed', 'run r1: extracted 3, loaded 3', '2026-11-04T01:00:00Z')`).run();
  db.prepare(`INSERT INTO notifications (channel, subject, body, sent_at) VALUES ('log', 'ETL run failed', 'extractor unreachable', '2026-11-04T01:00:30Z')`).run();
  db.close();

  const svc = await startService("reporter", { DB_PATH: dbPath });
  t.after(svc.stop);

  let r = await request("GET", `${svc.base}/report/daily?date=2026-11-04&tz=%2B08:00`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.transactions_count, 2);
  assert.equal(r.data.sales_total_minor, 39700);
  assert.equal(r.data.currency, "PHP");
  assert.deepEqual(r.data.by_store, [{ store_id: "STORE-LIPA", transactions_count: 2, sales_total_minor: 39700 }]);
  assert.deepEqual(r.data.by_payment.map((p) => p.payment_method), ["gcash", "cash"]);
  assert.deepEqual(r.data.top_items[0], { sku: "SAL-001", name: "Salsa", qty: 2, sales_total_minor: 29800 });
  assert.deepEqual(r.data.warnings, []);

  r = await request("GET", `${svc.base}/report/daily?date=2026-11-04&tz=Z`);
  assert.equal(r.data.transactions_count, 1); // only B falls on the UTC day

  r = await request("GET", `${svc.base}/report/daily?date=2026-10-01&tz=Z`);
  assert.equal(r.data.transactions_count, 0);
  assert.equal(r.data.currency, null);
  assert.deepEqual(r.data.warnings, ["no transactions for this date"]);

  r = await request("GET", `${svc.base}/report/daily?date=2026-02-30`);
  assert.equal(r.status, 400);

  r = await request("GET", `${svc.base}/report/activity?limit=5`);
  assert.equal(r.status, 200);
  assert.equal(r.data.loaded_transactions, 3);
  assert.match(r.data.last_loaded_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  assert.equal(r.data.runs[0].run_id, "r1");
  assert.deepEqual(r.data.notifications.map((n) => n.subject), ["ETL run failed", "ETL run completed"]);

  for (const limit of ["0", "101", "abc"]) {
    assert.equal((await request("GET", `${svc.base}/report/activity?limit=${limit}`)).status, 400, limit);
  }
});
