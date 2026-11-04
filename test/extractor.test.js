// Unit tests for the extractor's CSV reader (services/extractor/csv.js) and row
// normalizer (services/extractor/normalize.js), plus a check that every row in
// data/transactions.csv survives extractor -> transformer.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { MAX_ROWS, MAX_FILE_BYTES, parseCsv, csvToRows, readCsvRows, filterSince } = require("../services/extractor/csv");
const { toTransaction, toIso } = require("../services/extractor/normalize");
const { rejectionReason, transformBatch } = require("../services/transformer/validate");

test("maps a POS row to the raw Transaction shape", () => {
  const row = { id: "SALSA-TX-00001", amount: "477.00", currency: "php", timestamp: "2026-10-01T02:54:09Z", store_id: "STORE-LIPA" };
  assert.deepEqual(toTransaction(row), {
    external_id: "SALSA-TX-00001",
    source: "csv",
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
  // toTransaction normalizes any parseable timestamp to canonical UTC.
  assert.equal(rejectionReason(toTransaction({ id: "A", amount: "1", currency: "PHP", timestamp: "2026-01-01" })), null);
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

const HEADER = "id,timestamp,amount,currency";

test("csvToRows keys by header, drops empty cells, parses items and numbers rows", () => {
  const { rows, rejected } = csvToRows(
    'id ,timestamp, amount,currency,items\nA,2026-01-01T00:00:00Z,1.50,php,"[{""sku"":""S"",""qty"":2}]"\nB,2026-01-01T00:00:00Z,,PHP,not-json\n'
  );
  assert.deepEqual(rejected, []);
  assert.deepEqual(rows, [
    { id: "A", timestamp: "2026-01-01T00:00:00Z", amount: "1.50", currency: "php", items: [{ sku: "S", qty: 2 }], row: 2 },
    { id: "B", timestamp: "2026-01-01T00:00:00Z", currency: "PHP", items: "not-json", row: 3 },
  ]);
  // A blank amount is rejected, not loaded as 0.
  assert.equal(rejectionReason(toTransaction(rows[1])), "invalid_amount");
  assert.deepEqual(csvToRows(""), { rows: [], rejected: [] });
});

test("csvToRows rejects a bad header: missing required, blank or repeated columns", () => {
  assert.throws(() => csvToRows("id,amount\n1,2"), /missing required column\(s\): timestamp, currency/);
  assert.throws(() => csvToRows(`${HEADER},\n1,2,3,4,5`), /blank column name/);
  assert.throws(() => csvToRows(`${HEADER},amount\n1,2,3,4,5`), /repeats the column "amount"/);
});

test("csvToRows rejects rows whose cell count differs from the header", () => {
  // The unquoted comma in 1,250.00 shifts currency into the wrong column.
  const { rows, rejected } = csvToRows(`${HEADER}\nA,2026-01-01T00:00:00Z,1,250.00,PHP\nB,2026-01-01T00:00:00Z,5.00\nC,2026-01-01T00:00:00Z,5.00,PHP\n`);
  assert.deepEqual(rows.map((r) => r.id), ["C"]);
  assert.deepEqual(rejected, [
    { row: 2, external_id: "A", reason: "wrong_field_count", detail: "5 cells, header has 4" },
    { row: 3, external_id: "B", reason: "wrong_field_count", detail: "3 cells, header has 4" },
  ]);
});

test("csvToRows enforces the row limit", () => {
  const body = Array.from({ length: MAX_ROWS + 1 }, (_, i) => `T${i},2026-01-01T00:00:00Z,1.00,PHP`).join("\n");
  assert.throws(() => csvToRows(`${HEADER}\n${body}`), new RegExp(`limit is ${MAX_ROWS}`));
});

test("readCsvRows rejects a missing file, a directory, an oversized file and non-UTF-8 text", () => {
  const fs = require("fs");
  const os = require("os");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "etl-csv-"));
  assert.throws(() => readCsvRows(path.join(dir, "no-such.csv")), /CSV file not found/);
  assert.throws(() => readCsvRows(dir), /not a file/);
  const big = path.join(dir, "big.csv");
  fs.writeFileSync(big, `${HEADER}\n`.padEnd(MAX_FILE_BYTES + 1, "x"));
  assert.throws(() => readCsvRows(big), /the limit is/);
  const latin1 = path.join(dir, "latin1.csv");
  fs.writeFileSync(latin1, Buffer.concat([Buffer.from(`${HEADER}\nA,2026-01-01T00:00:00Z,1.00,PHP,`), Buffer.from([0xf1])]));
  assert.throws(() => readCsvRows(latin1), /not valid UTF-8/);
});

test("filterSince keeps rows at or after the cutoff and rows with bad timestamps", () => {
  const rows = [{ id: "old", timestamp: "2026-01-01T00:00:00Z" }, { id: "new", timestamp: "2026-02-01T00:00:00Z" }, { id: "bad", timestamp: "?" }];
  assert.deepEqual(filterSince(rows, "2026-02-01T00:00:00.000Z").map((r) => r.id), ["new", "bad"]);
  assert.equal(filterSince(rows, undefined), rows);
});

test("data/transactions.csv: 120 sales with unique ids that all pass the transformer", () => {
  const { rows, rejected } = readCsvRows(path.join(__dirname, "..", "data", "transactions.csv"));
  assert.deepEqual(rejected, []);
  assert.equal(rows.length, 120);
  assert.equal(new Set(rows.map((r) => r.id)).size, rows.length);
  assert.ok(rows.every((r) => Array.isArray(r.items)), "every row has parsed line items");
  const out = transformBatch(rows.map(toTransaction));
  assert.equal(out.rejected.length, 0, JSON.stringify(out.rejected.slice(0, 3)));
  assert.equal(out.rows_out, rows.length);
});
