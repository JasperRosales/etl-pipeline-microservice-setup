// Loader service (port 3003) - POST /load, GET /health.
// Contract: docs/http-contract.md section 5.
//
// Validates every transformed transaction (store.js), then writes them with
// INSERT OR IGNORE keyed on dedupe_hash (README section 9 duplicate
// protection) inside one transaction and upserts the etl_runs row for the
// run_id. INSERT OR IGNORE is idempotent, which is what makes retried
// POST /load calls (Issue 7) safe.

"use strict";

const Database = require("better-sqlite3");
const { start, sendError } = require("../shared/app");
const { loadRequestProblem, loadBatch } = require("./store");

start("loader", (app, ctx) => {
  const { config, log } = ctx;

  app.post("/load", (req, res) => {
    const body = req.body || {};
    const problem = loadRequestProblem(body);
    if (problem) return sendError(res, 400, "invalid_request", problem);

    let db;
    try {
      db = new Database(config.dbPath);
    } catch (err) {
      return sendError(res, 503, "not_ready", `database unavailable: ${err.message}`);
    }

    try {
      const result = loadBatch(db, body.run_id, body.transactions);
      log.info("load", { run_id: body.run_id, inserted: result.inserted, skipped_duplicates: result.skipped_duplicates });
      res.json(result);
    } catch (err) {
      log.error("load_failed", { run_id: body.run_id, message: err.message });
      sendError(res, 500, "internal_error", `database write failed: ${err.message}`);
    } finally {
      db.close();
    }
  });
});
