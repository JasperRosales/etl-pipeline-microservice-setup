// Generates data/seed.json: deterministic POS sales for the S.A.L.S.A. pipeline.
//
// Usage: npm run seed            (from salsa-pos-api/)
//
// The output is fixed for a given SEED value, so re-running produces the same
// transaction ids and amounts. That matters downstream: the transformer and
// loader dedupe on (source, external_id, amount, currency, timestamp), so a
// stable seed means repeated extractions never create duplicate rows.

"use strict";

const fs = require("fs");
const path = require("path");

const SEED = 20261103;
const COUNT = 120;
const START = Date.parse("2026-10-01T00:00:00+08:00"); // store opens Oct 1, Asia/Manila
const DAYS = 31;

// mulberry32 - tiny deterministic PRNG.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const products = [
  { sku: "SAL-001", name: "Classic Salsa Roja 250g", price: 149.0 },
  { sku: "SAL-002", name: "Salsa Verde 250g", price: 159.0 },
  { sku: "SAL-003", name: "Mango Habanero Salsa 250g", price: 189.0 },
  { sku: "CHP-001", name: "Tortilla Chips 200g", price: 99.0 },
  { sku: "CHP-002", name: "Spicy Nacho Chips 200g", price: 109.0 },
  { sku: "GUA-001", name: "Guacamole Cup 150g", price: 129.0 },
  { sku: "BEV-001", name: "Horchata 350ml", price: 85.0 },
  { sku: "BEV-002", name: "Calamansi Soda 330ml", price: 65.0 },
  { sku: "BUN-001", name: "Fiesta Bundle (Salsa + Chips + Guac)", price: 329.0 },
];
const stores = ["STORE-BATANGAS", "STORE-LIPA", "STORE-NASUGBU"];
const cashiers = ["C-101", "C-102", "C-103", "C-104"];
const payments = ["cash", "cash", "gcash", "card", "maya"];

function pick(r, list) {
  return list[Math.floor(r() * list.length)];
}

function generate() {
  const r = rng(SEED);
  const rows = [];
  for (let i = 0; i < COUNT; i++) {
    const day = Math.floor(r() * DAYS);
    const minuteOfDay = 9 * 60 + Math.floor(r() * 12 * 60); // 09:00-21:00 local
    const ts = new Date(START + day * 86400000 + minuteOfDay * 60000 + Math.floor(r() * 60) * 1000);

    const lineCount = 1 + Math.floor(r() * 3);
    const items = [];
    for (let j = 0; j < lineCount; j++) {
      const p = pick(r, products);
      const qty = 1 + Math.floor(r() * 3);
      items.push({ sku: p.sku, name: p.name, qty, unit_price: p.price.toFixed(2) });
    }
    const subtotal = items.reduce((sum, it) => sum + it.qty * Number(it.unit_price), 0);
    const discount = r() < 0.15 ? Math.round(subtotal * 0.1 * 100) / 100 : 0;
    const amount = Math.round((subtotal - discount) * 100) / 100;

    rows.push({
      timestamp: ts.toISOString(),
      amount: amount.toFixed(2),
      currency: "PHP",
      store_id: pick(r, stores),
      cashier_id: pick(r, cashiers),
      payment_method: pick(r, payments),
      discount: discount.toFixed(2),
      items,
    });
  }

  rows.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return rows.map((row, i) => ({
    id: `SALSA-TX-${String(i + 1).padStart(5, "0")}`,
    row: i + 2, // spreadsheet-style row number (row 1 is the header)
    ...row,
  }));
}

if (require.main === module) {
  const out = path.join(__dirname, "..", "data", "seed.json");
  const rows = generate();
  fs.writeFileSync(out, JSON.stringify(rows, null, 2) + "\n");
  console.log(`wrote ${rows.length} transactions to ${path.relative(process.cwd(), out)}`);
}

module.exports = { generate };
