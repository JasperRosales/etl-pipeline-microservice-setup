// Tests for the configuration validator (services/shared/config.js). Each case
// loads config in a fresh process with an isolated environment.

"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const cron = require("node-cron");
const { isolatedEnv, runNode } = require("./helpers");

const LOAD = `const c = require("./services/shared/config"); console.log(JSON.stringify({ cron: c.etlCron, ports: Object.values(c.services).map(s => s.port), frozen: Object.isFrozen(c) }));`;

test("loads with only the required values and applies defaults", () => {
  const r = runNode(LOAD, isolatedEnv());
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.ports, [3001, 3002, 3003, 3004, 3005, 3006]);
  assert.equal(out.cron, "*/30 * * * * *");
  assert.equal(out.frozen, true);
});

test("default ETL_CRON is valid and fires every 30 seconds", () => {
  assert.equal(cron.validate("*/30 * * * * *"), true);
});

test("the ETL_CRON in .env.example is valid for node-cron", () => {
  const fs = require("fs");
  const line = fs.readFileSync(require.resolve("../.env.example"), "utf8").match(/^ETL_CRON=(.*)$/m);
  assert.ok(line, "ETL_CRON missing from .env.example");
  assert.equal(cron.validate(line[1].trim()), true);
});

test("CSV_PATH defaults to data/transactions.csv under the project root", () => {
  const code = `console.log(require("./services/shared/config").csvPath)`;
  const r = runNode(code, isolatedEnv({ CSV_PATH: "" }));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), require("path").join(__dirname, "..", "data", "transactions.csv"));
});

test("fails fast listing every bad port at once", () => {
  const r = runNode(LOAD, isolatedEnv({ PORT_EXTRACTOR: "80", PORT_LOADER: "x" }));
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /2 problem\(s\) found/);
});

for (const [value, label] of [["80", "privileged port"], ["70000", "too large"], ["30o1", "not a number"], ["3001.5", "not an integer"]]) {
  test(`rejects PORT_EXTRACTOR=${value} (${label})`, () => {
    const r = runNode(LOAD, isolatedEnv({ PORT_EXTRACTOR: value }));
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /PORT_EXTRACTOR must be an integer between 1024 and 65535/);
  });
}

test("accepts a custom port and trims whitespace", () => {
  const r = runNode(LOAD, isolatedEnv({ PORT_LOADER: " 4003 " }));
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).ports[2], 4003);
});

test("scheduler refuses to start with an invalid ETL_CRON", () => {
  const r = runNode(`require("./services/scheduler/index.js")`, isolatedEnv({ ETL_CRON: "every 30 seconds", SCHEDULER_PORT: "3399", LOG_DIR: require("os").tmpdir() }));
  assert.equal(r.status, 1);
  // Our own check, not node-cron's exception, must be what stops it.
  assert.match(r.stderr, /ERROR \[scheduler\] invalid_cron /);
  assert.match(r.stderr, /every 30 seconds/);
});
