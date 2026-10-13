// Reporter service (port 3004) - GET /report/daily, GET /health.
// Contract: docs/http-contract.md section 5.
//
// Aggregates the transactions table for one UTC calendar day. An empty day is a
// valid report (zero counts + a warning), never an error.

"use strict";

const Database = require("better-sqlite3");
const { start, sendError } = require("../shared/app");

start("reporter", (app, ctx) => {
  const { config, log } = ctx;

  app.get("/report/daily", (req, res) => {
    const date = req.query.date;
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return sendError(res, 400, "invalid_request", "date is required and must be YYYY-MM-DD");
    }

    let db;
    try {
      db = new Database(config.dbPath, { readonly: true });
    } catch (err) {
      return sendError(res, 503, "not_ready", `database unavailable: ${err.message}`);
    }

    try {
      // transaction_ts is ISO 8601 UTC, so '<date>%' selects that UTC day.
      const row = db
        .prepare(
          `SELECT COUNT(*) AS transactions_count,
                  COALESCE(SUM(amount_minor), 0) AS sales_total_minor
           FROM transactions
           WHERE transaction_ts LIKE ?`
        )
        .get(`${date}%`);

      const warnings = row.transactions_count === 0 ? ["no transactions for this date"] : [];

      log.info("report", { date, transactions_count: row.transactions_count });

      res.json({
        date,
        generated_at: new Date().toISOString(),
        transactions_count: row.transactions_count,
        sales_total_minor: row.sales_total_minor,
        currency: "USD",
        data_quality: { loaded_rows: row.transactions_count, total_rows: row.transactions_count },
        warnings,
      });
    } catch (err) {
      log.error("report_failed", { date, message: err.message });
      sendError(res, 500, "internal_error", `report query failed: ${err.message}`);
    } finally {
      db.close();
    }
  });
});
