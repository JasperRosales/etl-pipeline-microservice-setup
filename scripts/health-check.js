// Polls GET /health on every service (Issue 6, Day 6).
//
//   node scripts/health-check.js            one round, then exit
//   node scripts/health-check.js --wait 15  retry for up to 15s until all are up
//
// Exit 0 when every service answers /health with HTTP 200, exit 1 otherwise.
// start-etl.ps1 uses --wait for its readiness check; `npm run health` runs a
// single round. One line per service: OK/DOWN, name, endpoint, detail.
//
//   OK   extractor    127.0.0.1:3001  v0.1.0, up 42s

"use strict";

let config;
try {
  config = require("../services/shared/config");
} catch (err) {
  console.error(`[health] ${err.message}`);
  process.exit(1);
}

// Probes use node:http with agent:false (no keep-alive sockets) on purpose:
// exiting while undici's pooled sockets are closing triggers a libuv
// assertion on Windows (verified), and this script exits after every run.
const http = require("http");

const waitArg = process.argv.indexOf("--wait");
const waitSeconds = waitArg >= 0 ? Number(process.argv[waitArg + 1]) : 0;

function probe(service) {
  return new Promise((resolve) => {
    const endpoint = `${config.host}:${service.port}`;
    const req = http.get(
      { host: config.host, port: service.port, path: "/health", agent: false, timeout: 2000 },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (raw += chunk));
        res.on("end", () => {
          let body = {};
          try {
            body = JSON.parse(raw);
          } catch {
            /* non-JSON body handled below via status */
          }
          if (res.statusCode === 200) {
            resolve({ name: service.name, endpoint, ok: true, detail: `v${body.version || "?"}, up ${body.uptime_s ?? "?"}s` });
          } else {
            resolve({
              name: service.name,
              endpoint,
              ok: false,
              detail: `HTTP ${res.statusCode}${body.error ? " " + body.error.code : ""}`,
            });
          }
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (err) => resolve({ name: service.name, endpoint, ok: false, detail: err.code || err.message }));
  });
}

function round() {
  return Promise.all(Object.values(config.services).map(probe));
}

(async () => {
  const deadline = Date.now() + (Number.isFinite(waitSeconds) ? waitSeconds : 0) * 1000;
  let results = await round();
  while (deadline > Date.now() && results.some((r) => !r.ok)) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    results = await round();
  }

  for (const r of results) {
    console.log(`${r.ok ? "OK  " : "DOWN"} ${r.name.padEnd(11)} ${r.endpoint.padEnd(15)} ${r.detail}`);
  }
  const up = results.filter((r) => r.ok).length;
  console.log(`[health] ${up}/${results.length} services healthy`);
  process.exit(up === results.length ? 0 : 1);
})();
