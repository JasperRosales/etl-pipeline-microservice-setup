# Stage 1: Data Extraction Plan — S.A.L.S.A. Pipeline

**Pipeline Name:** S.A.L.S.A. (Sales Acquisition, Loading, Storage & Analytics)  
**Members:** Jasper Rosales, Iladio Mendoza, Agquiz Nino Joseph  
**Section:** BSIT-BA-4101

---

## 1. Data Source and Extraction Specification

- **Source System:** A local CSV file of POS transactions. The extractor no longer calls an HTTP API.
- **Source Database or File:** The CSV file at `CSV_PATH` (default `./data/transactions.csv`, resolved against the project root). It has a header row and one transaction per row.
- **Extraction Method:** The Node.js extractor service exposes `POST /extract` on port 3001. On each request it reads the whole CSV file, optionally keeps only rows at or after a normalized `since` value, and maps each row.
- **Schedule and Invocation:** The extractor does not schedule itself. It is called by the scheduler service according to `ETL_CRON` (default: every 30 seconds, `*/30 * * * * *`), or can be called directly.
- **Extraction Scope:** Every row in the CSV file. An optional `since` request value keeps rows whose `timestamp` is at or after it (rows with an unparseable timestamp are kept so the transformer can reject them); no default date window is applied when it is omitted.
- **Source Limitations and Assumptions:** The CSV file must exist, be readable as UTF-8, stay within 1.5 MB and 5,000 data rows, and have `id`, `timestamp`, `amount` and `currency` columns in its header. The file is re-read on every run, so rows appended between runs are picked up on the next run; rows already loaded are skipped by the loader's dedupe hash.

---

## 2. Source Tables and Column Specification

### CSV Transaction Rows

The CSV file has a header row and one transaction per row. Example:

```csv
id,timestamp,amount,currency,store_id,cashier_id,payment_method,discount,items
SALSA-TX-00001,2026-10-01T02:54:09.000Z,477.00,PHP,STORE-LIPA,C-101,maya,0.00,"[{""sku"":""SAL-002"",""name"":""Salsa Verde 250g"",""qty"":3,""unit_price"":""159.00""}]"
```

- Standard CSV quoting: a field may be wrapped in double quotes, `""` inside it is a literal quote, and quoted fields may contain commas and line breaks. LF or CRLF line endings and an Excel UTF-8 BOM are accepted.
- Header names and cell values are trimmed. Empty cells are left out of the row, so a blank `amount` is rejected by the transformer rather than loaded as 0.
- `items` holds a JSON array of line items (`sku`, `name`, `qty`, `unit_price`) used by the reporter. A cell that is not valid JSON is kept as text.
- Every row gets a `row` value, its position in the file with the header as row 1, unless the file has its own `row` column.
- Other columns (`store_id`, `cashier_id`, `payment_method`, `discount`, …) are kept in `payload` as text.

| Source Column | Purpose | Expected Value |
|---|---|---|
| `id` | Identifies the source transaction | Any value converted to a string when present; omitted when missing or `null`. |
| `amount` | Supplies the transaction amount | A value convertible to a number; malformed values are passed through as invalid minor-unit amounts for downstream validation. |
| `currency` | Supplies the transaction currency | A non-empty string when available; otherwise the extractor uses `PHP`. |
| `timestamp` | Supplies the transaction time | A string or number parseable as a JavaScript date; otherwise the normalized timestamp is omitted. |

### Raw Transaction Output

The extractor maps each source row into the raw transaction shape used by the next ETL stage.

| Column | Data Type | Key / Relationship |
|---|---|---|
| `external_id` | `STRING` or omitted | Source `id` converted to a string; downstream validation requires a usable identifier. |
| `source` | `STRING` | Constant value `csv`. Part of the dedupe hash. |
| `amount_minor` | `INTEGER` or invalid numeric value | Source `amount` multiplied by 100 and rounded; validated by the transformer. |
| `currency` | `STRING` | Uppercased source currency or default `PHP`. |
| `transaction_ts` | ISO 8601 UTC `STRING` or omitted | Normalized from source `timestamp` when parseable; validated by the transformer. |
| `payload` | `OBJECT` | Original source row preserved for traceability. |

**Output:** `{ "run_id": "...", "rows": 0, "transactions": [], "rejected": [] }`. `rows` equals the number of mapped transactions returned. Raw transactions are passed to the transformer for validation and cleanup.

---

## 3. Extraction Validation and Data Quality Checks

| Check Name | Target | Purpose | Validation Criteria |
|---|---|---|---|
| Optional `since` validation | `POST /extract` request body | Prevents an invalid date filter. | If provided, `since` must be a string accepted by JavaScript's date parser; it is normalized to ISO 8601 UTC. |
| Request field validation | `POST /extract` request body | Catches typos such as `sinse`. | Only `since` is accepted; any other field is a 400. |
| CSV file validation | File at `CSV_PATH` | Ensures the file can be read as transaction rows. | The file must exist, be a regular file of at most 1.5 MB, be valid UTF-8, have at most 5,000 data rows, and not end inside an unterminated quoted field. Its header must include `id`, `timestamp`, `amount` and `currency`, with no blank or repeated names. Any failure fails the whole extract (HTTP 500). |
| Row shape validation | Individual CSV rows | A row with more or fewer cells than the header (usually an unquoted comma such as `1,250.00`) would put values in the wrong columns. | The row is not mapped; it is returned in `rejected` as `{ row, external_id, reason: "wrong_field_count", detail }` and logged as `extract_rejected`. |
| Row value validation | Mapped transactions | Keeps extraction separate from transaction validation. | Bad values (amount, currency, timestamp, items, discount, totals) are passed through; the transformer rejects them with a reason code. |

---

## 4. Extraction Metadata and Log Specification

| Field Name | Purpose | Example Value / Format |
|---|---|---|
| Pipeline run ID | UUID v4 created for the extraction request and used to trace the batch | `b3f1...` |
| Source row count | Number of mapped transactions returned by the extractor | `rows: 2` |
| Returned transactions | Raw transaction records handed to the next stage | `transactions: [...]` |
| Extraction status | Indicates whether the extraction request succeeded or failed | HTTP 200 response or error response |
| Successful extraction log | Records the run identifier, row count and file read | `extract` event with `run_id`, `rows` and `file` |
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
- **Source File:** A CSV file with a header row that includes `id`. The parsed row (with `items` decoded and `row` added) is retained in `payload`.

### Source-to-Standardized Field Mappings

| Source Column | Standardized Column | Source Type | Target Type | Mapping Type |
|---|---|---|---|---|
| `id` | `external_id` | CSV text | `STRING` | Convert to string when present |
| — | `source` | — | `STRING` | Constant `csv` |
| `amount` | `amount_minor` | Numeric text | `INTEGER` cents | Multiply by 100 and round |
| `currency` | `currency` | CSV text | `STRING` | Uppercase; default to `PHP` when empty, whitespace-only, or absent |
| `timestamp` | `transaction_ts` | Date text | ISO 8601 UTC `STRING` | Parse and normalize; omit if invalid |
| Entire source row | `payload` | CSV row | JSON object | Preserve parsed row (`items` decoded from JSON) |

---

## 7. Extraction Acceptance and Handover Rules

| Overall Condition | Acceptance Decision | Pipeline Action |
|---|---|---|
| The CSV file is read and parsed | **ACCEPTED** | Return `{ run_id, rows, transactions }` to the caller. |
| A row contains missing or invalid transaction fields | **EXTRACTED, THEN VALIDATED DOWNSTREAM** | Return the mapped row; the transformer validates it and records any rejection. |
| `since` is invalid | **FAILED** | Return HTTP 400 (`invalid_request`); the scheduler stops the current pipeline run and handles the failure. |
| The CSV file is missing, unreadable, or malformed | **FAILED** | Return HTTP 500 (`internal_error`); the scheduler stops the current pipeline run and handles the failure. |

### Validation Summary

- Optional `since` request validation: **PASS** when omitted or valid; otherwise the request is rejected.
- CSV file validation: **PASS** when the file exists, is within the size and row limits, parses as UTF-8, and has the required columns; otherwise extraction fails.
- Row shape validation: rows with the wrong cell count are returned in `rejected`; the rest continue.
- Individual row validation and in-batch duplicate checking: **DEFERRED TO THE TRANSFORMER**.

**Handover:** The scheduler sends the returned transactions to the transformer and carries the same `run_id` through to the loader. The extractor does not write to the database or invoke downstream services itself.

---

## 8. Common Extraction Problems and Mitigation

### Problem 1: CSV File Missing or Unreadable

- **Problem Description:** The file at `CSV_PATH` does not exist or cannot be read.
- **Possible Cause:** Wrong `CSV_PATH`, the file was moved or renamed, or it is locked by another program.
- **Impact on Extraction Process:** The extractor cannot read rows for the current run.
- **Proposed Solution / Mitigation:** Return HTTP 500 with `CSV file not found: <path>` (or the read error) and log `extract_failed`. The scheduler retries on its next tick; nothing is loaded until the file is back.

### Problem 2: Malformed CSV File

- **Problem Description:** The file has an unterminated quoted field, is not UTF-8, is over the size or row limit, or its header is missing a required column or repeats one.
- **Possible Cause:** Hand-edited file, a spreadsheet export with different headers, or a partially written file.
- **Impact on Extraction Process:** The extractor cannot map the file into raw transaction records.
- **Proposed Solution / Mitigation:** Fail the request with the parse error and log it for investigation. Individual bad cells (such as a non-numeric amount) do not fail the file; the transformer rejects those rows.

### Problem 3: Invalid or Duplicate Transaction Rows

- **Problem Description:** A source row has missing or invalid transaction fields, or duplicates another row in the batch.
- **Possible Cause:** Missing or malformed values in the source data, or repeated source rows.
- **Impact on Extraction Process:** The extractor returns mapped rows without rejecting them; invalid or duplicate rows may be rejected downstream.
- **Proposed Solution / Mitigation:** The transformer validates fields and rejects duplicates within the batch. The extractor itself does not perform row validation or deduplication.

# Extractor Feature

## Instructions

The extractor reads source rows from the CSV file at `CSV_PATH`, maps them to
raw transaction records, and creates the
`run_id` used to trace the batch. It is configured through the shared `.env`
file and is called by the scheduler or directly with `POST /extract`.

1. Copy `.env.example` to `.env` in the microservice project root.
2. Keep `CSV_PATH=./data/transactions.csv`, or point it at your own CSV file.
   The bundled file holds the 120 demo sales.
3. Start the services with `.\start-etl.ps1` from the microservice project.
4. Let the scheduler trigger the service or call `POST /extract` on port 3001.
5. Review the response's `run_id`, `rows`, and `transactions`.

An optional `since` request field is accepted. When supplied, it must be a
string accepted by JavaScript's date parser; it is normalized to ISO 8601 UTC
and only rows at or after it are returned. No default date window is applied
when it is omitted.

## Architecture

The implementation is in `services/extractor/index.js`. It uses the shared
Express bootstrap (`services/shared/app.js`) for the health route, request
handling, and common error responses; shared configuration
(`services/shared/config.js`) for the CSV path, host, and port. CSV parsing
is in `services/extractor/csv.js` and row mapping in
`services/extractor/normalize.js`.

The service reads the CSV file on every request, parses it, applies the
optional `since` filter, maps each row, and returns the results. It does not
write to SQLite or call the other ETL services itself.

## Tech Stack

- Node.js 
- Express.js
- Built-in CSV parser (no extra dependency), `fs`, and `crypto.randomUUID`
- `dotenv` through the shared configuration module
- JSON over local HTTP

## Process

1. The caller sends `POST /extract` with an optional `since` field to port 3001.
2. The service validates `since` if present and normalizes it to UTC.
3. It creates a UUID v4 `run_id`.
4. It reads and parses the CSV file at `CSV_PATH`. A missing file, an
   unterminated quoted field, a bad header, or a file over the limits fails the request
   with HTTP 500.
5. When `since` is present it keeps rows whose `timestamp` is at or after it.
6. It maps each source row into the raw transaction shape and responds with
   `{ run_id, rows, transactions }`.

The row mapping uses source `id` as a string `external_id` when present,
`csv` as `source`, source `amount` converted to rounded integer
cents as `amount_minor`, and the uppercased source currency or `PHP` as
`currency`. A parseable source `timestamp` becomes ISO 8601 UTC
`transaction_ts`; the original row is retained as `payload`. The extractor
does not reject malformed individual rows; the transformer validates them.

## Data Flow

The CSV file supplies source rows. The extractor maps these into
canonical raw transaction objects and returns them with a new `run_id`. The
scheduler forwards the transactions to the transformer and carries the same
`run_id` to the loader. The extractor is stateless between requests and does
not persist data.

## Service Documentation

### Extractor Service

- **Purpose:** Read source transaction rows from a CSV file and map them to
  the raw ETL transaction shape.
- **Responsibilities:** Validate the optional `since` value, read and parse
  the CSV file, filter by `since`, map rows, and assign a run identifier.
- **Inputs:** Optional `{ "since": "..." }` request body plus the `CSV_PATH`
  configuration.
- **Outputs:** `{ run_id, rows, transactions }`; each transaction contains
  `external_id`, `source`, `amount_minor`, `currency`, `transaction_ts`, and
  `payload` where source data permits.
- **Dependencies:** The CSV file, shared config, and shared app.
- **Interactions:** Called by the scheduler; returns raw transactions for the
  transformer and a `run_id` later passed to the loader.
