// salsa-pos-api - source POS system for the S.A.L.S.A. ETL pipeline.
//
// Contract consumed by services/extractor (see docs/extractor.md):
//   GET /transactions?token=<API_TOKEN>[&since=<ISO 8601>]
//   -> 200 { "transactions": [ { id, amount, currency, timestamp, ... } ] }
//   -> 401 when the token is missing or wrong (extractor does not retry 4xx)
//   -> 400 when since is not a parseable date
//
// `since` is exclusive: only rows with timestamp > since are returned.
//
// Data lives in memory, loaded from data/seed.json at boot. POST /transactions
// appends a new sale (useful for demoing incremental extraction); appended
// rows are lost on restart, which is fine for a demo source on Render's free
// plan (no persistent disk).

"use strict";

const crypto = require("crypto");
const path = require("path");
const express = require("express");

const PORT = Number(process.env.PORT) || 10000;
const API_TOKEN = (process.env.API_TOKEN || "").trim();

if (!API_TOKEN) {
  console.error("API_TOKEN is required. Set it in the environment before starting salsa-pos-api.");
  process.exit(1);
}

const transactions = require(path.join(__dirname, "..", "data", "seed.json"));
let nextNumber = transactions.length + 1;

function tokenMatches(given) {
  if (typeof given !== "string") return false;
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(API_TOKEN).digest();
  return crypto.timingSafeEqual(a, b);
}

function requireToken(req, res, next) {
  const header = req.get("authorization") || "";
  const bearer = header.startsWith("Bearer ") ? header.slice(7) : undefined;
  if (!tokenMatches(req.query.token ?? bearer)) {
    return res.status(401).json({ error: { code: "unauthorized", message: "missing or invalid token" } });
  }
  next();
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "100kb" }));

app.get("/", (_req, res) => {
  res.json({
    name: "salsa-pos-api",
    endpoints: {
      "GET /health": "liveness, no token",
      "GET /transactions?token=...&since=ISO8601": "sales rows for the ETL extractor",
      "GET /transactions/:id?token=...": "single sale",
      "POST /transactions?token=...": "append a sale { amount, currency?, timestamp?, items?, ... }",
    },
  });
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "salsa-pos-api", transactions: transactions.length });
});

app.get("/transactions", requireToken, (req, res) => {
  let rows = transactions;
  if (req.query.since !== undefined) {
    const since = Date.parse(req.query.since);
    if (typeof req.query.since !== "string" || Number.isNaN(since)) {
      return res.status(400).json({ error: { code: "invalid_request", message: "since must be an ISO 8601 timestamp" } });
    }
    rows = rows.filter((tx) => Date.parse(tx.timestamp) > since);
  }
  res.json({ count: rows.length, transactions: rows });
});

app.get("/transactions/:id", requireToken, (req, res) => {
  const tx = transactions.find((t) => t.id === req.params.id);
  if (!tx) return res.status(404).json({ error: { code: "not_found", message: "transaction not found" } });
  res.json(tx);
});

app.post("/transactions", requireToken, (req, res) => {
  const body = req.body || {};
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return res.status(400).json({ error: { code: "invalid_request", message: "amount must be a positive number" } });
  }
  const timestamp = body.timestamp === undefined ? new Date() : new Date(body.timestamp);
  if (Number.isNaN(timestamp.getTime())) {
    return res.status(400).json({ error: { code: "invalid_request", message: "timestamp must be an ISO 8601 timestamp" } });
  }
  const tx = {
    id: `SALSA-TX-${String(nextNumber).padStart(5, "0")}`,
    row: nextNumber + 1,
    timestamp: timestamp.toISOString(),
    amount: amount.toFixed(2),
    currency: typeof body.currency === "string" && body.currency ? body.currency.toUpperCase() : "PHP",
    store_id: body.store_id || "STORE-BATANGAS",
    cashier_id: body.cashier_id || "C-101",
    payment_method: body.payment_method || "cash",
    discount: "0.00",
    items: Array.isArray(body.items) ? body.items : [],
  };
  nextNumber++;
  transactions.push(tx);
  res.status(201).json(tx);
});

app.use((_req, res) => res.status(404).json({ error: { code: "not_found", message: "route not found" } }));

// Express 5 forwards async errors here; body-parser JSON errors land here too.
app.use((err, _req, res, _next) => {
  const status = err.status && err.status < 500 ? err.status : 500;
  res.status(status).json({ error: { code: status === 500 ? "internal_error" : "invalid_request", message: err.message } });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`salsa-pos-api listening on :${PORT} with ${transactions.length} seeded transactions`);
});
