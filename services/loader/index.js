// Loader service (port 3003) - POST /load, GET /health.
// Contract: docs/http-contract.md section 5.
//
// Writes transformed transactions with INSERT OR IGNORE keyed on dedupe_hash
// (README section 9 duplicate protection) inside one transaction, then upserts
// the etl_runs row for the run_id. INSERT OR IGNORE is idempotent, which is
// what makes retried POST /load calls (Issue 7) safe.

"use strict";

const Database = require("better-sqlite3");
const { start, sendError } = require("../shared/app");

const INSERT_TX = `
INSERT OR IGNORE INTO transactions
  (external_id, source, amount_minor, currency, transaction_ts, payload_json, dedupe_hash)
VALUES
  (@external_id, @source, @amount_minor, @currency, @transaction_ts, @payload_json, @dedupe_hash)
`;

const UPSERT_RUN = `
INSERT INTO etl_runs (run_id, started_at, finished_at, status, rows_in, rows_out)
VALUES (@run_id, @started_at, @finished_at, 'completed', @rows_in, @rows_out)
ON CONFLICT(run_id) DO UPDATE SET
  finished_at = excluded.finished_at,
  status      = excluded.status,
  rows_in     = excluded.rows_in,
  rows_out    = excluded.rows_out
`;

start("loader", (app, ctx) => {
  const { config, log } = ctx;

  app.post("/load", (req, res) => {
    const body = req.body || {};
    const runId = body.run_id;
    if (typeof runId !== "string" || runId === "") {
      return sendError(res, 400, "invalid_request", "run_id must be a non-empty string");
    }
    if (!Array.isArray(body.transactions)) {
      return sendError(res, 400, "invalid_request", "transactions must be an array");
    }
    for (const [i, tx] of body.transactions.entries()) {
      if (!tx || typeof tx.dedupe_hash !== "string") {
        return sendError(res, 400, "invalid_request", `transactions[${i}] is missing dedupe_hash - send transformed transactions`);
      }
    }

    let db;
    try {
      db = new Database(config.dbPath);
    } catch (err) {
      return sendError(res, 503, "not_ready", `database unavailable: ${err.message}`);
    }

    try {
      const insert = db.prepare(INSERT_TX);
      const rows = body.transactions.map((tx) => ({
        external_id: tx.external_id ?? null,
        source: tx.source,
        amount_minor: tx.amount_minor,
        currency: tx.currency,
        transaction_ts: tx.transaction_ts,
        payload_json: JSON.stringify(tx.payload ?? null),
        dedupe_hash: tx.dedupe_hash,
      }));

      let inserted = 0;
      let skipped = 0;
      db.transaction((all) => {
        for (const row of all) {
          if (insert.run(row).changes > 0) inserted++;
          else skipped++;
        }
      })(rows);

      const now = new Date().toISOString();
      db.prepare(UPSERT_RUN).run({
        run_id: runId,
        started_at: now,
        finished_at: now,
        rows_in: rows.length,
        rows_out: inserted,
      });

      log.info("load", { run_id: runId, inserted, skipped_duplicates: skipped });
      res.json({ inserted, skipped_duplicates: skipped });
    } catch (err) {
      log.error("load_failed", { run_id: runId, message: err.message });
      sendError(res, 500, "internal_error", `database write failed: ${err.message}`);
    } finally {
      db.close();
    }
  });
});
