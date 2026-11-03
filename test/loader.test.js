// Loader validation (services/loader/store.js): every column it writes is type-checked.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { loadRequestProblem } = require("../services/loader/store");
const { dedupeHash } = require("../services/transformer/validate");

function tx(overrides = {}) {
  const base = { external_id: "A", source: "salsa-pos-api", amount_minor: 100, currency: "PHP", transaction_ts: "2026-10-01T00:00:00.000Z", payload: {} };
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

test("every written column is type-checked", () => {
  const cases = [
    [{ source: "" }, /source/],
    [{ source: 5 }, /source/],
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
