// Maps a CSV row { id, amount, currency, timestamp, ... } to the raw
// Transaction shape. Unit-tested in test/extractor.test.js. Bad rows are passed
// through with undefined/NaN fields so the transformer can reject them.

"use strict";

// Recorded on every row and part of the dedupe hash. Changing it makes
// already-loaded rows look new, so reseed with `npm run db:reset`.
const SOURCE = "csv";

function toIso(value) {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function toTransaction(row) {
  const cents = typeof row.amount === "string" || typeof row.amount === "number" ? Math.round(Number(row.amount) * 100) : NaN;
  return {
    external_id: row.id === undefined || row.id === null ? undefined : String(row.id),
    source: SOURCE,
    amount_minor: cents,
    currency: typeof row.currency === "string" && row.currency ? row.currency.toUpperCase() : "USD",
    transaction_ts: toIso(row.timestamp),
    payload: row,
  };
}

module.exports = { SOURCE, toIso, toTransaction };
