// Notifier service (port 3005) - POST /notify, GET /health.
// Contract: docs/http-contract.md section 5.
//
// Every notification is recorded in the notifications table. `log` always
// delivers (DB row + service log line); `email` and `webhook` are stubs that
// record and report delivered: false until a provider is configured (Issue 7+).
// A failed notification never blocks the pipeline.

"use strict";

const Database = require("better-sqlite3");
const { start, sendError } = require("../shared/app");

const CHANNELS = ["log", "email", "webhook"];

start("notifier", (app, ctx) => {
  const { config, log } = ctx;

  app.post("/notify", (req, res) => {
    const body = req.body || {};
    if (!CHANNELS.includes(body.channel)) {
      return sendError(res, 400, "invalid_request", `channel must be one of: ${CHANNELS.join(", ")}`);
    }
    if (typeof body.subject !== "string" || body.subject.trim() === "") {
      return sendError(res, 400, "invalid_request", "subject must be a non-empty string");
    }
    if (typeof body.body !== "string") {
      return sendError(res, 400, "invalid_request", "body must be a string");
    }

    let db;
    try {
      db = new Database(config.dbPath);
    } catch (err) {
      return sendError(res, 503, "not_ready", `database unavailable: ${err.message}`);
    }

    try {
      const info = db
        .prepare("INSERT INTO notifications (channel, subject, body, sent_at) VALUES (?, ?, ?, ?)")
        .run(body.channel, body.subject, body.body, new Date().toISOString());

      const delivered = body.channel === "log";
      log.info("notify", { channel: body.channel, subject: body.subject, delivered });

      res.json({ delivered, channel: body.channel, notification_id: info.lastInsertRowid });
    } catch (err) {
      log.error("notify_failed", { message: err.message });
      sendError(res, 500, "internal_error", `notification write failed: ${err.message}`);
    } finally {
      db.close();
    }
  });
});
