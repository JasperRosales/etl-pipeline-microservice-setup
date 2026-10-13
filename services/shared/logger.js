// Structured JSON-lines logging for every service (Issue 7, Day 7).
//
// Each service gets one file per run stream: logs/<service>.jsonl with one
// JSON object per line, mirrored to the console so the .out.log / .err.log
// capture from start-etl.ps1 stays useful for a quick look.
//
//   const log = createLogger("loader", config.logDir);
//   log.info("load", { run_id, inserted, skipped_duplicates });
//   log.error("load_failed", { run_id, message: err.message });
//
// Logging must never take a service down: file write failures are swallowed.

"use strict";

const fs = require("fs");
const path = require("path");

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
    if (level === "error") console.error(line);
    else console.log(line);
  }

  return {
    file,
    info: (event, fields = {}) => write("info", event, fields),
    warn: (event, fields = {}) => write("warn", event, fields),
    error: (event, fields = {}) => write("error", event, fields),
  };
}

module.exports = { createLogger };
