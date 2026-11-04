// Reads POS transactions from a CSV file (unit-tested in test/extractor.test.js).
//
// Expected file: a header row, then one transaction per row, e.g.
//
//   id,timestamp,amount,currency,store_id,cashier_id,payment_method,discount,items
//   SALSA-TX-00001,2026-10-01T02:54:09.000Z,477.00,PHP,STORE-LIPA,C-101,maya,0.00,"[{""sku"":""SAL-002"",""qty"":3,""unit_price"":""159.00""}]"
//
// - RFC 4180 quoting: fields may be wrapped in double quotes, "" is a literal
//   quote, and quoted fields may contain commas and line breaks. CRLF or LF.
// - Header names are trimmed. Values are kept as strings (normalize.js does
//   the type conversion), and empty cells are left out of the row object so a
//   blank amount is rejected downstream instead of becoming 0.
// - The `items` column holds a JSON array of line items. A cell that is not
//   valid JSON is kept as the raw string, which the transformer rejects.
// - Each row gets `row`: its position in the sheet with the header as row 1,
//   unless the file has its own `row` column.
//
// File-level checks (any failure fails the whole extract):
//   - the header has every REQUIRED_COLUMNS entry, no blank names, no duplicates
//   - the file is not over MAX_FILE_BYTES and has at most MAX_ROWS data rows
//     (the extract response has to fit the 5 MB request limit downstream)
//   - no unterminated quoted field
// Row-level check: a row whose cell count differs from the header's (usually
// an unquoted comma shifting every later column) is not mapped, because its
// values would land in the wrong fields. It is returned in `rejected` as
// { row, external_id, reason: "wrong_field_count" } instead.

"use strict";

const fs = require("fs");

const REQUIRED_COLUMNS = ["id", "timestamp", "amount", "currency"];
const MAX_ROWS = 5_000;
const MAX_FILE_BYTES = 1.5 * 1024 * 1024;

// Splits CSV text into an array of records (arrays of strings).
function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // Excel's UTF-8 BOM
  const records = [];
  let record = [];
  let field = "";
  let quoted = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else {
        field += ch;
      }
      i++;
      continue;
    }
    if (ch === '"' && field === "") {
      quoted = true;
    } else if (ch === ",") {
      record.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      record.push(field);
      records.push(record);
      record = [];
      field = "";
      if (ch === "\r" && text[i + 1] === "\n") i++;
    } else {
      field += ch;
    }
    i++;
  }
  if (quoted) throw new Error("CSV has an unterminated quoted field");
  if (field !== "" || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  // Blank lines (a single empty field) carry no data.
  return records.filter((r) => !(r.length === 1 && r[0].trim() === ""));
}

function headerProblem(names) {
  if (names.some((n) => n === "")) return "CSV header has a blank column name";
  const dup = names.find((n, i) => names.indexOf(n) !== i);
  if (dup) return `CSV header repeats the column "${dup}"`;
  const missing = REQUIRED_COLUMNS.filter((c) => !names.includes(c));
  if (missing.length) return `CSV header is missing required column(s): ${missing.join(", ")} (got: ${names.join(", ")})`;
  return null;
}

// Turns CSV text into { rows, rejected }: source row objects keyed by the
// header, plus rows that could not be mapped.
function csvToRows(text) {
  const [header, ...records] = parseCsv(text);
  if (!header) return { rows: [], rejected: [] };
  const names = header.map((h) => h.trim());
  const problem = headerProblem(names);
  if (problem) throw new Error(problem);
  if (records.length > MAX_ROWS) {
    throw new Error(`CSV has ${records.length} data rows; the limit is ${MAX_ROWS}. Archive older rows to a separate file.`);
  }

  const rows = [];
  const rejected = [];
  records.forEach((values, index) => {
    const position = index + 2;
    if (values.length !== names.length) {
      const id = values[names.indexOf("id")];
      rejected.push({
        row: position,
        external_id: id && id.trim() ? id.trim() : null,
        reason: "wrong_field_count",
        detail: `${values.length} cells, header has ${names.length}`,
      });
      return;
    }
    const row = {};
    names.forEach((name, col) => {
      const value = values[col];
      if (value.trim() === "") return;
      row[name] = value.trim();
    });
    if (typeof row.items === "string") {
      try {
        row.items = JSON.parse(row.items);
      } catch {
        /* keep the raw string; the transformer rejects it as invalid_items */
      }
    }
    if (row.row === undefined) row.row = position;
    else if (/^\d+$/.test(row.row)) row.row = Number(row.row);
    rows.push(row);
  });
  return { rows, rejected };
}

function readCsvRows(file) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (err) {
    throw new Error(err.code === "ENOENT" ? `CSV file not found: ${file}` : `cannot read CSV file ${file}: ${err.message}`);
  }
  if (!stat.isFile()) throw new Error(`CSV path is not a file: ${file}`);
  if (stat.size > MAX_FILE_BYTES) {
    throw new Error(`CSV file is ${stat.size} bytes; the limit is ${MAX_FILE_BYTES}. Archive older rows to a separate file.`);
  }
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    throw new Error(`cannot read CSV file ${file}: ${err.message}`);
  }
  if (text.includes("\uFFFD")) throw new Error(`CSV file ${file} is not valid UTF-8; save it as "CSV UTF-8"`);
  return csvToRows(text);
}

// Keeps rows at or after `since` (ISO string). Rows without a parseable
// timestamp are kept so the transformer can reject them with a reason.
function filterSince(rows, since) {
  if (!since) return rows;
  const cutoff = Date.parse(since);
  return rows.filter((row) => {
    const ts = Date.parse(row.timestamp);
    return Number.isNaN(ts) || ts >= cutoff;
  });
}

module.exports = { REQUIRED_COLUMNS, MAX_ROWS, MAX_FILE_BYTES, parseCsv, csvToRows, readCsvRows, filterSince };
