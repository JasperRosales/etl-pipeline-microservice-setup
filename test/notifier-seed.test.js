// Notifier request validation (HTTP) and the seed script (scripts/seed-db.js).

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { spawnSync } = require("child_process");
const Database = require("better-sqlite3");
const { projectRoot, tempDir, isolatedEnv, runNode, request, startService } = require("./helpers");

function freshDb() {
  const dbPath = path.join(tempDir("etl-test-db-"), "pos.db");
  const env = isolatedEnv({ DB_PATH: dbPath, LOG_DIR: tempDir("etl-test-logs-") });
  const init = runNode(`require("./scripts/init-db.js")`, env);
  assert.equal(init.status, 0, init.stderr);
  return { dbPath, env };
}

test("notifier validates channel, subject and body", async (t) => {
  const { dbPath } = freshDb();
  const svc = await startService("notifier", { DB_PATH: dbPath });
  t.after(svc.stop);
  const url = `${svc.base}/notify`;

  const bad = [
    [{ channel: "sms", subject: "s", body: "b" }, /channel must be one of: log, email, webhook/],
    [{ subject: "s", body: "b" }, /channel/],
    [{ channel: "log", subject: "  ", body: "b" }, /subject/],
    [{ channel: "log", subject: 5, body: "b" }, /subject/],
    [{ channel: "log", subject: "s" }, /body must be a string/],
    [{ channel: "log", subject: "s", body: 1 }, /body must be a string/],
    [{ channel: "log", subject: "x".repeat(201), body: "b" }, /subject must be at most 200/],
    [{ channel: "log", subject: "s", body: "x".repeat(10_001) }, /body must be at most 10000/],
    [[{ channel: "log", subject: "s", body: "b" }], /request body must be a JSON object/],
  ];
  for (const [body, pattern] of bad) {
    const r = await request("POST", url, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.data.error.message, pattern);
  }

  let r = await request("POST", url, { channel: "log", subject: "ETL run completed", body: "ok" });
  assert.equal(r.status, 200);
  assert.equal(r.data.delivered, true);
  r = await request("POST", url, { channel: "email", subject: "x", body: "" });
  assert.equal(r.data.delivered, false); // stub channel: recorded, not delivered

  const db = new Database(dbPath, { readonly: true });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notifications").get().n, 2);
  db.close();
});

function seed(env, ...args) {
  return spawnSync(process.execPath, [path.join(projectRoot, "scripts", "seed-db.js"), ...args], { cwd: projectRoot, env, encoding: "utf8" });
}

test("seed script loads correctly typed rows, is idempotent, and --reset empties first", () => {
  const { dbPath, env } = freshDb();
  const seedRows = require("../salsa-pos-api/data/seed.json");

  let r = seed(env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`inserted:\\s+${seedRows.length}`));
  assert.match(r.stdout, /rejected:\s+0/);

  const db = new Database(dbPath, { readonly: true });
  const types = db
    .prepare(`SELECT DISTINCT typeof(external_id) AS id, source, typeof(amount_minor) AS amount, currency,
                     typeof(transaction_ts) AS ts, typeof(dedupe_hash) AS hash, json_valid(payload_json) AS payload_ok
              FROM transactions`)
    .all();
  assert.deepEqual(types, [{ id: "text", source: "salsa-pos-api", amount: "integer", currency: "PHP", ts: "text", hash: "text", payload_ok: 1 }]);
  const bad = db.prepare(`SELECT COUNT(*) AS n FROM transactions
                          WHERE transaction_ts NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9].[0-9][0-9][0-9]Z'
                             OR length(dedupe_hash) != 64`).get().n;
  assert.equal(bad, 0);
  const first = db.prepare("SELECT external_id, amount_minor, json_extract(payload_json, '$.store_id') AS store FROM transactions WHERE external_id = 'SALSA-TX-00001'").get();
  assert.deepEqual(first, { external_id: "SALSA-TX-00001", amount_minor: 47700, store: "STORE-LIPA" });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM etl_runs WHERE run_id LIKE 'seed-%'").get().n, 1);
  db.close();

  r = seed(env);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /inserted:\s+0/);
  assert.match(r.stdout, new RegExp(`duplicates:\\s+${seedRows.length}`));

  r = seed(env, "--reset");
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`inserted:\\s+${seedRows.length}`));
  const db2 = new Database(dbPath, { readonly: true });
  assert.equal(db2.prepare("SELECT COUNT(*) AS n FROM etl_runs").get().n, 1);
  assert.equal(db2.prepare("SELECT COUNT(*) AS n FROM notifications").get().n, 1);
  db2.close();
});

test("seed script rejects unknown options and a missing database", () => {
  const { env } = freshDb();
  let r = seed(env, "--nope");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /unknown option --nope/);

  r = seed({ ...env, DB_PATH: path.join(tempDir("etl-test-empty-"), "missing.db") });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /run "npm run db:init" first/);
});
