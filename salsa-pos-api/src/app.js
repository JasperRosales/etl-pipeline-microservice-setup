// Express app for salsa-pos-api, built by createApp() so tests can mount it
// without listening on a port or calling process.exit. See server.js for the
// entry point and README.md for the endpoint table.

"use strict";

const crypto = require("crypto");
const express = require("express");
const { validateSale } = require("./validate");

function createApp({ token, transactions }) {
  let nextNumber = transactions.length + 1;

  function tokenMatches(given) {
    if (typeof given !== "string") return false;
    const a = crypto.createHash("sha256").update(given).digest();
    const b = crypto.createHash("sha256").update(token).digest();
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
    const result = validateSale(req.body);
    if (!result.ok) {
      return res.status(400).json({ error: { code: "invalid_request", message: result.message } });
    }
    const sale = result.value;
    const tx = {
      id: `SALSA-TX-${String(nextNumber).padStart(5, "0")}`,
      row: nextNumber + 1,
      timestamp: sale.timestamp.toISOString(),
      amount: sale.amount.toFixed(2),
      currency: sale.currency,
      store_id: sale.store_id || "STORE-BATANGAS",
      cashier_id: sale.cashier_id || "C-101",
      payment_method: sale.payment_method || "cash",
      discount: "0.00",
      items: sale.items,
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

  return app;
}

module.exports = { createApp };
