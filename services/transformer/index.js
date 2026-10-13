// Transformer service (port 3002) - POST /transform, GET /health.
// Contract: docs/http-contract.md sections 4 and 5.
//
// Pure logic, no I/O: validates each raw transaction, computes dedupe_hash
// (SHA-256 over source|external_id|amount_minor|currency|transaction_ts), and
// splits the batch into accepted (raw + dedupe_hash, nothing else changed) and
// rejected records with a reason code.
//
// Invariants: rows_in === rows_out + rejected.length, input is never mutated,
// in-batch duplicates are rejected here; duplicates against the database are
// the loader's job.

"use strict";

const crypto = require("crypto");
const { start } = require("../shared/app");

function dedupeHash(tx) {
  return crypto
    .createHash("sha256")
    .update([tx.source, tx.external_id, tx.amount_minor, tx.currency, tx.transaction_ts].join("|"))
    .digest("hex");
}

function rejectionReason(tx) {
  // A non-object entry has no external_id, so it fails the first check.
  if (!tx || typeof tx !== "object" || typeof tx.external_id !== "string" || tx.external_id === "") {
    return "missing_external_id";
  }
  if (!Number.isInteger(tx.amount_minor)) return "invalid_amount";
  if (typeof tx.currency !== "string" || !/^[A-Z]{3}$/.test(tx.currency)) return "invalid_currency";
  if (typeof tx.transaction_ts !== "string" || Number.isNaN(Date.parse(tx.transaction_ts))) {
    return "invalid_timestamp";
  }
  return null;
}

start("transformer", (app, ctx) => {
  const { sendError } = ctx;

  app.post("/transform", (req, res) => {
    const body = req.body || {};
    if (!Array.isArray(body.transactions)) {
      return sendError(res, 400, "invalid_request", "transactions must be an array");
    }

    const rejected = [];
    const transactions = [];
    const seen = new Set();

    body.transactions.forEach((tx, index) => {
      const reason = rejectionReason(tx);
      if (reason) {
        rejected.push({ index, external_id: tx && typeof tx.external_id === "string" ? tx.external_id : null, reason });
        return;
      }
      const hash = dedupeHash(tx);
      if (seen.has(hash)) {
        rejected.push({ index, external_id: tx.external_id, reason: "duplicate_in_batch" });
        return;
      }
      seen.add(hash);
      transactions.push({ ...tx, dedupe_hash: hash });
    });

    res.json({
      rows_in: body.transactions.length,
      rows_out: transactions.length,
      transactions,
      rejected,
    });
  });
});
