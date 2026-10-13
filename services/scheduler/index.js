// Scheduler service (serves /health on port 3006) - the pipeline orchestrator.
// Contract: docs/http-contract.md sections 2 and 5.
//
// On every ETL_CRON tick it runs the pipeline as an HTTP client with the
// contract's 10s timeout per call:
//   POST /extract -> POST /transform -> POST /load -> POST /notify
// threading the run_id from the extractor into the loader, and notifying the
// outcome on both success and failure.
//
// Every hop is retried (Issue 7): 3 attempts with exponential backoff,
// transport errors and 5xx only. Retrying POST /load is safe because the
// loader's INSERT OR IGNORE is idempotent per dedupe_hash; a retried /extract
// simply mints a fresh run_id.

"use strict";

const cron = require("node-cron");
const { start } = require("../shared/app");
const { withRetry } = require("../shared/retry");

start("scheduler", (app, ctx) => {
  const { config, log } = ctx;
  const base = (name) => `http://${config.host}:${config.services[name].port}`;

  async function post(name, route, payload) {
    return withRetry(
      async () => {
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
          throw new Error(`${name}${route} unreachable: ${err.message}`); // no status -> retried
        }
        const text = await response.text();
        let data;
        try {
          data = text ? JSON.parse(text) : {};
        } catch {
          const error = new Error(`${name}${route} returned malformed JSON`);
          error.noRetry = true;
          throw error;
        }
        if (!response.ok) {
          const envelope = data && data.error ? data.error.message : text;
          const error = new Error(`${name}${route} failed (${response.status}): ${envelope}`);
          error.status = response.status;
          throw error;
        }
        return data;
      },
      {
        attempts: 3,
        label: `scheduler->${name}${route}`,
        shouldRetry: (err) => !err.noRetry && (err.status === undefined || err.status >= 500),
        onRetry: (err, attempt, delayMs) =>
          log.warn("retry", { target: `${name}${route}`, attempt, delay_ms: delayMs, message: err.message }),
      }
    );
  }

  async function notify(subject, message) {
    try {
      await post("notifier", "/notify", { channel: "log", subject, body: message });
    } catch (err) {
      log.error("notify_failed", { message: err.message });
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
      log.info("pipeline_ok", {
        run_id: extracted.run_id,
        inserted: loaded.inserted,
        skipped: loaded.skipped_duplicates,
        rejected: transformed.rejected.length,
        duration_ms: Date.now() - startedAt,
      });
      await notify("ETL run completed", summary);
    } catch (err) {
      log.error("pipeline_failed", { message: err.message, duration_ms: Date.now() - startedAt });
      await notify("ETL run failed", err.message);
    }
  }

  if (!cron.validate(config.etlCron)) {
    log.error("invalid_cron", { cron: config.etlCron });
    process.exit(1);
  }
  cron.schedule(config.etlCron, () => {
    runPipeline();
  });
  log.info("cron_scheduled", { cron: config.etlCron });
});
