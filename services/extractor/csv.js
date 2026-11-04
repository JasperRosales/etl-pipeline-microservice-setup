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
//   valid JSON is kept as the raw string; the reporter just ignores it.
// - Each row gets `row`: its position in the sheet with the header as row 1,
//   unless the file has its own `row` column.

"use strict";

const fs = require("fs");

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

// Turns CSV text into source row objects keyed by the header.
function csvToRows(text) {
  const [header, ...records] = parseCsv(text);
  if (!header) return [];
  const names = header.map((h) => h.trim());
  if (!names.includes("id")) {
    throw new Error(`CSV header must include an "id" column (got: ${names.join(", ")})`);
  }

  return records.map((values, index) => {
    const row = {};
    names.forEach((name, col) => {
      const value = values[col];
      if (name === "" || value === undefined || value.trim() === "") return;
      row[name] = value.trim();
    });
    if (typeof row.items === "string") {
      try {
        row.items = JSON.parse(row.items);
      } catch {
        /* keep the raw string */
      }
    }
    if (row.row === undefined) row.row = index + 2;
    else if (/^\d+$/.test(row.row)) row.row = Number(row.row);
    return row;
  });
}

function readCsvRows(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    throw new Error(err.code === "ENOENT" ? `CSV file not found: ${file}` : `cannot read CSV file ${file}: ${err.message}`);
  }
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

module.exports = { parseCsv, csvToRows, readCsvRows, filterSince };
