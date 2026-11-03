// Tests for POST /transactions validation (src/validate.js) and the API
// mounted in-process via createApp().

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { validateSale } = require("../src/validate");
const { createApp } = require("../src/app");

const NOW = new Date("2026-11-04T10:00:00Z");
const ok = (body) => validateSale(body, NOW);

test("accepts a minimal sale and applies defaults", () => {
  const r = ok({ amount: 149 });
  assert.equal(r.ok, true);
  assert.equal(r.value.amount, 149);
  assert.equal(r.value.currency, "PHP");
  assert.equal(r.value.timestamp, NOW);
  assert.deepEqual(r.value.items, []);
});

test("accepts amount as a decimal string and normalizes currency/payment case", () => {
  const r = ok({ amount: "12.50", currency: " php ", payment_method: "GCash" });
  assert.equal(r.ok, true, r.message);
  assert.equal(r.value.amount, 12.5);
  assert.equal(r.value.currency, "PHP");
  assert.equal(r.value.payment_method, "gcash");
});

test("rejects non-object bodies", () => {
  for (const body of [null, undefined, "x", 5, [{ amount: 1 }]]) assert.equal(ok(body).ok, false);
});

test("rejects bad amounts", () => {
  for (const amount of [undefined, null, "", "abc", 0, -5, "1.234", 1e9, Infinity, true, {}]) {
    const r = ok({ amount });
    assert.equal(r.ok, false, `amount=${String(amount)}`);
    assert.match(r.message, /amount/);
  }
});

test("rejects currencies the ETL transformer would reject", () => {
  for (const currency of ["PESO", "PH", "", "P1P", 608]) {
    const r = ok({ amount: 1, currency });
    assert.equal(r.ok, false, `currency=${currency}`);
    assert.match(r.message, /currency/);
  }
});

test("rejects unparseable and future timestamps, accepts past ones", () => {
  assert.match(ok({ amount: 1, timestamp: "not a date" }).message, /ISO 8601/);
  assert.match(ok({ amount: 1, timestamp: {} }).message, /ISO 8601/);
  assert.match(ok({ amount: 1, timestamp: "2027-01-01T00:00:00Z" }).message, /future/);
  assert.equal(ok({ amount: 1, timestamp: "2026-11-04T10:04:00Z" }).ok, true); // within clock skew
  assert.equal(ok({ amount: 1, timestamp: "2026-10-01T00:00:00Z" }).ok, true);
});

test("validates string fields and payment methods", () => {
  assert.match(ok({ amount: 1, store_id: "" }).message, /store_id/);
  assert.match(ok({ amount: 1, cashier_id: 7 }).message, /cashier_id/);
  assert.match(ok({ amount: 1, store_id: "x".repeat(65) }).message, /store_id/);
  assert.match(ok({ amount: 1, payment_method: "bitcoin" }).message, /payment_method must be one of/);
});

test("validates items", () => {
  assert.match(ok({ amount: 1, items: "x" }).message, /items must be an array/);
  assert.match(ok({ amount: 1, items: [null] }).message, /items\[0\] must be an object/);
  assert.match(ok({ amount: 1, items: [{ qty: 1, unit_price: 1 }] }).message, /items\[0\]\.name/);
  assert.match(ok({ amount: 1, items: [{ name: "A", qty: 0, unit_price: 1 }] }).message, /qty/);
  assert.match(ok({ amount: 1, items: [{ name: "A", qty: 1.5, unit_price: 1 }] }).message, /qty/);
  assert.match(ok({ amount: 1, items: [{ name: "A", qty: 1, unit_price: -1 }] }).message, /unit_price/);
  assert.match(ok({ amount: 1, items: Array(101).fill({ name: "A", qty: 1, unit_price: 1 }) }).message, /at most 100/);
  const r = ok({ amount: 298, items: [{ sku: "SAL-001", name: " Salsa ", qty: 2, unit_price: 149 }] });
  assert.deepEqual(r.value.items, [{ sku: "SAL-001", name: "Salsa", qty: 2, unit_price: "149.00" }]);
});

async function withServer(fn) {
  const app = createApp({ token: "t0k", transactions: [] });
  const server = await new Promise((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((r) => server.close(r));
  }
}

test("API: POST requires a token, returns 400 on invalid input and 201 on success", async () => {
  await withServer(async (base) => {
    const post = (body, auth = "Bearer t0k") =>
      fetch(`${base}/transactions`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: auth }, body });

    assert.equal((await post(JSON.stringify({ amount: 1 }), "Bearer wrong")).status, 401);

    let res = await post(JSON.stringify({ amount: 1, currency: "PESO" }));
    assert.equal(res.status, 400);
    assert.equal((await res.json()).error.code, "invalid_request");

    res = await post("{broken");
    assert.equal(res.status, 400);

    res = await post(JSON.stringify({ amount: "298", store_id: "STORE-LIPA", payment_method: "maya", items: [{ sku: "SAL-001", name: "Salsa", qty: 2, unit_price: 149 }] }));
    assert.equal(res.status, 201);
    const tx = await res.json();
    assert.equal(tx.id, "SALSA-TX-00001");
    assert.equal(tx.amount, "298.00");
    assert.equal(tx.payment_method, "maya");

    const list = await (await fetch(`${base}/transactions?token=t0k`)).json();
    assert.equal(list.count, 1);
  });
});
