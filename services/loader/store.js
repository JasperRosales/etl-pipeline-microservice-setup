// Validation and SQLite writes for transformed transactions. Used by the
// loader service (POST /load) and by scripts/seed-db.js, so seeded rows go
// through exactly the same checks and SQL as pipeline rows.
// Unit-tested in test/loader.test.js.

"use strict";

const { dedupeHash, rejectionReason } = require("../transformer/validate");

// UUIDs from the extractor, plus the seed-/smoke- prefixed ids the scripts use.
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const TX_FIELDS = new Set(["external_id", "source", "amount_minor", "currency", "transaction_ts", "payload", "dedupe_hash"]);

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
// first problem. Every column the loader writes is checked here, with the
// transformer's own rules, so a bad row is a 400, never a SQLite constraint
// error (500) or a wrongly typed row. The batch is all-or-nothing: the loader
// only receives rows the transformer already accepted, so any failure here
// means a broken client, not bad source data.
//   - run_id: 1-100 chars of letters, digits, "-" or "_"
//   - only the documented fields: external_id, source, amount_minor, currency,
//     transaction_ts, payload, dedupe_hash
//   - dedupe_hash must equal the hash recomputed from the row (catches rows
//     edited after the transformer, or hashes made up by the caller)
//   - no dedupe_hash twice in one batch
function loadRequestProblem(body, now = Date.now()) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "body must be a JSON object";
  if (typeof body.run_id !== "string" || body.run_id.trim() === "") return "run_id must be a non-empty string";
  if (!RUN_ID.test(body.run_id)) return "run_id must be 1-100 letters, digits, '-' or '_'";
  if (!Array.isArray(body.transactions)) return "transactions must be an array";
  const extra = Object.keys(body).filter((k) => k !== "run_id" && k !== "transactions");
  if (extra.length) return `unknown field(s): ${extra.join(", ")}`;

  const seen = new Set();
  for (const [i, tx] of body.transactions.entries()) {
    if (!tx || typeof tx !== "object" || typeof tx.dedupe_hash !== "string") {
      return `transactions[${i}] is missing dedupe_hash - send transformed transactions`;
    }
    if (!/^[0-9a-f]{64}$/.test(tx.dedupe_hash)) return `transactions[${i}].dedupe_hash must be a 64-character hex SHA-256`;
    const unknown = Object.keys(tx).filter((k) => !TX_FIELDS.has(k));
    if (unknown.length) return `transactions[${i}] has unknown field(s): ${unknown.join(", ")}`;
    const reason = rejectionReason(tx, now);
    if (reason) return `transactions[${i}] failed validation: ${reason}`;
    if (tx.dedupe_hash !== dedupeHash(tx)) {
      return `transactions[${i}].dedupe_hash does not match its fields - send rows exactly as the transformer returned them`;
    }
    if (seen.has(tx.dedupe_hash)) return `transactions[${i}] repeats the dedupe_hash of an earlier row in this batch`;
    seen.add(tx.dedupe_hash);
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
