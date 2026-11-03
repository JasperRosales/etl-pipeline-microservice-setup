// Unit tests for the transformer validators (services/transformer/validate.js).

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { rejectionReason, dedupeHash, transformBatch } = require("../services/transformer/validate");

const valid = () => ({
  external_id: "TX-1",
  source: "salsa-pos-api",
  amount_minor: 1250,
  currency: "PHP",
  transaction_ts: "2026-10-01T02:54:09.000Z",
  payload: { id: "TX-1" },
});

test("accepts a well-formed transaction", () => {
  assert.equal(rejectionReason(valid()), null);
});

test("accepts zero and negative integer amounts (refunds are integers too)", () => {
  assert.equal(rejectionReason({ ...valid(), amount_minor: 0 }), null);
  assert.equal(rejectionReason({ ...valid(), amount_minor: -500 }), null);
});

test("missing_external_id: absent, empty, non-string, or non-object entries", () => {
  for (const tx of [null, undefined, 42, "TX-1", [], { ...valid(), external_id: undefined }, { ...valid(), external_id: "" }, { ...valid(), external_id: 7 }]) {
    assert.equal(rejectionReason(tx), "missing_external_id", JSON.stringify(tx));
  }
});

test("invalid_amount: NaN, floats, strings, missing", () => {
  for (const amount_minor of [NaN, 12.5, "1250", undefined, null, Infinity]) {
    assert.equal(rejectionReason({ ...valid(), amount_minor }), "invalid_amount", String(amount_minor));
  }
});

test("invalid_currency: must be exactly 3 uppercase letters", () => {
  for (const currency of ["php", "PH", "PESO", "", "P1P", 608, undefined]) {
    assert.equal(rejectionReason({ ...valid(), currency }), "invalid_currency", String(currency));
  }
});

test("invalid_timestamp: missing, unparseable, or not a string", () => {
  for (const transaction_ts of [undefined, "", "not a date", "2026-13-45T99:00:00Z", 1730000000000]) {
    assert.equal(rejectionReason({ ...valid(), transaction_ts }), "invalid_timestamp", String(transaction_ts));
  }
});

test("checks run in contract order: external_id before amount before currency before timestamp", () => {
  assert.equal(rejectionReason({ amount_minor: "x", currency: "x" }), "missing_external_id");
  assert.equal(rejectionReason({ ...valid(), amount_minor: "x", currency: "x" }), "invalid_amount");
  assert.equal(rejectionReason({ ...valid(), currency: "x", transaction_ts: "x" }), "invalid_currency");
});

test("dedupeHash is deterministic, hex SHA-256, and ignores payload", () => {
  const a = dedupeHash(valid());
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(dedupeHash({ ...valid(), payload: { something: "else" } }), a);
  assert.notEqual(dedupeHash({ ...valid(), amount_minor: 1251 }), a);
  assert.notEqual(dedupeHash({ ...valid(), external_id: "TX-2" }), a);
});

test("transformBatch splits accepted and rejected, keeping rows_in = rows_out + rejected", () => {
  const input = [valid(), { ...valid(), external_id: "TX-2", currency: "usd" }, { ...valid(), external_id: "TX-3", amount_minor: 1.5 }, null];
  const out = transformBatch(input);
  assert.equal(out.rows_in, 4);
  assert.equal(out.rows_out, 1);
  assert.equal(out.rows_in, out.rows_out + out.rejected.length);
  assert.deepEqual(
    out.rejected.map((r) => [r.index, r.external_id, r.reason]),
    [
      [1, "TX-2", "invalid_currency"],
      [2, "TX-3", "invalid_amount"],
      [3, null, "missing_external_id"],
    ]
  );
  assert.equal(out.transactions[0].dedupe_hash, dedupeHash(valid()));
});

test("transformBatch rejects in-batch duplicates but keeps the first", () => {
  const out = transformBatch([valid(), valid(), { ...valid(), payload: "different payload, same hash" }]);
  assert.equal(out.rows_out, 1);
  assert.deepEqual(out.rejected.map((r) => [r.index, r.reason]), [
    [1, "duplicate_in_batch"],
    [2, "duplicate_in_batch"],
  ]);
});

test("transformBatch never mutates its input", () => {
  const input = [valid(), { ...valid(), currency: "bad" }];
  const snapshot = structuredClone(input);
  const out = transformBatch(input);
  assert.deepEqual(input, snapshot);
  assert.notEqual(out.transactions[0], input[0]);
  assert.equal("dedupe_hash" in input[0], false);
});

test("transformBatch handles an empty batch", () => {
  assert.deepEqual(transformBatch([]), { rows_in: 0, rows_out: 0, transactions: [], rejected: [] });
});
