// Unit tests for the extractor's CSV reader (services/extractor/csv.js) and row
// normalizer (services/extractor/normalize.js), plus a check that every row in
// data/transactions.csv survives extractor -> transformer.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { parseCsv, csvToRows, readCsvRows, filterSince } = require("../services/extractor/csv");
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

test("parseCsv handles quotes, escaped quotes, embedded commas/newlines, CRLF and a BOM", () => {
  const text = '\ufeffa,b,c\r\n1,"x, y","say ""hi"""\r\n2,"line1\nline2",\r\n\r\n';
  assert.deepEqual(parseCsv(text), [
    ["a", "b", "c"],
    ["1", "x, y", 'say "hi"'],
    ["2", "line1\nline2", ""],
  ]);
  assert.deepEqual(parseCsv("a,b\n1,2"), [["a", "b"], ["1", "2"]]); // no trailing newline
  assert.throws(() => parseCsv('a\n"open'), /unterminated quoted field/);
});

test("csvToRows keys by header, drops empty cells, parses items and numbers rows", () => {
  const rows = csvToRows('id , amount,currency,items\nA,1.50,php,"[{""sku"":""S"",""qty"":2}]"\nB,,PHP,not-json\n');
  assert.deepEqual(rows, [
    { id: "A", amount: "1.50", currency: "php", items: [{ sku: "S", qty: 2 }], row: 2 },
    { id: "B", currency: "PHP", items: "not-json", row: 3 },
  ]);
  // A blank amount is rejected, not loaded as 0.
  assert.equal(rejectionReason(toTransaction({ ...rows[1], timestamp: "2026-01-01" })), "invalid_amount");
  assert.deepEqual(csvToRows(""), []);
  assert.throws(() => csvToRows("amount\n1"), /must include an "id" column/);
});

test("readCsvRows reports a missing file clearly", () => {
  assert.throws(() => readCsvRows(path.join(__dirname, "no-such.csv")), /CSV file not found/);
});

test("filterSince keeps rows at or after the cutoff and rows with bad timestamps", () => {
  const rows = [{ id: "old", timestamp: "2026-01-01T00:00:00Z" }, { id: "new", timestamp: "2026-02-01T00:00:00Z" }, { id: "bad", timestamp: "?" }];
  assert.deepEqual(filterSince(rows, "2026-02-01T00:00:00.000Z").map((r) => r.id), ["new", "bad"]);
  assert.equal(filterSince(rows, undefined), rows);
});

test("data/transactions.csv matches the salsa-pos-api seed and passes the transformer", () => {
  const rows = readCsvRows(path.join(__dirname, "..", "data", "transactions.csv"));
  // Same payloads as seed.json, so the dedupe hashes match rows loaded before the CSV switch.
  assert.deepEqual(rows, seed);
  const out = transformBatch(rows.map(toTransaction));
  assert.equal(out.rejected.length, 0, JSON.stringify(out.rejected.slice(0, 3)));
  assert.equal(out.rows_out, rows.length);
});
