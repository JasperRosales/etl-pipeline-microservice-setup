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
const MAX_SUBJECT = 200;
const MAX_BODY = 10_000;
const FIELDS = new Set(["channel", "subject", "body"]);
// eslint-disable-next-line no-control-regex
const SUBJECT_CONTROL = /[\u0000-\u001f\u007f]/; // one line, no control characters
// eslint-disable-next-line no-control-regex
const BODY_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/; // tabs and line breaks allowed

start("notifier", (app, ctx) => {
  const { config, log } = ctx;

  app.post("/notify", (req, res) => {
    const body = req.body || {};
    const unknown = Object.keys(body).filter((k) => !FIELDS.has(k));
    if (unknown.length) {
      return sendError(res, 400, "invalid_request", `unknown field(s): ${unknown.join(", ")}`);
    }
    if (!CHANNELS.includes(body.channel)) {
      return sendError(res, 400, "invalid_request", `channel must be one of: ${CHANNELS.join(", ")}`);
    }
    if (typeof body.subject !== "string" || body.subject.trim() === "") {
      return sendError(res, 400, "invalid_request", "subject must be a non-empty string");
    }
    if (typeof body.body !== "string") {
      return sendError(res, 400, "invalid_request", "body must be a string");
    }
    if (body.subject.length > MAX_SUBJECT) {
      return sendError(res, 400, "invalid_request", `subject must be at most ${MAX_SUBJECT} characters`);
    }
    if (body.body.length > MAX_BODY) {
      return sendError(res, 400, "invalid_request", `body must be at most ${MAX_BODY} characters`);
    }
    if (SUBJECT_CONTROL.test(body.subject)) {
      return sendError(res, 400, "invalid_request", "subject must be a single line without control characters");
    }
    if (BODY_CONTROL.test(body.body)) {
      return sendError(res, 400, "invalid_request", "body must not contain control characters other than tabs and line breaks");
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
      log.info("notify", {
        notification_id: Number(info.lastInsertRowid),
        channel: body.channel,
        delivered,
        subject: body.subject,
        body: body.body,
      });

      res.json({ delivered, channel: body.channel, notification_id: info.lastInsertRowid });
    } catch (err) {
      log.error("notify_failed", { message: err.message });
      sendError(res, 500, "internal_error", `notification write failed: ${err.message}`);
    } finally {
      db.close();
    }
  });
});
