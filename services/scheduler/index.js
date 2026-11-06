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

  // Each hop's response must match the contract before the next hop uses it;
  // a mismatch fails the run (and is notified) instead of loading bad data.
  function contractError(route, message) {
    const error = new Error(`${route} broke the contract: ${message}`);
    error.noRetry = true;
    return error;
  }

  function checkExtract(d) {
    if (!d || typeof d.run_id !== "string" || d.run_id === "") throw contractError("extractor/extract", "run_id missing");
    if (!Array.isArray(d.transactions)) throw contractError("extractor/extract", "transactions is not an array");
    if (d.rows !== d.transactions.length) throw contractError("extractor/extract", `rows ${d.rows} != transactions.length ${d.transactions.length}`);
    if (d.rejected !== undefined && !Array.isArray(d.rejected)) throw contractError("extractor/extract", "rejected is not an array");
  }

  function checkTransform(d, sent) {
    if (!d || !Array.isArray(d.transactions) || !Array.isArray(d.rejected)) {
      throw contractError("transformer/transform", "transactions or rejected is not an array");
    }
    if (d.rows_in !== sent) throw contractError("transformer/transform", `rows_in ${d.rows_in} != ${sent} sent`);
    if (d.rows_out !== d.transactions.length || d.rows_in !== d.rows_out + d.rejected.length) {
      throw contractError("transformer/transform", "rows_in != rows_out + rejected.length");
    }
  }

  function checkLoad(d, sent) {
    if (!d || !Number.isInteger(d.inserted) || !Number.isInteger(d.skipped_duplicates)) {
      throw contractError("loader/load", "inserted or skipped_duplicates is not an integer");
    }
    if (d.inserted + d.skipped_duplicates !== sent) {
      throw contractError("loader/load", `inserted + skipped_duplicates != ${sent} sent`);
    }
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
    log.info("pipeline_start", {});
    try {
      const extracted = await post("extractor", "/extract", {});
      checkExtract(extracted);
      const runId = extracted.run_id;
      log.info("stage_ok", { run_id: runId, stage: "extract", rows: extracted.rows, rejected: (extracted.rejected || []).length });
      const transformed = await post("transformer", "/transform", { run_id: runId, transactions: extracted.transactions });
      checkTransform(transformed, extracted.transactions.length);
      log.info("stage_ok", { run_id: runId, stage: "transform", rows_in: transformed.rows_in, rows_out: transformed.rows_out, rejected: transformed.rejected.length });
      const loaded = await post("loader", "/load", {
        run_id: runId,
        transactions: transformed.transactions,
      });
      checkLoad(loaded, transformed.transactions.length);
      log.info("stage_ok", { run_id: runId, stage: "load", inserted: loaded.inserted, skipped_duplicates: loaded.skipped_duplicates });

      // CSV rows the extractor could not map count as rejected too.
      const allRejected = [...(extracted.rejected || []), ...transformed.rejected];
      const reasons = {};
      for (const r of allRejected) reasons[r.reason] = (reasons[r.reason] || 0) + 1;
      const reasonText = allRejected.length ? ` [${Object.entries(reasons).map(([k, v]) => `${k}: ${v}`).join(", ")}]` : "";
      const summary = `run ${extracted.run_id}: extracted ${extracted.rows}, loaded ${loaded.inserted}, duplicates ${loaded.skipped_duplicates}, rejected ${allRejected.length}${reasonText} (${Date.now() - startedAt}ms)`;
      log.info("pipeline_ok", {
        run_id: extracted.run_id,
        inserted: loaded.inserted,
        skipped: loaded.skipped_duplicates,
        rejected: allRejected.length,
        reasons,
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
  // At a 30-second cadence a slow run (10s timeouts x retries) can outlast the
  // interval; skip the tick instead of running two pipelines concurrently.
  let running = false;
  cron.schedule(config.etlCron, async () => {
    if (running) {
      log.warn("tick_skipped", { reason: "previous run still in progress" });
      return;
    }
    running = true;
    try {
      await runPipeline();
    } finally {
      running = false;
    }
  });
  log.info("cron_scheduled", { cron: config.etlCron });
});
