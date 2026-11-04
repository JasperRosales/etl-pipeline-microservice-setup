// Unit tests for the transformer validators (services/transformer/validate.js).

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { rejectionReason, dedupeHash, transformBatch } = require("../services/transformer/validate");

const valid = () => ({
  external_id: "TX-1",
  source: "csv",
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

test("missing_external_id / invalid_external_id: too long, padded, or control characters", () => {
  for (const external_id of ["x".repeat(101), " TX-1", "TX-1 ", "TX\n1", "TX\u00001"]) {
    assert.equal(rejectionReason({ ...valid(), external_id }), "invalid_external_id", JSON.stringify(external_id));
  }
  assert.equal(rejectionReason({ ...valid(), external_id: "x".repeat(100) }), null);
});

test("invalid_source: missing, blank, non-string or over 50 chars", () => {
  for (const source of [undefined, "", "  ", 5, "s".repeat(51)]) {
    assert.equal(rejectionReason({ ...valid(), source }), "invalid_source", String(source));
  }
});

test("invalid_amount: beyond 1,000,000.00 or not a safe integer", () => {
  assert.equal(rejectionReason({ ...valid(), amount_minor: 100_000_000 }), null);
  assert.equal(rejectionReason({ ...valid(), amount_minor: -100_000_000 }), null);
  for (const amount_minor of [100_000_001, -100_000_001, 2 ** 53]) {
    assert.equal(rejectionReason({ ...valid(), amount_minor }), "invalid_amount", String(amount_minor));
  }
});

test("invalid_timestamp: must be canonical ISO 8601 UTC, a real instant, and from 2000 on", () => {
  for (const transaction_ts of ["2026-10-01", "2026-10-01T10:00:00+08:00", "2026-10-01 10:00:00Z", "Oct 1 2026", "2026-02-30T00:00:00Z", "2026-10-01T24:00:00Z", "1999-12-31T23:59:59Z"]) {
    assert.equal(rejectionReason({ ...valid(), transaction_ts }), "invalid_timestamp", transaction_ts);
  }
  for (const transaction_ts of ["2026-10-01T00:00:00Z", "2026-10-01T00:00:00.5Z", "2000-01-01T00:00:00.000Z"]) {
    assert.equal(rejectionReason({ ...valid(), transaction_ts }), null, transaction_ts);
  }
});

test("future_timestamp: more than an hour after now", () => {
  const now = Date.parse("2026-10-01T00:00:00Z");
  assert.equal(rejectionReason({ ...valid(), transaction_ts: "2026-10-01T00:59:59Z" }, now), null);
  assert.equal(rejectionReason({ ...valid(), transaction_ts: "2026-10-01T01:00:01Z" }, now), "future_timestamp");
});

test("invalid_payload: present but not a plain object", () => {
  for (const payload of [null, "text", 5, ["a"]]) {
    assert.equal(rejectionReason({ ...valid(), payload }), "invalid_payload", JSON.stringify(payload));
  }
  const { payload, ...noPayload } = valid();
  assert.equal(rejectionReason(noPayload), null);
});

const sale = (payload, amount_minor = 47700) => ({ ...valid(), amount_minor, payload: { id: "TX-1", ...payload } });
const item = (o = {}) => ({ sku: "SAL-002", name: "Salsa Verde 250g", qty: 3, unit_price: "159.00", ...o });

test("items: valid line items whose total matches amount_minor are accepted", () => {
  assert.equal(rejectionReason(sale({ items: [item()], discount: "0.00" })), null);
  assert.equal(rejectionReason(sale({ items: [item(), item({ sku: undefined, name: "Chips", qty: 1, unit_price: 99 })], discount: "10.50" }, 47700 + 9900 - 1050)), null);
});

test("invalid_items: empty, non-array, or a bad sku/name, qty or unit_price", () => {
  const bad = [
    [],
    "[{...}]",
    [null],
    [item({ sku: undefined, name: undefined })],
    [item({ sku: " " })],
    [item({ qty: 0 })],
    [item({ qty: 1.5 })],
    [item({ qty: "3" })],
    [item({ unit_price: "-1.00" })],
    [item({ unit_price: "1.999" })],
    [item({ unit_price: "abc" })],
  ];
  for (const items of bad) assert.equal(rejectionReason(sale({ items })), "invalid_items", JSON.stringify(items));
});

test("invalid_discount: negative, non-numeric or more than 2 decimals", () => {
  for (const discount of ["-1.00", "abc", "1.005", null]) {
    assert.equal(rejectionReason(sale({ items: [item()], discount })), "invalid_discount", String(discount));
  }
});

test("amount_mismatch: amount_minor must equal sum(qty * unit_price) - discount", () => {
  assert.equal(rejectionReason(sale({ items: [item()] }, 47701)), "amount_mismatch");
  assert.equal(rejectionReason(sale({ items: [item()], discount: "1.00" })), "amount_mismatch");
  assert.equal(rejectionReason(sale({ items: [item()], discount: "1.00" }, 47600)), null);
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
  const out = transformBatch([valid(), valid(), { ...valid(), payload: { note: "different payload, same hash" } }]);
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
