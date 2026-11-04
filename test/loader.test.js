// Loader validation (services/loader/store.js): every column it writes is type-checked.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadRequestProblem } = require("../services/loader/store");
const { dedupeHash } = require("../services/transformer/validate");

function tx(overrides = {}) {
  const base = { external_id: "A", source: "csv", amount_minor: 100, currency: "PHP", transaction_ts: "2026-10-01T00:00:00.000Z", payload: {} };
  const t = { ...base, ...overrides };
  return { ...t, dedupe_hash: overrides.dedupe_hash ?? dedupeHash(t) };
}
const req = (transactions, run_id = "r1") => ({ run_id, transactions });

test("accepts a valid batch, including an empty one", () => {
  assert.equal(loadRequestProblem(req([tx()])), null);
  assert.equal(loadRequestProblem(req([])), null);
});

test("run_id and transactions are required", () => {
  assert.match(loadRequestProblem(null), /JSON object/);
  assert.match(loadRequestProblem({ transactions: [] }), /run_id/);
  assert.match(loadRequestProblem(req([], "  ")), /run_id/);
  assert.match(loadRequestProblem({ run_id: "r", transactions: "x" }), /must be an array/);
});

test("rows must be transformed (valid 64-hex dedupe_hash)", () => {
  assert.match(loadRequestProblem(req([{ external_id: "A" }])), /missing dedupe_hash/);
  assert.match(loadRequestProblem(req([null])), /missing dedupe_hash/);
  assert.match(loadRequestProblem(req([tx({ dedupe_hash: "h1" })])), /64-character hex/);
});

test("run_id must be 1-100 letters, digits, '-' or '_'", () => {
  for (const run_id of ["seed-1b2c", "b3f1c2d4-0000-4000-8000-000000000000", "smoke_1"]) {
    assert.equal(loadRequestProblem(req([tx()], run_id)), null, run_id);
  }
  for (const run_id of ["-lead", "has space", "semi;colon", "x".repeat(101)]) {
    assert.match(loadRequestProblem(req([tx()], run_id)), /run_id must be 1-100/, run_id);
  }
});

test("rejects unknown fields on the request and on each row", () => {
  assert.match(loadRequestProblem({ ...req([tx()]), extra: 1 }), /unknown field\(s\): extra/);
  const t = tx();
  assert.match(loadRequestProblem(req([{ ...t, note: "x" }])), /transactions\[0\] has unknown field\(s\): note/);
});

test("dedupe_hash must match the row's fields and be unique in the batch", () => {
  assert.match(loadRequestProblem(req([tx({ dedupe_hash: "a".repeat(64) })])), /does not match its fields/);
  // Edited after the transformer: same hash, different amount.
  const t = tx();
  assert.match(loadRequestProblem(req([{ ...t, amount_minor: 999 }])), /does not match its fields/);
  assert.match(loadRequestProblem(req([t, t])), /transactions\[1\] repeats the dedupe_hash/);
});

test("rows are checked with the transformer's full rules", () => {
  assert.match(loadRequestProblem(req([tx({ transaction_ts: "2026-10-01" })])), /invalid_timestamp/);
  assert.match(loadRequestProblem(req([tx({ payload: { items: [{ sku: "S", qty: 1, unit_price: "2.00" }] } })])), /amount_mismatch/);
});

test("every written column is type-checked", () => {
  const cases = [
    [{ source: "" }, /invalid_source/],
    [{ source: 5 }, /invalid_source/],
    [{ external_id: "" }, /missing_external_id/],
    [{ amount_minor: 1.5 }, /invalid_amount/],
    [{ amount_minor: "100" }, /invalid_amount/],
    [{ currency: "peso" }, /invalid_currency/],
    [{ transaction_ts: "soon" }, /invalid_timestamp/],
  ];
  for (const [overrides, pattern] of cases) {
    assert.match(loadRequestProblem(req([tx(), tx(overrides)])), new RegExp(`transactions\\[1\\].*${pattern.source}`), JSON.stringify(overrides));
  }
});
