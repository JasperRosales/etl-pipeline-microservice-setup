// Reporter service (port 3004) - GET /report/daily, GET /report/activity, GET /health.
// Contract: docs/http-contract.md section 5.
//
// /report/daily aggregates the transactions table for one local calendar day
// (see day-range.js): totals plus per-store, per-payment-method and top-item
// breakdowns read from payload_json. An empty day is a valid report (zero
// counts + a warning), never an error.
//
// /report/activity returns the latest pipeline runs (etl_runs) and
// notifications (the scheduler records one per run, success or failure), so a
// dashboard can show what the pipeline has been doing.

"use strict";

const Database = require("better-sqlite3");
const { start, sendError } = require("../shared/app");
const { dayRange } = require("./day-range");

// julianday() compares instants, so rows stored as "...:00Z" and "...:00.000Z" both match.
const IN_DAY = "julianday(transaction_ts) >= julianday(@start) AND julianday(transaction_ts) < julianday(@end)";

const SQL = {
  totals: `SELECT COUNT(*) AS n, COALESCE(SUM(amount_minor), 0) AS total FROM transactions WHERE ${IN_DAY}`,
  currencies: `SELECT currency, COUNT(*) AS n FROM transactions WHERE ${IN_DAY} GROUP BY currency ORDER BY n DESC`,
  byStore: `SELECT COALESCE(json_extract(payload_json, '$.store_id'), 'unknown') AS store_id,
                   COUNT(*) AS transactions_count, SUM(amount_minor) AS sales_total_minor
            FROM transactions WHERE ${IN_DAY} GROUP BY 1 ORDER BY sales_total_minor DESC`,
  byPayment: `SELECT COALESCE(json_extract(payload_json, '$.payment_method'), 'unknown') AS payment_method,
                     COUNT(*) AS transactions_count, SUM(amount_minor) AS sales_total_minor
              FROM transactions WHERE ${IN_DAY} GROUP BY 1 ORDER BY sales_total_minor DESC`,
  topItems: `SELECT COALESCE(json_extract(item.value, '$.sku'), json_extract(item.value, '$.name')) AS sku,
                    MAX(json_extract(item.value, '$.name')) AS name,
                    SUM(json_extract(item.value, '$.qty')) AS qty,
                    CAST(ROUND(SUM(json_extract(item.value, '$.qty') * json_extract(item.value, '$.unit_price')) * 100) AS INTEGER) AS sales_total_minor
             FROM transactions, json_each(transactions.payload_json, '$.items') AS item
             WHERE ${IN_DAY} AND json_valid(payload_json)
             GROUP BY 1 ORDER BY qty DESC, sales_total_minor DESC LIMIT 5`,
  runs: `SELECT run_id, started_at, finished_at, status, rows_in, rows_out, error
         FROM etl_runs ORDER BY started_at DESC LIMIT ?`,
  notifications: `SELECT id, channel, subject, body, sent_at FROM notifications ORDER BY id DESC LIMIT ?`,
  loadedTotal: `SELECT COUNT(*) AS n, strftime('%Y-%m-%dT%H:%M:%SZ', MAX(created_at)) AS last_loaded_at FROM transactions`,
};

start("reporter", (app, ctx) => {
  const { config, log } = ctx;

  function withDb(res, fn) {
    let db;
    try {
      db = new Database(config.dbPath, { readonly: true, fileMustExist: true });
    } catch (err) {
      return sendError(res, 503, "not_ready", `database unavailable: ${err.message}`);
    }
    try {
      fn(db);
    } finally {
      db.close();
    }
  }

  // Rejects unknown or repeated query parameters (?date=a&date=b arrives as an
  // array) so a typo is a 400 instead of a silently different report.
  function queryProblem(query, allowed) {
    for (const [key, value] of Object.entries(query)) {
      if (!allowed.includes(key)) return `unknown query parameter "${key}" (allowed: ${allowed.join(", ")})`;
      if (typeof value !== "string") return `query parameter "${key}" must be given once`;
    }
    return null;
  }

  app.get("/report/daily", (req, res) => {
    const problem = queryProblem(req.query, ["date", "tz"]);
    if (problem) return sendError(res, 400, "invalid_request", problem);
    const date = req.query.date;
    const range = dayRange(date, req.query.tz);
    if (range.error) return sendError(res, 400, "invalid_request", range.error);

    withDb(res, (db) => {
      try {
        const p = { start: range.start, end: range.end };
        const totals = db.prepare(SQL.totals).get(p);
        const currencies = db.prepare(SQL.currencies).all(p);
        const warnings = [];
        if (totals.n === 0) warnings.push("no transactions for this date");
        if (currencies.length > 1) warnings.push(`mixed currencies: ${currencies.map((c) => c.currency).join(", ")}; totals add them together`);

        log.info("report", { date, tz: range.tz, transactions_count: totals.n });

        res.json({
          date,
          tz: range.tz,
          range: { start: range.start, end: range.end },
          generated_at: new Date().toISOString(),
          transactions_count: totals.n,
          sales_total_minor: totals.total,
          currency: currencies.length ? currencies[0].currency : null,
          data_quality: { loaded_rows: totals.n, total_rows: totals.n },
          by_store: db.prepare(SQL.byStore).all(p),
          by_payment: db.prepare(SQL.byPayment).all(p),
          top_items: db.prepare(SQL.topItems).all(p),
          warnings,
        });
      } catch (err) {
        log.error("report_failed", { date, message: err.message });
        sendError(res, 500, "internal_error", `report query failed: ${err.message}`);
      }
    });
  });

  app.get("/report/activity", (req, res) => {
    const problem = queryProblem(req.query, ["limit"]);
    if (problem) return sendError(res, 400, "invalid_request", problem);
    // Digits only: Number() would also accept "0x10", "1e1" and " 5".
    const raw = req.query.limit === undefined ? 20 : /^\d{1,3}$/.test(req.query.limit) ? Number(req.query.limit) : NaN;
    if (!Number.isInteger(raw) || raw < 1 || raw > 100) {
      return sendError(res, 400, "invalid_request", "limit must be an integer between 1 and 100");
    }
    withDb(res, (db) => {
      try {
        const loaded = db.prepare(SQL.loadedTotal).get();
        res.json({
          generated_at: new Date().toISOString(),
          loaded_transactions: loaded.n,
          last_loaded_at: loaded.last_loaded_at,
          runs: db.prepare(SQL.runs).all(raw),
          notifications: db.prepare(SQL.notifications).all(raw),
        });
      } catch (err) {
        log.error("activity_failed", { message: err.message });
        sendError(res, 500, "internal_error", `activity query failed: ${err.message}`);
      }
    });
  });
});
