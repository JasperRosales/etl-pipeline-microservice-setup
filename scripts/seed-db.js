// Seeds the ETL database with correctly typed transactions (no services needed).
//
//   npm run db:seed                 # load every row of CSV_PATH (default data/transactions.csv)
//   npm run db:reset                # empty transactions, etl_runs and notifications first
//
// Every row goes through the same code as a real pipeline run:
//   extractor CSV reading + mapping (services/extractor/csv.js, normalize.js)
//   -> transformer validation + dedupe hash (services/transformer/validate.js)
//   -> loader validation + INSERT OR IGNORE (services/loader/store.js)
// so seeded rows have exactly the pipeline's types: external_id TEXT,
// source "csv", amount_minor INTEGER centavos, currency 3-letter
// code, transaction_ts ISO 8601 UTC, payload_json the original POS row.
// Rows the extractor or transformer rejects are listed with their reason and not loaded.
// Rerunning is safe: duplicates are skipped by dedupe_hash.

"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const config = require("../services/shared/config");
const { readCsvRows } = require("../services/extractor/csv");
const { toTransaction } = require("../services/extractor/normalize");
const { transformBatch } = require("../services/transformer/validate");
const { loadRequestProblem, loadBatch } = require("../services/loader/store");

async function main() {
  const args = new Set(process.argv.slice(2));
  for (const a of args) {
    if (!["--reset"].includes(a)) throw new Error(`unknown option ${a} (only --reset is supported)`);
  }

  if (!fs.existsSync(config.dbPath)) {
    throw new Error(`database ${config.dbPath} does not exist - run "npm run db:init" first`);
  }

  const { rows, rejected: csvRejected } = readCsvRows(config.csvPath);
  const extracted = rows.map(toTransaction);
  const transformed = transformBatch(extracted);
  const runId = `seed-${crypto.randomUUID()}`;

  const problem = loadRequestProblem({ run_id: runId, transactions: transformed.transactions });
  if (problem) throw new Error(`loader validation failed: ${problem}`); // would be a bug in the shared validators

  const db = new Database(config.dbPath);
  try {
    if (args.has("--reset")) {
      db.exec("DELETE FROM transactions; DELETE FROM etl_runs; DELETE FROM notifications;");
    }
    const loaded = loadBatch(db, runId, transformed.transactions);
    const summary = `run ${runId}: extracted ${extracted.length}, loaded ${loaded.inserted}, duplicates ${loaded.skipped_duplicates}, rejected ${csvRejected.length + transformed.rejected.length} (seed)`;
    db.prepare("INSERT INTO notifications (channel, subject, body, sent_at) VALUES ('log', 'ETL seed completed', ?, ?)").run(summary, new Date().toISOString());

    const total = db.prepare("SELECT COUNT(*) AS n FROM transactions").get().n;
    console.log(`Seeded ${config.dbPath}${args.has("--reset") ? " (reset first)" : ""}`);
    console.log(`  source rows:  ${rows.length} (${path.relative(process.cwd(), config.csvPath)})`);
    console.log(`  inserted:     ${loaded.inserted}`);
    console.log(`  duplicates:   ${loaded.skipped_duplicates}`);
    console.log(`  rejected:     ${csvRejected.length + transformed.rejected.length}`);
    for (const r of csvRejected) console.log(`    - CSV row ${r.row} ${r.external_id ?? "(no id)"}: ${r.reason} (${r.detail})`);
    for (const r of transformed.rejected) console.log(`    - row ${r.index} ${r.external_id ?? "(no id)"}: ${r.reason}`);
    console.log(`  rows in DB:   ${total}`);
  } finally {
    db.close();
  }
}

main().catch((err) => {
  console.error(`Seed failed: ${err.message}`);
  process.exit(1);
});
