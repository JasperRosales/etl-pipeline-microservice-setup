// Extractor service (port 3001) - POST /extract, GET /health.
// Contract: docs/http-contract.md section 5.
//
// Calls the Google Apps Script Web App / Sheets API endpoint from .env with the
// API_TOKEN, normalizes the rows into the raw Transaction shape, and mints the
// run_id that the scheduler threads through the pipeline into POST /load.
//
// Expected endpoint response: a JSON array of sheet rows (or { "transactions": [...] })
//   [ { "id": "TX-1", "amount": "12.50", "currency": "USD", "timestamp": "...", "row": 2 } ]
// Rows that do not normalize cleanly are passed through; the transformer rejects
// them with a reason (that is the contract's division of labor).
//
// Transient upstream failures are retried (Issue 7): 3 attempts with
// exponential backoff. Transport errors and 5xx retry; 4xx (e.g. bad token)
// and malformed 200 bodies are deterministic and fail fast.

"use strict";

const crypto = require("crypto");
const { start, sendError } = require("../shared/app");
const { withRetry } = require("../shared/retry");

function toIso(value) {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

function toTransaction(row) {
  const cents = typeof row.amount === "string" || typeof row.amount === "number" ? Math.round(Number(row.amount) * 100) : NaN;
  return {
    external_id: row.id === undefined || row.id === null ? undefined : String(row.id),
    source: "google-sheets",
    amount_minor: cents,
    currency: typeof row.currency === "string" && row.currency ? row.currency.toUpperCase() : "USD",
    transaction_ts: toIso(row.timestamp),
    payload: row,
  };
}

async function fetchSheets({ endpoint, apiToken, since }) {
  const url = new URL(endpoint);
  if (since) url.searchParams.set("since", since);
  url.searchParams.set("token", apiToken);

  const response = await fetch(url, {
    method: "GET",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10000),
  });
  const text = await response.text();
  if (!response.ok) {
    const error = new Error(`endpoint responded ${response.status}`);
    error.status = response.status;
    throw error;
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    const error = new Error("endpoint did not return valid JSON");
    error.noRetry = true;
    throw error;
  }

  const rows = Array.isArray(data) ? data : Array.isArray(data && data.transactions) ? data.transactions : null;
  if (!rows) {
    const error = new Error("endpoint response was neither an array nor { transactions: [...] }");
    error.noRetry = true;
    throw error;
  }
  return rows.map(toTransaction);
}

start("extractor", (app, ctx) => {
  const { config, log } = ctx;

  app.post("/extract", async (req, res) => {
    const body = req.body || {};
    let since;
    if (body.since !== undefined) {
      if (typeof body.since !== "string" || Number.isNaN(Date.parse(body.since))) {
        return sendError(res, 400, "invalid_request", "since must be an ISO 8601 timestamp");
      }
      since = new Date(body.since).toISOString();
    }

    const runId = crypto.randomUUID();
    try {
      const transactions = await withRetry(
        () => fetchSheets({ endpoint: config.sheets.endpoint, apiToken: config.sheets.apiToken, since }),
        {
          attempts: 3,
          label: "extractor: Google Sheets",
          shouldRetry: (err) => !err.noRetry && (err.status === undefined || err.status >= 500),
          onRetry: (err, attempt, delayMs) => log.warn("retry", { attempt, delay_ms: delayMs, message: err.message }),
        }
      );
      log.info("extract", { run_id: runId, rows: transactions.length });
      res.json({ run_id: runId, rows: transactions.length, transactions });
    } catch (err) {
      log.error("extract_failed", { run_id: runId, message: err.message });
      sendError(res, 500, "internal_error", `Google Sheets request failed: ${err.message}`);
    }
  });
});
