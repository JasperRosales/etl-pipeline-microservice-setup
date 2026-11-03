// Transformer service (port 3002) - POST /transform, GET /health.
// Contract: docs/http-contract.md sections 4 and 5.
//
// Pure logic, no I/O: validates each raw transaction, computes dedupe_hash
// (SHA-256 over source|external_id|amount_minor|currency|transaction_ts), and
// splits the batch into accepted (raw + dedupe_hash, nothing else changed) and
// rejected records with a reason code.
//
// Invariants: rows_in === rows_out + rejected.length, input is never mutated,
// in-batch duplicates are rejected here; duplicates against the database are
// the loader's job.

"use strict";

const { start } = require("../shared/app");
const { transformBatch } = require("./validate");

start("transformer", (app, ctx) => {
  const { sendError, log } = ctx;

  app.post("/transform", (req, res) => {
    const body = req.body || {};
    if (!Array.isArray(body.transactions)) {
      return sendError(res, 400, "invalid_request", "transactions must be an array");
    }

    const result = transformBatch(body.transactions);

    log.info("transform", {
      rows_in: result.rows_in,
      rows_out: result.rows_out,
      rejected: result.rejected.length,
    });

    res.json(result);
  });
});
