// Tests for the bad dataset gate (services/shared/quality.js) and its config.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { assessBatch } = require("../services/shared/quality");
const { isolatedEnv, runNode } = require("./helpers");

const rows = (n) => Array.from({ length: n }, (_, i) => ({ i }));
const rej = (n, reason = "amount_mismatch") => Array.from({ length: n }, (_, index) => ({ index, reason }));

test("passes a batch below the limit", () => {
  const q = assessBatch({ transactions: rows(10), rejected: [] }, { rejected: rej(5) }, 0.6);
  assert.equal(q.ok, true);
  assert.equal(q.percent, 50);
});

test("neglects a batch at exactly 60% bad", () => {
  const q = assessBatch({ transactions: rows(10), rejected: [] }, { rejected: rej(6) }, 0.6);
  assert.equal(q.ok, false);
  assert.equal(q.bad, 6);
  assert.equal(q.total, 10);
});

test("counts extractor rejects in both the bad rows and the total", () => {
  // 8 mapped rows + 2 unmappable CSV rows = 10; 2 + 4 = 6 bad -> 60%.
  const q = assessBatch(
    { transactions: rows(8), rejected: rej(2, "wrong_field_count") },
    { rejected: rej(4) },
    0.6
  );
  assert.equal(q.total, 10);
  assert.equal(q.bad, 6);
  assert.equal(q.ok, false);
  assert.deepEqual(q.reasons, { wrong_field_count: 2, amount_mismatch: 4 });
});

test("never neglects an empty batch", () => {
  const q = assessBatch({ transactions: [], rejected: [] }, { rejected: [] }, 0.6);
  assert.equal(q.ok, true);
});

test("MAX_REJECT_RATIO defaults to 0.6 and accepts a custom value", () => {
  const code = `console.log(require("./services/shared/config").maxRejectRatio)`;
  assert.equal(runNode(code, isolatedEnv()).stdout.trim(), "0.6");
  assert.equal(runNode(code, isolatedEnv({ MAX_REJECT_RATIO: "0.25" })).stdout.trim(), "0.25");
});

for (const value of ["0", "1.5", "60%", "abc"]) {
  test(`rejects MAX_REJECT_RATIO=${value}`, () => {
    const r = runNode(`require("./services/shared/config")`, isolatedEnv({ MAX_REJECT_RATIO: value }));
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /MAX_REJECT_RATIO must be a number greater than 0 and at most 1/);
  });
}
