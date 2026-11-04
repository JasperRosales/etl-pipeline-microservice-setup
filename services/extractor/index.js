// Extractor service (port 3001) - POST /extract, GET /health.
// Contract: docs/http-contract.md section 5.
//
// Reads the POS transactions CSV at CSV_PATH (default ./data/transactions.csv),
// normalizes the rows into the raw Transaction shape, and mints the run_id
// that the scheduler threads through the pipeline into POST /load.
//
// The file is read fresh on every request, so rows appended between runs are
// picked up by the next run; already-loaded rows are skipped by the loader's
// dedupe_hash. CSV format: services/extractor/csv.js.
// Rows that do not normalize cleanly are passed through; the transformer rejects
// them with a reason (that is the contract's division of labor). The one
// exception is a row with the wrong number of cells: its values cannot be
// trusted to be in the right columns, so it is returned in `rejected`.

"use strict";

const crypto = require("crypto");
const { start, sendError } = require("../shared/app");
const { readCsvRows, filterSince } = require("./csv");
const { toTransaction } = require("./normalize");

start("extractor", (app, ctx) => {
  const { config, log } = ctx;

  app.post("/extract", async (req, res) => {
    const body = req.body || {};
    const unknown = Object.keys(body).filter((k) => k !== "since");
    if (unknown.length) {
      return sendError(res, 400, "invalid_request", `unknown field(s): ${unknown.join(", ")}`);
    }
    let since;
    if (body.since !== undefined) {
      if (typeof body.since !== "string" || Number.isNaN(Date.parse(body.since))) {
        return sendError(res, 400, "invalid_request", "since must be an ISO 8601 timestamp");
      }
      since = new Date(body.since).toISOString();
    }

    const runId = crypto.randomUUID();
    try {
      const { rows, rejected } = readCsvRows(config.csvPath);
      const transactions = filterSince(rows, since).map(toTransaction);
      if (rejected.length) log.warn("extract_rejected", { run_id: runId, rejected });
      log.info("extract", { run_id: runId, rows: transactions.length, rejected: rejected.length, file: config.csvPath });
      res.json({ run_id: runId, rows: transactions.length, transactions, rejected });
    } catch (err) {
      log.error("extract_failed", { run_id: runId, message: err.message });
      sendError(res, 500, "internal_error", `CSV extract failed: ${err.message}`);
    }
  });
});
