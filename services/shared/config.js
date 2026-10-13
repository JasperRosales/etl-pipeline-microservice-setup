// Single source of configuration for all six services (Issue 2, Day 2).
//
// - Loads .env from the project root (dotenv), applying the defaults below.
// - Fails fast with ONE readable error when a required value is missing or a
//   port is malformed, so services never start half-configured.
// - Never logs or exposes secrets beyond what is exported here.
//
// Usage in a service entry point:
//   const config = require("../shared/config");
//   app.listen(config.services.extractor.port, config.host);

"use strict";

const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");

const projectRoot = path.resolve(__dirname, "..", "..");
const envFile = process.env.ETL_ENV_FILE || path.join(projectRoot, ".env");

if (fs.existsSync(envFile)) {
  // quiet: true keeps dotenv's banner out of the per-service stdout logs.
  dotenv.config({ path: envFile, quiet: true });
}

const problems = [];

// Integer port between 1024 and 65535, or the fallback.
function port(name, fallback) {
  const raw = (process.env[name] || "").trim();
  if (raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1024 || value > 65535) {
    problems.push(`${name} must be an integer between 1024 and 65535 (got "${raw}").`);
    return fallback;
  }
  return value;
}

// Must be present in .env (or the process environment).
function required(name, hint) {
  const raw = (process.env[name] || "").trim();
  if (raw === "") {
    problems.push(`${name} is required${hint ? ` (${hint})` : ""}.`);
    return "";
  }
  return raw;
}

// Present value or fallback.
function optional(name, fallback) {
  const raw = (process.env[name] || "").trim();
  return raw === "" ? fallback : raw;
}

// Paths are resolved against the project root so services can be started
// from any working directory.
function fromRoot(p) {
  return path.resolve(projectRoot, p);
}

const config = {
  projectRoot,
  envFile,
  envLoaded: fs.existsSync(envFile),
  host: "127.0.0.1",
  services: {
    extractor: { name: "extractor", port: port("PORT_EXTRACTOR", 3001) },
    transformer: { name: "transformer", port: port("PORT_TRANSFORMER", 3002) },
    loader: { name: "loader", port: port("PORT_LOADER", 3003) },
    reporter: { name: "reporter", port: port("PORT_REPORTER", 3004) },
    notifier: { name: "notifier", port: port("PORT_NOTIFIER", 3005) },
    scheduler: { name: "scheduler", port: port("SCHEDULER_PORT", 3006) },
  },
  dbPath: fromRoot(optional("DB_PATH", "./data/pos.db")),
  logDir: fromRoot(optional("LOG_DIR", "./logs")),
  etlCron: optional("ETL_CRON", "*/15 * * * *"),
  sheets: {
    endpoint: required("SHEETS_ENDPOINT", "Apps Script Web App or Sheets API URL"),
    appsScriptUrl: optional("APPS_SCRIPT_URL", ""),
    apiToken: required("API_TOKEN", "token sent with each extractor request"),
  },
};

if (problems.length > 0) {
  const where = fs.existsSync(envFile) ? envFile : `${envFile} (missing)`;
  throw new Error(
    `Invalid ETL configuration, ${problems.length} problem(s) found:\n` +
      problems.map((p) => `  - ${p}`).join("\n") +
      `\nFix ${where}. Copy .env.example to .env in the project root to start.`
  );
}

module.exports = Object.freeze(config);
