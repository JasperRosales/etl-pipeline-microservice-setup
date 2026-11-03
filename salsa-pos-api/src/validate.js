// Validates the body of POST /transactions (unit-tested in ../test/validate.test.js).
//
// Returns { ok: true, value } with the normalized sale fields, or
// { ok: false, message } with the first problem found. The rules match what
// the ETL transformer accepts downstream, so a sale added here never ends up
// as a rejected row in the pipeline:
//   amount       positive number, at most 2 decimals, <= 1,000,000
//   currency     3-letter ISO code (default PHP)
//   timestamp    parseable date, not in the future (default now)
//   items        optional array of { sku?, name, qty (positive int), unit_price (> 0) }
//   store_id, cashier_id, payment_method   optional non-empty strings, <= 64 chars

"use strict";

const PAYMENT_METHODS = ["cash", "card", "gcash", "maya"];
const MAX_AMOUNT = 1_000_000;
const CLOCK_SKEW_MS = 5 * 60 * 1000;

function fail(message) {
  return { ok: false, message };
}

function money(value) {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : typeof value === "number" ? value : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  if (Math.abs(Math.round(n * 100) - n * 100) > 1e-6) return null; // > 2 decimals
  return n;
}

function shortString(value, field) {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== "string" || value.trim() === "" || value.length > 64) {
    return fail(`${field} must be a non-empty string of at most 64 characters`);
  }
  return { ok: true, value: value.trim() };
}

function validateSale(body, now = new Date()) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return fail("body must be a JSON object");

  const amount = money(body.amount);
  if (amount === null) return fail("amount must be a positive number with at most 2 decimals");
  if (amount > MAX_AMOUNT) return fail(`amount must not exceed ${MAX_AMOUNT}`);

  let currency = "PHP";
  if (body.currency !== undefined) {
    if (typeof body.currency !== "string" || !/^[A-Za-z]{3}$/.test(body.currency.trim())) {
      return fail("currency must be a 3-letter ISO code such as PHP");
    }
    currency = body.currency.trim().toUpperCase();
  }

  let timestamp = now;
  if (body.timestamp !== undefined) {
    timestamp = typeof body.timestamp === "string" || typeof body.timestamp === "number" ? new Date(body.timestamp) : new Date(NaN);
    if (Number.isNaN(timestamp.getTime())) return fail("timestamp must be an ISO 8601 timestamp");
    if (timestamp.getTime() > now.getTime() + CLOCK_SKEW_MS) return fail("timestamp must not be in the future");
  }

  const fields = {};
  for (const field of ["store_id", "cashier_id", "payment_method"]) {
    const r = shortString(body[field], field);
    if (!r.ok) return r;
    fields[field] = r.value;
  }
  if (fields.payment_method !== undefined) {
    fields.payment_method = fields.payment_method.toLowerCase();
    if (!PAYMENT_METHODS.includes(fields.payment_method)) {
      return fail(`payment_method must be one of ${PAYMENT_METHODS.join(", ")}`);
    }
  }

  let items = [];
  if (body.items !== undefined) {
    if (!Array.isArray(body.items)) return fail("items must be an array");
    if (body.items.length > 100) return fail("items must have at most 100 entries");
    for (const [i, item] of body.items.entries()) {
      if (!item || typeof item !== "object") return fail(`items[${i}] must be an object`);
      if (typeof item.name !== "string" || item.name.trim() === "") return fail(`items[${i}].name is required`);
      if (!Number.isInteger(item.qty) || item.qty <= 0) return fail(`items[${i}].qty must be a positive integer`);
      const unit = money(item.unit_price);
      if (unit === null) return fail(`items[${i}].unit_price must be a positive number with at most 2 decimals`);
      if (item.sku !== undefined && typeof item.sku !== "string") return fail(`items[${i}].sku must be a string`);
      items.push({ ...(item.sku ? { sku: item.sku } : {}), name: item.name.trim(), qty: item.qty, unit_price: unit.toFixed(2) });
    }
  }

  return { ok: true, value: { amount, currency, timestamp, items, ...fields } };
}

module.exports = { validateSale, PAYMENT_METHODS, MAX_AMOUNT };
