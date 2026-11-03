// Test helpers: spawn a real service on a throwaway port with an isolated
// environment (no .env, temp DB and log dir), and a tiny JSON HTTP client.

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

const projectRoot = path.resolve(__dirname, "..");

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Base env for every child: never read the developer's real .env.
function isolatedEnv(overrides = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(PORT_|SCHEDULER_PORT|DB_PATH|LOG_DIR|ETL_CRON|SHEETS_ENDPOINT|APPS_SCRIPT_URL|API_TOKEN)/.test(key)) delete env[key];
  }
  return {
    ...env,
    ETL_ENV_FILE: path.join(os.tmpdir(), "etl-test-no-such.env"),
    SHEETS_ENDPOINT: "http://127.0.0.1:9/never-called",
    API_TOKEN: "test-token",
    ...overrides,
  };
}

// Runs `node -e <code>` in the project root and returns { status, stdout, stderr }.
function runNode(code, env) {
  return spawnSync(process.execPath, ["-e", code], { cwd: projectRoot, env, encoding: "utf8" });
}

async function request(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    /* leave null */
  }
  return { status: res.status, data };
}

let nextPort = 3400 + Math.floor(Math.random() * 400);

// Starts services/<name>/index.js and resolves once /health answers.
async function startService(name, envOverrides = {}) {
  const port = nextPort++;
  const portVar = name === "scheduler" ? "SCHEDULER_PORT" : `PORT_${name.toUpperCase()}`;
  const logDir = tempDir(`etl-test-logs-${name}-`);
  const env = isolatedEnv({ LOG_DIR: logDir, [portVar]: String(port), ...envOverrides });
  const child = spawn(process.execPath, [path.join(projectRoot, "services", name, "index.js")], {
    cwd: projectRoot,
    env,
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d));

  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`${name} exited early: ${stderr}`);
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 50));
    if (i === 99) throw new Error(`${name} did not become healthy: ${stderr}`);
  }
  return {
    base,
    stop: () =>
      new Promise((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once("exit", resolve);
        child.kill();
      }),
  };
}

module.exports = { projectRoot, tempDir, isolatedEnv, runNode, request, startService };
