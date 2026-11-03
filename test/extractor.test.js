// Unit tests for the extractor's row normalizer (services/extractor/normalize.js),
// plus a check that every seeded POS row survives extractor -> transformer.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { toTransaction, toIso } = require("../services/extractor/normalize");
const { rejectionReason, transformBatch } = require("../services/transformer/validate");
const seed = require("../salsa-pos-api/data/seed.json");

test("maps a POS row to the raw Transaction shape", () => {
  const row = { id: "SALSA-TX-00001", amount: "477.00", currency: "php", timestamp: "2026-10-01T02:54:09Z", store_id: "STORE-LIPA" };
  assert.deepEqual(toTransaction(row), {
    external_id: "SALSA-TX-00001",
    source: "salsa-pos-api",
    amount_minor: 47700,
    currency: "PHP",
    transaction_ts: "2026-10-01T02:54:09.000Z",
    payload: row,
  });
});

test("converts amounts to integer minor units without float drift", () => {
  assert.equal(toTransaction({ id: 1, amount: "0.29" }).amount_minor, 29);
  assert.equal(toTransaction({ id: 1, amount: 19.99 }).amount_minor, 1999);
  assert.equal(toTransaction({ id: 1, amount: "1.005" }).amount_minor, 100); // rounds, still an integer
});

test("stringifies numeric ids and defaults currency to USD", () => {
  const tx = toTransaction({ id: 42, amount: "1" });
  assert.equal(tx.external_id, "42");
  assert.equal(tx.currency, "USD");
});

test("passes bad rows through so the transformer can reject them", () => {
  assert.equal(rejectionReason(toTransaction({ amount: "1", timestamp: "2026-01-01" })), "missing_external_id");
  assert.equal(rejectionReason(toTransaction({ id: "A", amount: "abc", timestamp: "2026-01-01" })), "invalid_amount");
  assert.equal(rejectionReason(toTransaction({ id: "A", amount: { v: 1 }, timestamp: "2026-01-01" })), "invalid_amount");
  assert.equal(rejectionReason(toTransaction({ id: "A", amount: "1", currency: "PESO", timestamp: "2026-01-01" })), "invalid_currency");
  assert.equal(rejectionReason(toTransaction({ id: "A", amount: "1", timestamp: "garbage" })), "invalid_timestamp");
});

test("toIso only accepts strings and numbers that parse", () => {
  assert.equal(toIso("2026-10-01T00:00:00Z"), "2026-10-01T00:00:00.000Z");
  assert.equal(toIso(0), "1970-01-01T00:00:00.000Z");
  assert.equal(toIso("nope"), undefined);
  assert.equal(toIso(null), undefined);
  assert.equal(toIso({}), undefined);
});

test("every seeded salsa-pos-api row passes the transformer with no rejections", () => {
  const out = transformBatch(seed.map(toTransaction));
  assert.equal(out.rejected.length, 0, JSON.stringify(out.rejected.slice(0, 3)));
  assert.equal(out.rows_out, seed.length);
});
