// Runs every test CSV in data/samples/csv/ through the extractor's parser,
// the transformer's validation and the bad dataset gate (default 60%), and
// checks each file gets the verdict it was built for
// (scripts/make-sample-csvs.js).

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { readCsvRows } = require("../services/extractor/csv");
const { toTransaction } = require("../services/extractor/normalize");
const { transformBatch } = require("../services/transformer/validate");
const { assessBatch } = require("../services/shared/quality");

const DIR = path.join(__dirname, "..", "data", "samples", "csv");
const NOW = Date.parse("2026-11-01T00:00:00Z");

// file -> [bad, total, loaded?]
const EXPECTED = {
  "clean.csv": [0, 20, true],
  "few-bad-20pct.csv": [4, 20, true],
  "edge-59pct-bad.csv": [13, 22, true],
  "edge-60pct-bad.csv": [12, 20, false],
  "mostly-bad-80pct.csv": [16, 20, false],
  "all-bad.csv": [9, 9, false],
  "broken-columns-70pct.csv": [14, 20, false],
  "duplicates-70pct.csv": [7, 10, false],
  "header-only.csv": [0, 0, true],
};

function run(file) {
  const { rows, rejected } = readCsvRows(path.join(DIR, file));
  const extracted = { transactions: rows.map(toTransaction), rejected };
  const transformed = transformBatch(extracted.transactions, NOW);
  return assessBatch(extracted, transformed, 0.6);
}

for (const [file, [bad, total, loaded]] of Object.entries(EXPECTED)) {
  test(`${file}: ${bad}/${total} bad -> ${loaded ? "loaded" : "neglected"}`, () => {
    const q = run(file);
    assert.equal(q.total, total);
    assert.equal(q.bad, bad);
    assert.equal(q.ok, loaded);
  });
}

test("mixed files hit every bad row reason", () => {
  const reasons = Object.keys(run("all-bad.csv").reasons).sort();
  assert.deepEqual(reasons, [
    "amount_mismatch",
    "future_timestamp",
    "invalid_amount",
    "invalid_currency",
    "invalid_discount",
    "invalid_items",
    "invalid_timestamp",
    "missing_external_id",
    "wrong_field_count",
  ]);
});

test("a CSV missing a required column fails the extract instead of being gated", () => {
  assert.throws(() => run("missing-header-column.csv"), /missing required column\(s\): currency/);
});

test("every sample CSV has an expectation", () => {
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith(".csv"));
  for (const f of files) assert.ok(f in EXPECTED || f === "missing-header-column.csv", `no expectation for ${f}`);
});
