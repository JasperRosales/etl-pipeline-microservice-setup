# Extractor Feature

## Instructions

The extractor fetches source rows from the configured Google Apps Script or
Google Sheets endpoint, maps them to raw transaction records, and creates the
`run_id` used to trace the batch. It is configured through the shared `.env`
file and is called by the scheduler or directly with `POST /extract`.

1. Copy `.env.example` to `.env` in the microservice project root.
2. Set the required `SHEETS_ENDPOINT` and `API_TOKEN` values.
3. Start the services with `.\start-etl.ps1` from the microservice project.
4. Let the scheduler trigger the service or call `POST /extract` on port 3001.
5. Review the response's `run_id`, `rows`, and `transactions`.

An optional `since` request field is accepted. When supplied, it must be a
string accepted by JavaScript's date parser; it is normalized to ISO 8601 UTC
before being sent upstream. No default date window is applied when it is
omitted.

## Architecture

The implementation is in `services/extractor/index.js`. It uses the shared
Express bootstrap (`services/shared/app.js`) for the health route, request
handling, and common error responses; shared configuration
(`services/shared/config.js`) for the endpoint, token, host, and port; and the
shared retry helper (`services/shared/retry.js`) for transient upstream errors.

The service sends a GET request to the configured upstream URL, including
`since` when supplied and the API token in the `token` query parameter. It
accepts a JSON array or an object containing a `transactions` array, maps each
row, and returns the results. It does not write to SQLite or call the other ETL
services itself.

## Tech Stack

- Node.js 
- Express.js
- Native `fetch`, `URL`, `AbortSignal.timeout`, and `crypto.randomUUID`
- `dotenv` through the shared configuration module
- Shared exponential-backoff retry helper
- JSON over local HTTP

## Process

1. The caller sends `POST /extract` with an optional `since` field to port 3001.
2. The service validates `since` if present and normalizes it to UTC.
3. It creates a UUID v4 `run_id`.
4. It issues a GET to `SHEETS_ENDPOINT`, passing `since` when present and
   `API_TOKEN` as a `token` query parameter. The request timeout is 10 seconds.
5. It retries transient transport errors and upstream 5xx responses up to
   three attempts with exponential backoff. Upstream 4xx responses and
   malformed successful response bodies are not retried.
6. It requires the successful response to be valid JSON in array form or
   `{ "transactions": [...] }` form.
7. It maps each source row into the raw transaction shape and responds with
   `{ run_id, rows, transactions }`.

The row mapping uses source `id` as a string `external_id` when present,
`google-sheets` as `source`, source `amount` converted to rounded integer
cents as `amount_minor`, and the uppercased source currency or `USD` as
`currency`. A parseable source `timestamp` becomes ISO 8601 UTC
`transaction_ts`; the original row is retained as `payload`. The extractor
does not reject malformed individual rows; the transformer validates them.

## Data Flow

The upstream endpoint returns source rows. The extractor maps these into
canonical raw transaction objects and returns them with a new `run_id`. The
scheduler forwards the transactions to the transformer and carries the same
`run_id` to the loader. The extractor is stateless between requests and does
not persist data.

## Service Documentation

### Extractor Service

- **Purpose:** Fetch source transaction rows and map them to the raw ETL
  transaction shape.
- **Responsibilities:** Validate the optional `since` value, call the
  configured upstream endpoint, validate its response envelope, map rows, and
  assign a run identifier.
- **Inputs:** Optional `{ "since": "..." }` request body plus `SHEETS_ENDPOINT`
  and `API_TOKEN` configuration.
- **Outputs:** `{ run_id, rows, transactions }`; each transaction contains
  `external_id`, `source`, `amount_minor`, `currency`, `transaction_ts`, and
  `payload` where source data permits.
- **Dependencies:** Google Apps Script or Sheets-compatible HTTP endpoint,
  API token, shared config, shared app, and retry helper.
- **Interactions:** Called by the scheduler; returns raw transactions for the
  transformer and a `run_id` later passed to the loader.
