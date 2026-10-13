// Creates the local SQLite database and schema (Issue 3, Day 3).
//
// Run by start-etl.ps1 before any service starts, or directly:
//   npm run db:init
//
// Design notes:
// - Idempotent: every statement uses IF NOT EXISTS, so reruns change nothing.
// - WAL mode: services will read and write concurrently (loader writes while
//   reporter reads).
// - dedupe_hash is the duplicate-transaction guard (README section 9): the
//   transformer computes it (e.g. sha256 of source + external_id or the
//   canonical fields) and the loader uses INSERT OR IGNORE keyed on it (Issue 7).
// - Amounts are stored as INTEGER minor units (cents) to avoid float errors.

"use strict";

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const config = require("../services/shared/config");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS transactions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  external_id    TEXT,
  source         TEXT NOT NULL,
  amount_minor   INTEGER NOT NULL,
  currency       TEXT NOT NULL DEFAULT 'USD',
  transaction_ts TEXT NOT NULL,
  payload_json   TEXT,
  dedupe_hash    TEXT NOT NULL UNIQUE,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_transactions_transaction_ts
  ON transactions (transaction_ts);

CREATE TABLE IF NOT EXISTS etl_runs (
  run_id      TEXT PRIMARY KEY,
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  status      TEXT NOT NULL DEFAULT 'running',
  rows_in     INTEGER NOT NULL DEFAULT 0,
  rows_out    INTEGER NOT NULL DEFAULT 0,
  error       TEXT
);

CREATE INDEX IF NOT EXISTS idx_etl_runs_started_at
  ON etl_runs (started_at);

CREATE TABLE IF NOT EXISTS notifications (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  channel TEXT NOT NULL,
  subject TEXT NOT NULL,
  body    TEXT,
  sent_at TEXT
);
`;

function main() {
  const dbPath = config.dbPath;
  const existed = fs.existsSync(dbPath);

  // better-sqlite3 does not create missing parent directories.
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const db = new Database(dbPath);
  try {
    db.pragma("journal_mode = WAL");
    db.exec(SCHEMA);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((row) => row.name);
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%' ORDER BY name")
      .all()
      .map((row) => row.name);

    console.log(`[init-db] database ${existed ? "opened" : "created"}: ${dbPath}`);
    console.log(`[init-db] journal_mode: ${db.pragma("journal_mode", { simple: true })}`);
    console.log(`[init-db] tables: ${tables.join(", ")}`);
    console.log(`[init-db] indexes: ${indexes.join(", ")}`);
    console.log("[init-db] schema ready (idempotent - safe to rerun)");
  } finally {
    db.close();
  }
}

try {
  main();
} catch (err) {
  console.error(`[init-db] FAILED: ${err.message}`);
  process.exit(1);
}
