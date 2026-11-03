// salsa-pos-api - source POS system for the S.A.L.S.A. ETL pipeline.
//
// Contract consumed by services/extractor (see docs/extractor.md):
//   GET /transactions?token=<API_TOKEN>[&since=<ISO 8601>]
//   -> 200 { "transactions": [ { id, amount, currency, timestamp, ... } ] }
//   -> 401 when the token is missing or wrong (extractor does not retry 4xx)
//   -> 400 when since is not a parseable date
//
// `since` is exclusive: only rows with timestamp > since are returned.
//
// Data lives in memory, loaded from data/seed.json at boot. POST /transactions
// (also used by the separate salsa-pos-ui app) appends a new sale; appended rows are lost on
// restart, which is fine for a demo source on Render's free plan (no
// persistent disk).

"use strict";

const path = require("path");
const { createApp } = require("./app");

const PORT = Number(process.env.PORT) || 10000;
const API_TOKEN = (process.env.API_TOKEN || "").trim();

if (!API_TOKEN) {
  console.error("API_TOKEN is required. Set it in the environment before starting salsa-pos-api.");
  process.exit(1);
}

const transactions = require(path.join(__dirname, "..", "data", "seed.json"));
const app = createApp({ token: API_TOKEN, transactions });

app.listen(PORT, "0.0.0.0", () => {
  console.log(`salsa-pos-api listening on :${PORT} with ${transactions.length} seeded transactions`);
});
