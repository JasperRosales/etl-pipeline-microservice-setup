// Shared HTTP bootstrap for every service (Issue 5, Day 5).
//
// Guarantees the common rules from docs/http-contract.md without repeating them:
//   - GET /health with the documented shape on every service
//   - JSON error envelope { "error": { "code", "message" } } for 400/404/500
//   - 5 MB JSON body limit; malformed JSON -> 400 invalid_request
//   - binds 127.0.0.1 only, one structured JSON startup line on stdout
//   - exits 1 with the readable config error (no stack) when .env is invalid

"use strict";

const express = require("express");
const path = require("path");

const pkg = require(path.join(__dirname, "..", "..", "package.json"));

function sendError(res, status, code, message) {
  if (res.headersSent) return;
  res.status(status).json({ error: { code, message } });
}

function loadConfig(serviceName) {
  try {
    return require("./config");
  } catch (err) {
    console.error(`[${serviceName}] ${err.message}`);
    process.exit(1);
  }
}

// routes(app, ctx) mounts the service's own endpoints. ctx = { config, sendError }.
function start(serviceName, routes) {
  const config = loadConfig(serviceName);
  const service = config.services[serviceName];
  const app = express();

  app.disable("x-powered-by");
  app.use(express.json({ limit: "5mb" }));

  const startedAt = Date.now();
  app.get("/health", (req, res) => {
    res.json({
      service: serviceName,
      status: "ok",
      version: pkg.version,
      uptime_s: Math.floor((Date.now() - startedAt) / 1000),
    });
  });

  routes(app, { config, sendError });

  // Error middleware (after routes so it catches their failures too).
  app.use((err, req, res, next) => {
    if (err && err.type === "entity.parse.failed") {
      return sendError(res, 400, "invalid_request", "request body is not valid JSON");
    }
    if (err && err.type === "entity.too.large") {
      return sendError(res, 413, "invalid_request", "request body exceeds the 5 MB limit");
    }
    console.error(JSON.stringify({ event: "error", service: serviceName, message: (err && err.message) || "unknown error" }));
    sendError(res, 500, "internal_error", "unexpected server error");
  });

  // Catch-all for unknown routes.
  app.use((req, res) => {
    sendError(res, 404, "not_found", `unknown route ${req.method} ${req.path}`);
  });

  const server = app.listen(service.port, config.host, () => {
    console.log(
      JSON.stringify({
        event: "startup",
        service: serviceName,
        host: config.host,
        port: service.port,
        version: pkg.version,
      })
    );
  });
  server.on("error", (err) => {
    console.error(
      JSON.stringify({ event: "startup_failed", service: serviceName, port: service.port, error: err.message })
    );
    process.exit(1);
  });

  return { app, server, config };
}

module.exports = { start, sendError };
