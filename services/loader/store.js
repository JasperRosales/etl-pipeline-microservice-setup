// Validation and SQLite writes for transformed transactions. Used by the
// loader service (POST /load) and by scripts/seed-db.js, so seeded rows go
// through exactly the same checks and SQL as pipeline rows.
// Unit-tested in test/loader.test.js.

"use strict";

const { rejectionReason } = require("../transformer/validate");

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

// Returns null when the load request is valid, otherwise a message naming the
// first problem. Every column the loader writes is type-checked here so a bad
// row is a 400, never a SQLite constraint error (500) or a wrongly typed row.
function loadRequestProblem(body) {
  if (!body || typeof body !== "object") return "body must be a JSON object";
  if (typeof body.run_id !== "string" || body.run_id.trim() === "") return "run_id must be a non-empty string";
  if (!Array.isArray(body.transactions)) return "transactions must be an array";
  for (const [i, tx] of body.transactions.entries()) {
    if (!tx || typeof tx !== "object" || typeof tx.dedupe_hash !== "string") {
      return `transactions[${i}] is missing dedupe_hash - send transformed transactions`;
    }
    if (!/^[0-9a-f]{64}$/.test(tx.dedupe_hash)) return `transactions[${i}].dedupe_hash must be a 64-character hex SHA-256`;
    if (typeof tx.source !== "string" || tx.source.trim() === "") return `transactions[${i}].source must be a non-empty string`;
    const reason = rejectionReason(tx);
    if (reason) return `transactions[${i}] failed validation: ${reason}`;
  }
  return null;
}

// Writes one validated batch inside a single SQLite transaction and upserts
// the etl_runs row. -> { inserted, skipped_duplicates }
function loadBatch(db, runId, transactions, now = new Date()) {
  const insert = db.prepare(INSERT_TX);
  const rows = transactions.map((tx) => ({
    external_id: tx.external_id,
    source: tx.source,
    amount_minor: tx.amount_minor,
    currency: tx.currency,
    transaction_ts: tx.transaction_ts,
    payload_json: JSON.stringify(tx.payload ?? null),
    dedupe_hash: tx.dedupe_hash,
  }));

  let inserted = 0;
  let skipped = 0;
  db.transaction(() => {
    for (const row of rows) {
      if (insert.run(row).changes > 0) inserted++;
      else skipped++;
    }
    const ts = now.toISOString();
    db.prepare(UPSERT_RUN).run({ run_id: runId, started_at: ts, finished_at: ts, rows_in: rows.length, rows_out: inserted });
  })();

  return { inserted, skipped_duplicates: skipped };
}

module.exports = { loadRequestProblem, loadBatch };
