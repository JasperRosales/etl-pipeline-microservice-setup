// Structured JSON-lines logging for every service (Issue 7, Day 7).
//
// Each service gets one file per run stream: logs/<service>.jsonl with one
// JSON object per line. Every event is also printed to the console as one
// readable line, which is what the .out.log / .err.log capture from
// start-etl.ps1 (and npm run start:<service>) shows:
//
//   2026-11-04 05:52:08Z INFO  [transformer] transform run_id=b3f1 rows_in=23 rows_out=2 rejected=21
//
//   const log = createLogger("loader", config.logDir);
//   log.info("load", { run_id, inserted, skipped_duplicates });
//   log.error("load_failed", { run_id, message: err.message });
//
// Logging must never take a service down: file write failures are swallowed.

"use strict";

const fs = require("fs");
const path = require("path");

function formatValue(v) {
  if (typeof v === "string") return /^[^\s"=]+$/.test(v) ? v : JSON.stringify(v);
  return JSON.stringify(v);
}

function consoleLine(level, event, fields, serviceName) {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19) + "Z";
  const kv = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${formatValue(v)}`)
    .join(" ");
  return `${ts} ${level.toUpperCase().padEnd(5)} [${serviceName}] ${event}${kv ? " " + kv : ""}`;
}

function createLogger(serviceName, logDir) {
  fs.mkdirSync(logDir, { recursive: true });
  const file = path.join(logDir, `${serviceName}.jsonl`);

  function write(level, event, fields) {
    const line = JSON.stringify({ ts: new Date().toISOString(), service: serviceName, level, event, ...fields });
    try {
      fs.appendFileSync(file, line + "\n");
    } catch {
      // Never fail a request because the log file could not be written.
    }
    const text = consoleLine(level, event, fields, serviceName);
    if (level === "error") console.error(text);
    else console.log(text);
  }

  return {
    file,
    info: (event, fields = {}) => write("info", event, fields),
    warn: (event, fields = {}) => write("warn", event, fields),
    error: (event, fields = {}) => write("error", event, fields),
  };
}

module.exports = { createLogger };
