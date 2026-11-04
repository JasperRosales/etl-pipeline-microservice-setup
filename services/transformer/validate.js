// Pure validation helpers for the transformer (unit-tested in test/transformer.test.js).
//
// rejectionReason(tx, now) -> null when valid, otherwise the first failing
// reason code, checked in this order:
//
//   missing_external_id  absent, empty, or not a string (or tx is not an object)
//   invalid_external_id  over 100 chars, surrounding whitespace, or control characters
//   invalid_source       not a non-empty string of at most 50 chars
//   invalid_amount       not a safe integer, or |amount| above MAX_AMOUNT_MINOR
//   invalid_currency     not exactly 3 uppercase letters
//   invalid_timestamp    not an ISO 8601 UTC string (YYYY-MM-DDTHH:MM:SS[.sss]Z),
//                        not a real calendar instant, or before 2000-01-01
//   future_timestamp     more than FUTURE_TOLERANCE_MS after `now`
//   invalid_payload      payload present but not a plain object
//   invalid_items        payload.items present but not a non-empty array of
//                        { sku or name, qty: positive integer, unit_price: >= 0 with at most 2 decimals }
//   invalid_discount     payload.discount present but not >= 0 with at most 2 decimals
//   amount_mismatch      payload has items and amount_minor != sum(qty * unit_price) - discount
//
// dedupeHash(tx) -> SHA-256 over source|external_id|amount_minor|currency|transaction_ts.

"use strict";

const crypto = require("crypto");

const MAX_EXTERNAL_ID = 100;
const MAX_SOURCE = 50;
const MAX_AMOUNT_MINOR = 100_000_000; // 1,000,000.00 in major units
const MIN_TIMESTAMP_MS = Date.parse("2000-01-01T00:00:00Z");
const FUTURE_TOLERANCE_MS = 60 * 60 * 1000; // allow one hour of clock skew
const ISO_UTC = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d{1,3})?Z$/;
const MONEY = /^\d+(\.\d{1,2})?$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

function dedupeHash(tx) {
  return crypto
    .createHash("sha256")
    .update([tx.source, tx.external_id, tx.amount_minor, tx.currency, tx.transaction_ts].join("|"))
    .digest("hex");
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// "159.00" or 159 -> 15900; anything negative, non-numeric or with more than
// two decimals -> null.
function moneyToMinor(value) {
  const text = typeof value === "number" && Number.isFinite(value) ? String(value) : value;
  if (typeof text !== "string" || !MONEY.test(text.trim())) return null;
  return Math.round(Number(text) * 100);
}

// Returns null for a canonical UTC timestamp, otherwise the reason code.
function timestampProblem(ts, now) {
  const m = typeof ts === "string" && ISO_UTC.exec(ts);
  if (!m) return "invalid_timestamp";
  const ms = Date.parse(ts);
  // The round trip rejects 2026-02-30 and 25:00, which Date may roll over.
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 19) !== m[1]) return "invalid_timestamp";
  if (ms < MIN_TIMESTAMP_MS) return "invalid_timestamp";
  if (ms > now + FUTURE_TOLERANCE_MS) return "future_timestamp";
  return null;
}

// Sum of qty * unit_price in minor units, or null when any item is invalid.
function itemsTotal(items) {
  if (!Array.isArray(items) || items.length === 0) return null;
  let total = 0;
  for (const item of items) {
    if (!isPlainObject(item)) return null;
    const label = item.sku ?? item.name;
    if (typeof label !== "string" || label.trim() === "") return null;
    if (!Number.isInteger(item.qty) || item.qty <= 0) return null;
    const price = moneyToMinor(item.unit_price);
    if (price === null) return null;
    total += item.qty * price;
  }
  return total;
}

function payloadProblem(tx) {
  if (tx.payload === undefined) return null;
  if (!isPlainObject(tx.payload)) return "invalid_payload";
  const { items, discount } = tx.payload;

  let discountMinor = 0;
  if (discount !== undefined) {
    discountMinor = moneyToMinor(discount);
    if (discountMinor === null) return "invalid_discount";
  }
  if (items === undefined) return null;
  const total = itemsTotal(items);
  if (total === null) return "invalid_items";
  if (total - discountMinor !== tx.amount_minor) return "amount_mismatch";
  return null;
}

function rejectionReason(tx, now = Date.now()) {
  // A non-object entry has no external_id, so it fails the first check.
  if (!isPlainObject(tx) || typeof tx.external_id !== "string" || tx.external_id === "") {
    return "missing_external_id";
  }
  const id = tx.external_id;
  if (id.length > MAX_EXTERNAL_ID || id.trim() !== id || CONTROL.test(id)) return "invalid_external_id";
  if (typeof tx.source !== "string" || tx.source.trim() === "" || tx.source.length > MAX_SOURCE) return "invalid_source";
  if (!Number.isSafeInteger(tx.amount_minor) || Math.abs(tx.amount_minor) > MAX_AMOUNT_MINOR) return "invalid_amount";
  if (typeof tx.currency !== "string" || !/^[A-Z]{3}$/.test(tx.currency)) return "invalid_currency";
  const tsProblem = timestampProblem(tx.transaction_ts, now);
  if (tsProblem) return tsProblem;
  return payloadProblem(tx);
}

// Splits a batch into accepted (raw + dedupe_hash) and rejected records.
function transformBatch(input, now = Date.now()) {
  const rejected = [];
  const transactions = [];
  const seen = new Set();

  input.forEach((tx, index) => {
    const reason = rejectionReason(tx, now);
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

module.exports = { MAX_AMOUNT_MINOR, dedupeHash, moneyToMinor, rejectionReason, transformBatch };
