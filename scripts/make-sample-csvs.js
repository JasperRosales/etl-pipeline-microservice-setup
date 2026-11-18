// Writes the test CSVs in data/samples/csv/ for the bad dataset gate
// (MAX_REJECT_RATIO). Each file mixes valid rows with bad ones at a known
// ratio; test/sample-csvs.test.js checks each file's expected verdict.
//
//   node scripts/make-sample-csvs.js
//   npm run pipeline -- --csv data/samples/csv/edge-60pct-bad.csv
//
// Output is deterministic, so rerunning only changes files when this script does.

"use strict";

const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "..", "data", "samples", "csv");
const HEADER = "id,timestamp,amount,currency,store_id,cashier_id,payment_method,discount,items";

const PRODUCTS = [
  ["SAL-001", "Classic Salsa Roja 250g", "149.00"],
  ["SAL-002", "Salsa Verde 250g", "159.00"],
  ["CHP-001", "Tortilla Chips 200g", "89.00"],
  ["BEV-002", "Calamansi Soda 330ml", "65.00"],
];
const STORES = ["STORE-LIPA", "STORE-NASUGBU", "STORE-BATANGAS"];
const PAYMENTS = ["cash", "gcash", "maya", "card"];

const q = (s) => `"${String(s).replace(/"/g, '""')}"`;

// A valid row: amount equals the sum of its items, past timestamp, PHP.
function good(prefix, n) {
  const [sku, name, price] = PRODUCTS[n % PRODUCTS.length];
  const qty = (n % 3) + 1;
  const amount = (qty * Number(price)).toFixed(2);
  const ts = new Date(Date.UTC(2026, 9, 1 + (n % 28), 1 + (n % 10), (n * 7) % 60, 0)).toISOString();
  const items = JSON.stringify([{ sku, name, qty, unit_price: price }]);
  return {
    id: `${prefix}-${String(n).padStart(4, "0")}`,
    ts,
    amount,
    currency: "PHP",
    store: STORES[n % STORES.length],
    cashier: `C-${101 + (n % 5)}`,
    payment: PAYMENTS[n % PAYMENTS.length],
    discount: "0.00",
    items,
  };
}

const line = (r) =>
  [r.id, r.ts, r.amount, r.currency, r.store, r.cashier, r.payment, r.discount, q(r.items)].join(",");

// Bad row kinds, each with the reason the pipeline should give.
const BAD = {
  missing_external_id: (r) => line({ ...r, id: "" }),
  invalid_amount: (r) => line({ ...r, amount: "abc" }),
  invalid_currency: (r) => line({ ...r, currency: "PESOS" }),
  invalid_timestamp: (r) => line({ ...r, ts: "yesterday" }),
  future_timestamp: (r) => line({ ...r, ts: "2099-01-01T00:00:00.000Z" }),
  invalid_items: (r) => line({ ...r, items: "not json" }),
  invalid_discount: (r) => line({ ...r, discount: "-5.00" }),
  amount_mismatch: (r) => line({ ...r, amount: (Number(r.amount) + 10).toFixed(2) }),
  wrong_field_count: (r) => `${r.id},${r.ts},${r.amount}`,
};
const MIXED = Object.keys(BAD);

// rows: total data rows; bad: how many are bad; kinds: which bad kinds to cycle.
function build(prefix, rows, bad, kinds = MIXED) {
  const out = [HEADER];
  // Spread the bad rows through the file instead of bunching them at the end.
  const badAt = new Set(Array.from({ length: bad }, (_, i) => Math.floor((i * rows) / bad)));
  let k = 0;
  for (let n = 0; n < rows; n++) {
    const r = good(prefix, n);
    out.push(badAt.has(n) ? BAD[kinds[k++ % kinds.length]](r) : line(r));
  }
  return out.join("\n") + "\n";
}

function duplicates() {
  // 3 distinct sales, the first one repeated 7 more times: 7/10 bad.
  const out = [HEADER];
  const first = line(good("SMP-DUP", 0));
  out.push(first, line(good("SMP-DUP", 1)), line(good("SMP-DUP", 2)));
  for (let i = 0; i < 7; i++) out.push(first);
  return out.join("\n") + "\n";
}

const FILES = {
  "clean.csv": build("SMP-CLEAN", 20, 0),
  "few-bad-20pct.csv": build("SMP-FEW", 20, 4),
  "edge-59pct-bad.csv": build("SMP-E59", 22, 13),
  "edge-60pct-bad.csv": build("SMP-E60", 20, 12),
  "mostly-bad-80pct.csv": build("SMP-M80", 20, 16),
  "all-bad.csv": build("SMP-ALL", 9, 9),
  "broken-columns-70pct.csv": build("SMP-COL", 20, 14, ["wrong_field_count"]),
  "duplicates-70pct.csv": duplicates(),
  "header-only.csv": HEADER + "\n",
  "missing-header-column.csv": build("SMP-HDR", 5, 0).replace(HEADER, HEADER.replace(",currency", "")),
};

fs.mkdirSync(OUT, { recursive: true });
for (const [name, text] of Object.entries(FILES)) fs.writeFileSync(path.join(OUT, name), text);
console.log(`wrote ${Object.keys(FILES).length} files to ${OUT}`);
