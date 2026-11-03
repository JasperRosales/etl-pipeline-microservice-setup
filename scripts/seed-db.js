// Seeds the ETL database with correctly typed transactions (no services needed).
//
//   npm run db:seed                 # load salsa-pos-api/data/seed.json
//   npm run db:seed -- --reset      # empty transactions, etl_runs and notifications first
//   npm run db:seed -- --from-api   # fetch rows from SHEETS_ENDPOINT instead of the file
//
// Every row goes through the same code as a real pipeline run:
//   extractor mapping (services/extractor/normalize.js)
//   -> transformer validation + dedupe hash (services/transformer/validate.js)
//   -> loader validation + INSERT OR IGNORE (services/loader/store.js)
// so seeded rows have exactly the pipeline's types: external_id TEXT,
// source "salsa-pos-api", amount_minor INTEGER centavos, currency 3-letter
// code, transaction_ts ISO 8601 UTC, payload_json the original POS row.
// Rows the transformer rejects are listed with their reason and not loaded.
// Rerunning is safe: duplicates are skipped by dedupe_hash.

"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const config = require("../services/shared/config");
const { toTransaction } = require("../services/extractor/normalize");
const { transformBatch } = require("../services/transformer/validate");
const { loadRequestProblem, loadBatch } = require("../services/loader/store");

const SEED_FILE = path.join(__dirname, "..", "salsa-pos-api", "data", "seed.json");

async function readRows(fromApi) {
  if (!fromApi) return JSON.parse(fs.readFileSync(SEED_FILE, "utf8"));
  const url = new URL(config.sheets.endpoint);
  url.searchParams.set("token", config.sheets.apiToken);
  const res = await fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(70_000) });
  if (!res.ok) throw new Error(`${config.sheets.endpoint} responded ${res.status}`);
  const data = await res.json();
  const rows = Array.isArray(data) ? data : data && data.transactions;
  if (!Array.isArray(rows)) throw new Error("source response was neither an array nor { transactions: [...] }");
  return rows;
}

async function main() {
  const args = new Set(process.argv.slice(2));
  for (const a of args) {
    if (!["--reset", "--from-api"].includes(a)) throw new Error(`unknown option ${a} (use --reset and/or --from-api)`);
  }

  if (!fs.existsSync(config.dbPath)) {
    throw new Error(`database ${config.dbPath} does not exist - run "npm run db:init" first`);
  }

  const rows = await readRows(args.has("--from-api"));
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
    const summary = `run ${runId}: extracted ${extracted.length}, loaded ${loaded.inserted}, duplicates ${loaded.skipped_duplicates}, rejected ${transformed.rejected.length} (seed)`;
    db.prepare("INSERT INTO notifications (channel, subject, body, sent_at) VALUES ('log', 'ETL seed completed', ?, ?)").run(summary, new Date().toISOString());

    const total = db.prepare("SELECT COUNT(*) AS n FROM transactions").get().n;
    console.log(`Seeded ${config.dbPath}${args.has("--reset") ? " (reset first)" : ""}`);
    console.log(`  source rows:  ${rows.length} (${args.has("--from-api") ? config.sheets.endpoint : path.relative(process.cwd(), SEED_FILE)})`);
    console.log(`  inserted:     ${loaded.inserted}`);
    console.log(`  duplicates:   ${loaded.skipped_duplicates}`);
    console.log(`  rejected:     ${transformed.rejected.length}`);
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
