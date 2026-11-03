// Pure validation helpers for the transformer (unit-tested in test/transformer.test.js).
//
// rejectionReason(tx) -> null when valid, otherwise one of the contract's
// reason codes: missing_external_id, invalid_amount, invalid_currency,
// invalid_timestamp. dedupeHash(tx) -> SHA-256 over
// source|external_id|amount_minor|currency|transaction_ts.

"use strict";

const crypto = require("crypto");

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

// Splits a batch into accepted (raw + dedupe_hash) and rejected records.
function transformBatch(input) {
  const rejected = [];
  const transactions = [];
  const seen = new Set();

  input.forEach((tx, index) => {
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

  return { rows_in: input.length, rows_out: transactions.length, transactions, rejected };
}

module.exports = { dedupeHash, rejectionReason, transformBatch };
