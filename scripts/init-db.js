// Placeholder created for Day 1 (Issue 1).
//
// start-etl.ps1 runs `node .\scripts\init-db.js` before launching any service
// and aborts when it exits non-zero, so this file must exist and succeed.
//
// Day 3 (Issue 3) replaces this placeholder with the real work:
//   - open data/pos.db with PRAGMA journal_mode=WAL
//   - CREATE TABLE IF NOT EXISTS transactions / etl_runs / notifications
//   - indexes on transactions.transaction_ts and etl_runs.started_at
//   - exit non-zero with a readable message on failure

"use strict";

const fs = require("fs");
const path = require("path");

const dataDir = path.join(__dirname, "..", "data");
fs.mkdirSync(dataDir, { recursive: true });

console.log(`[init-db] data directory ready: ${dataDir}`);
console.log("[init-db] TODO (Issue 3, Day 3): create the SQLite database and tables here.");
