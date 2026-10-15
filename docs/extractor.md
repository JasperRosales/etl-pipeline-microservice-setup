# Stage 1: Data Extraction Plan — S.A.L.S.A. Pipeline

**Pipeline Name:** S.A.L.S.A. (Sales Acquisition, Loading, Storage & Analytics)  
**Members:** Jasper Rosales, Iladio Mendoza, Agquiz Nino Joseph  
**Section:** BSIT-BA-4101

---

## 1. Data Source and Extraction Specification

- **Source System:** A Google Apps Script Web App or Google Sheets-compatible HTTP endpoint that provides transaction rows.
- **Source Database or File:** JSON returned by the URL configured in `SHEETS_ENDPOINT`; the endpoint may return a JSON array or an object containing a `transactions` array.
- **Extraction Method:** The Node.js extractor service exposes `POST /extract` on port 3001. It calls the configured endpoint with HTTP `GET`, sends `API_TOKEN` as the `token` query parameter, and optionally passes a normalized `since` value. Each upstream request has a 10-second timeout.
- **Schedule and Invocation:** The extractor does not schedule itself. It is called by the scheduler service according to `ETL_CRON` (default: every 15 minutes), or can be called directly.
- **Extraction Scope:** Source transaction rows returned by the endpoint. An optional `since` request value limits the upstream query; no default date window is applied when it is omitted.
- **Source Limitations and Assumptions:** `SHEETS_ENDPOINT` and `API_TOKEN` must be configured. The upstream endpoint must be reachable and return valid JSON in one of the supported response shapes.

---

## 2. Source Tables and Column Specification

### Upstream Transaction Rows

The endpoint returns JSON transaction row objects. The upstream field values are supplied by the endpoint; the extractor does not read a CSV file or extract a separate products table.

| Source Field | Purpose | Expected Value |
|---|---|---|
| `id` | Identifies the source transaction | Any value converted to a string when present; omitted when missing or `null`. |
| `amount` | Supplies the transaction amount | A value convertible to a number; malformed values are passed through as invalid minor-unit amounts for downstream validation. |
| `currency` | Supplies the transaction currency | A non-empty string when available; otherwise the extractor uses `USD`. |
| `timestamp` | Supplies the transaction time | A string or number parseable as a JavaScript date; otherwise the normalized timestamp is omitted. |

### Raw Transaction Output

The extractor maps each source row into the raw transaction shape used by the next ETL stage.

| Column | Data Type | Key / Relationship |
|---|---|---|
| `external_id` | `STRING` or omitted | Source `id` converted to a string; downstream validation requires a usable identifier. |
| `source` | `STRING` | Constant value `google-sheets`. |
| `amount_minor` | `INTEGER` or invalid numeric value | Source `amount` multiplied by 100 and rounded; validated by the transformer. |
| `currency` | `STRING` | Uppercased source currency or default `USD`. |
| `transaction_ts` | ISO 8601 UTC `STRING` or omitted | Normalized from source `timestamp` when parseable; validated by the transformer. |
| `payload` | `OBJECT` | Original source row preserved for traceability. |

**Output:** `{ "run_id": "...", "rows": 0, "transactions": [] }`. `rows` equals the number of mapped transactions returned. Raw transactions are passed to the transformer for validation and cleanup.

---

## 3. Extraction Validation and Data Quality Checks

| Check Name | Target | Purpose | Validation Criteria |
|---|---|---|---|
| Optional `since` validation | `POST /extract` request body | Prevents an invalid date filter from being sent upstream. | If provided, `since` must be a string accepted by JavaScript's date parser; it is normalized to ISO 8601 UTC. |
| Upstream response validation | Successful endpoint response | Ensures the response can be read as supported transaction rows. | Body must be valid JSON containing either an array or a `transactions` array. |
| Row-level data validation | Individual source rows | Keeps extraction separate from transaction validation. | The extractor maps rows but does not reject malformed records or check duplicates; the transformer performs row validation and in-batch deduplication. |

---

## 4. Extraction Metadata and Log Specification

| Field Name | Purpose | Example Value / Format |
|---|---|---|
| Pipeline run ID | UUID v4 created for the extraction request and used to trace the batch | `b3f1...` |
| Source row count | Number of mapped transactions returned by the extractor | `rows: 2` |
| Returned transactions | Raw transaction records handed to the next stage | `transactions: [...]` |
| Extraction status | Indicates whether the extraction request succeeded or failed | HTTP 200 response or error response |
| Successful extraction log | Records the run identifier and row count | `extract` event with `run_id` and `rows` |
| Retry log | Records a retry attempt and delay for a transient upstream failure | `retry` event with `attempt` and `delay_ms` |
| Error log | Records the run identifier and error message when extraction fails | `extract_failed` event |

The extractor does not report source rows read, rejected-row counts, validation summaries, or extraction duration. Those are not part of its current response/log metadata.

---

## 5. Log Retention and Access

- **Storage Location:** Shared service logs are written under the configured `LOG_DIR` (default: `logs`) and mirrored to the console.
- **Retention, Archiving, and Access:** The extractor does not configure retention periods, archiving, or access controls. These must be managed by the deployment or operations environment.

---

## 6. Extraction Data Contract and Naming Convention

- **Required Schema:** Each mapped row follows the raw transaction contract: `external_id`, `source`, `amount_minor`, `currency`, `transaction_ts`, and `payload`. Fields with no valid source value may be omitted or remain invalid for transformer validation.
- **Naming Convention:** Output fields use `snake_case`. `amount_minor` represents rounded integer cents; parseable timestamps are ISO 8601 UTC strings.
- **Source Envelope:** The upstream response must be a JSON array or `{ "transactions": [...] }`. The original source row is retained in `payload`.

### Source-to-Standardized Field Mappings

| Source Column | Standardized Column | Source Type | Target Type | Mapping Type |
|---|---|---|---|---|
| `id` | `external_id` | Any JSON value | `STRING` | Convert to string when present |
| — | `source` | — | `STRING` | Constant `google-sheets` |
| `amount` | `amount_minor` | Numeric or numeric string | `INTEGER` cents | Multiply by 100 and round |
| `currency` | `currency` | `STRING` | `STRING` | Uppercase; default to `USD` when empty or absent |
| `timestamp` | `transaction_ts` | String or number | ISO 8601 UTC `STRING` | Parse and normalize; omit if invalid |
| Entire source row | `payload` | JSON object | JSON object | Preserve original row |

---

## 7. Extraction Acceptance and Handover Rules

| Overall Condition | Acceptance Decision | Pipeline Action |
|---|---|---|
| The upstream call succeeds and returns a supported JSON envelope | **ACCEPTED** | Return `{ run_id, rows, transactions }` to the caller. |
| A row contains missing or invalid transaction fields | **EXTRACTED, THEN VALIDATED DOWNSTREAM** | Return the mapped row; the transformer validates it and records any rejection. |
| `since` is invalid | **FAILED** | Return HTTP 400 (`invalid_request`); the scheduler stops the current pipeline run and handles the failure. |
| The upstream call fails after retries | **FAILED** | Return HTTP 500 (`internal_error`); the scheduler stops the current pipeline run and handles the failure. |

### Validation Summary

- Optional `since` request validation: **PASS** when omitted or valid; otherwise the request is rejected.
- Upstream response validation: **PASS** when the body is valid JSON in a supported array format; otherwise extraction fails.
- Individual row validation and in-batch duplicate checking: **DEFERRED TO THE TRANSFORMER**.

**Handover:** The scheduler sends the returned transactions to the transformer and carries the same `run_id` through to the loader. The extractor does not write to the database or invoke downstream services itself.

---

## 8. Common Extraction Problems and Mitigation

### Problem 1: Upstream Endpoint Unavailable or Returning Server Errors

- **Problem Description:** The configured endpoint cannot be reached or responds with an HTTP 5xx status.
- **Possible Cause:** Network interruption, unavailable upstream service, or temporary server failure.
- **Impact on Extraction Process:** The extractor cannot retrieve rows for the current request.
- **Proposed Solution / Mitigation:** Retry transport errors and 5xx responses up to three attempts using exponential backoff. If all attempts fail, return an error and log the failure.

### Problem 2: Invalid Upstream Response

- **Problem Description:** A successful upstream response is not valid JSON or does not contain an array of rows in a supported envelope.
- **Possible Cause:** The endpoint returns an error page, malformed JSON, or an unexpected response structure.
- **Impact on Extraction Process:** The extractor cannot map the response into raw transaction records.
- **Proposed Solution / Mitigation:** Fail the request without retrying deterministic malformed-response errors; log the failure for investigation.

### Problem 3: Invalid or Duplicate Transaction Rows

- **Problem Description:** A source row has missing or invalid transaction fields, or duplicates another row in the batch.
- **Possible Cause:** Missing or malformed values in the source data, or repeated source rows.
- **Impact on Extraction Process:** The extractor returns mapped rows without rejecting them; invalid or duplicate rows may be rejected downstream.
- **Proposed Solution / Mitigation:** The transformer validates fields and rejects duplicates within the batch. The extractor itself does not perform row validation or deduplication.

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
