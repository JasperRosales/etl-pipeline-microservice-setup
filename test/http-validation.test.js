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

test("extractor rejects a bad since and maps source rows", async (t) => {
  const http = require("http");
  const rows = [{ id: "X-1", amount: "12.50", currency: "PHP", timestamp: "2026-10-01T00:00:00Z" }];
  let lastQuery = null;
  const source = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    lastQuery = u.searchParams;
    if (u.searchParams.get("token") !== "test-token") {
      res.writeHead(401).end("{}");
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ transactions: rows }));
  });
  await new Promise((r) => source.listen(0, "127.0.0.1", r));
  t.after(() => new Promise((r) => source.close(r)));

  const svc = await startService("extractor", { SHEETS_ENDPOINT: `http://127.0.0.1:${source.address().port}/transactions` });
  t.after(svc.stop);

  let r = await request("POST", `${svc.base}/extract`, { since: "yesterday-ish" });
  assert.equal(r.status, 400);
  assert.match(r.data.error.message, /since must be an ISO 8601 timestamp/);

  r = await request("POST", `${svc.base}/extract`, { since: 12345 });
  assert.equal(r.status, 400);

  r = await request("POST", `${svc.base}/extract`, { since: "2026-09-30T00:00:00Z" });
  assert.equal(r.status, 200);
  assert.equal(lastQuery.get("since"), "2026-09-30T00:00:00.000Z");
  assert.equal(r.data.rows, 1);
  assert.equal(r.data.transactions[0].amount_minor, 1250);
  assert.match(r.data.run_id, /^[0-9a-f-]{36}$/);
});
