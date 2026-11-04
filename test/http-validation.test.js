// Request validation on the real services over HTTP: each service is spawned
// on a throwaway port with a temp DB and log dir (see helpers.js).

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { tempDir, isolatedEnv, runNode, request, startService } = require("./helpers");

test("transformer rejects bad requests and validates records", async (t) => {
  const svc = await startService("transformer");
  t.after(svc.stop);

  let r = await request("POST", `${svc.base}/transform`, { transactions: "nope" });
  assert.equal(r.status, 400);
  assert.equal(r.data.error.code, "invalid_request");

  r = await request("POST", `${svc.base}/transform`, "{not json");
  assert.equal(r.status, 400);
  assert.equal(r.data.error.code, "invalid_request");

  r = await request("POST", `${svc.base}/transform`, {
    transactions: [
      { external_id: "A", source: "s", amount_minor: 100, currency: "PHP", transaction_ts: "2026-10-01T00:00:00Z" },
      { external_id: "B", source: "s", amount_minor: 1.5, currency: "PHP", transaction_ts: "2026-10-01T00:00:00Z" },
    ],
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.rows_out, 1);
  assert.equal(r.data.rejected[0].reason, "invalid_amount");

  for (const body of ["[]", "\"text\"", "42", "null"]) {
    r = await request("POST", `${svc.base}/transform`, body);
    assert.equal(r.status, 400, body);
    assert.equal(r.data.error.code, "invalid_request");
  }

  r = await request("GET", `${svc.base}/nope`);
  assert.equal(r.status, 404);
  assert.equal(r.data.error.code, "not_found");
});

test("loader validates run_id, transactions, and dedupe_hash; inserts idempotently", async (t) => {
  const dbPath = path.join(tempDir("etl-test-db-"), "pos.db");
  const init = runNode(`require("./scripts/init-db.js")`, isolatedEnv({ DB_PATH: dbPath, LOG_DIR: tempDir("etl-test-logs-") }));
  assert.equal(init.status, 0, init.stderr);

  const svc = await startService("loader", { DB_PATH: dbPath });
  t.after(svc.stop);
  const url = `${svc.base}/load`;

  for (const body of [{}, { run_id: "", transactions: [] }, { run_id: 5, transactions: [] }]) {
    const r = await request("POST", url, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.data.error.message, /run_id/);
  }

  let r = await request("POST", url, { run_id: "r1", transactions: {} });
  assert.equal(r.status, 400);
  assert.match(r.data.error.message, /transactions must be an array/);

  r = await request("POST", url, { run_id: "r1", transactions: [{ external_id: "raw-not-transformed" }] });
  assert.equal(r.status, 400);
  assert.match(r.data.error.message, /transactions\[0\] is missing dedupe_hash/);

  const tx = { external_id: "A", source: "s", amount_minor: 100, currency: "PHP", transaction_ts: "2026-10-01T00:00:00Z", dedupe_hash: "a".repeat(64) };
  r = await request("POST", url, { run_id: "r1", transactions: [tx] });
  assert.deepEqual(r.data, { inserted: 1, skipped_duplicates: 0 });
  r = await request("POST", url, { run_id: "r2", transactions: [tx] });
  assert.deepEqual(r.data, { inserted: 0, skipped_duplicates: 1 });
});

test("extractor rejects a bad since and maps CSV rows", async (t) => {
  const fs = require("fs");
  const dir = tempDir("etl-test-csv-");
  const csvPath = path.join(dir, "transactions.csv");
  fs.writeFileSync(
    csvPath,
    "id,timestamp,amount,currency\nX-0,2026-09-01T00:00:00Z,1.00,PHP\nX-1,2026-10-01T00:00:00Z,12.50,PHP\n"
  );

  const svc = await startService("extractor", { CSV_PATH: csvPath });
  t.after(svc.stop);

  let r = await request("POST", `${svc.base}/extract`, { since: "yesterday-ish" });
  assert.equal(r.status, 400);
  assert.match(r.data.error.message, /since must be an ISO 8601 timestamp/);

  r = await request("POST", `${svc.base}/extract`, { since: 12345 });
  assert.equal(r.status, 400);

  r = await request("POST", `${svc.base}/extract`, {});
  assert.equal(r.status, 200);
  assert.equal(r.data.rows, 2);

  r = await request("POST", `${svc.base}/extract`, { since: "2026-09-30T00:00:00Z" });
  assert.equal(r.status, 200);
  assert.equal(r.data.rows, 1);
  assert.equal(r.data.transactions[0].external_id, "X-1");
  assert.equal(r.data.transactions[0].amount_minor, 1250);
  assert.match(r.data.run_id, /^[0-9a-f-]{36}$/);

  // Rows appended between runs are picked up on the next request.
  fs.appendFileSync(csvPath, "X-2,2026-10-02T00:00:00Z,3.00,PHP\n");
  r = await request("POST", `${svc.base}/extract`, {});
  assert.equal(r.data.rows, 3);
});

test("extractor answers 500 when the CSV file is missing", async (t) => {
  const svc = await startService("extractor");
  t.after(svc.stop);
  const r = await request("POST", `${svc.base}/extract`, {});
  assert.equal(r.status, 500);
  assert.equal(r.data.error.code, "internal_error");
  assert.match(r.data.error.message, /CSV file not found/);
});
