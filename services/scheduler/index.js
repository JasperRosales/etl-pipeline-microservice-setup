// Scheduler service (serves /health on port 3006) - the pipeline orchestrator.
// Contract: docs/http-contract.md sections 2 and 5.
//
// On every ETL_CRON tick it runs the pipeline as an HTTP client with the
// contract's 10s timeout per call:
//   POST /extract -> POST /transform -> POST /load -> POST /notify
// threading the run_id from the extractor into the loader, and notifying the
// outcome on both success and failure.

"use strict";

const cron = require("node-cron");
const { start } = require("../shared/app");

start("scheduler", (app, ctx) => {
  const { config } = ctx;
  const base = (name) => `http://${config.host}:${config.services[name].port}`;

  async function post(name, route, payload) {
    const url = `${base(name)}${route}`;
    let response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000),
      });
    } catch (err) {
      throw new Error(`${name}${route} unreachable: ${err.message}`);
    }
    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    if (!response.ok) {
      const envelope = data && data.error ? data.error.message : text;
      throw new Error(`${name}${route} failed (${response.status}): ${envelope}`);
    }
    return data;
  }

  async function notify(subject, message) {
    try {
      await post("notifier", "/notify", { channel: "log", subject, body: message });
    } catch (err) {
      console.error(JSON.stringify({ event: "notify_failed", service: "scheduler", message: err.message }));
    }
  }

  async function runPipeline() {
    const startedAt = Date.now();
    try {
      const extracted = await post("extractor", "/extract", {});
      const transformed = await post("transformer", "/transform", { transactions: extracted.transactions });
      const loaded = await post("loader", "/load", {
        run_id: extracted.run_id,
        transactions: transformed.transactions,
      });

      const summary = `run ${extracted.run_id}: extracted ${extracted.rows}, loaded ${loaded.inserted}, duplicates ${loaded.skipped_duplicates}, rejected ${transformed.rejected.length} (${Date.now() - startedAt}ms)`;
      console.log(JSON.stringify({ event: "pipeline_ok", service: "scheduler", run_id: extracted.run_id, inserted: loaded.inserted, skipped: loaded.skipped_duplicates, rejected: transformed.rejected.length }));
      await notify("ETL run completed", summary);
    } catch (err) {
      console.error(JSON.stringify({ event: "pipeline_failed", service: "scheduler", message: err.message, duration_ms: Date.now() - startedAt }));
      await notify("ETL run failed", err.message);
    }
  }

  if (!cron.validate(config.etlCron)) {
    console.error(`[scheduler] ETL_CRON is not a valid cron expression: "${config.etlCron}"`);
    process.exit(1);
  }
  cron.schedule(config.etlCron, () => {
    runPipeline();
  });
  console.log(JSON.stringify({ event: "cron_scheduled", service: "scheduler", cron: config.etlCron }));
});
