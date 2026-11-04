# Inter-Service HTTP Contract

Version 1 — local development. This document is the single source of truth for how
the six services talk to each other (README section 2). Issue 5 implements exactly
what is written here; if an implementation and this document disagree, this
document wins and the implementation changes.

## 1. Base URLs and ports

Every service binds to `127.0.0.1` only (no LAN exposure) on the port from
`services/shared/config.js` (`.env`, defaults shown):

| Service | Default port | Base URL | Role |
|---|---:|---|---|
| Extractor | 3001 | `http://127.0.0.1:3001` | Reads transactions from the CSV file at `CSV_PATH` |
| Transformer | 3002 | `http://127.0.0.1:3002` | Validates, cleans, deduplicates |
| Loader | 3003 | `http://127.0.0.1:3003` | Writes to SQLite |
| Reporter | 3004 | `http://127.0.0.1:3004` | Sales reports |
| Notifier | 3005 | `http://127.0.0.1:3005` | Notifications |
| Scheduler | 3006 | `http://127.0.0.1:3006` | Cron triggers; pipeline orchestrator |

## 2. Common rules (all services)

- **JSON only.** Requests with a body send `Content-Type: application/json`; all
  responses are `application/json; charset=utf-8`. No HTML error pages.
- **Body limit:** 5 MB. Larger requests are rejected by Express with 413.
- **Unknown routes:** `404` with the error envelope (section 3).
- **No auth between services.** They are localhost-only. The extractor reads
  its source from a local CSV file (`CSV_PATH`, README section 8), so no
  tokens are involved anywhere.
- **Client timeout:** every service calling another service (the scheduler is the
  first client) uses a **10 second** request timeout and treats a timeout as a
  failure of that stage.
- **Non-2xx is failure.** Clients must parse the error envelope from the body.
- Timestamps are ISO 8601 UTC strings (`2026-10-13T09:30:00Z`). Money is always
  integer **minor units** (`amount_minor`: 1250 = 12.50).

## 3. Error envelope

Every non-2xx response has exactly this body:

```json
{ "error": { "code": "invalid_request", "message": "transactions must be an array" } }
```

| Status | `code` | Meaning |
|---:|---|---|
| 400 | `invalid_request` | Malformed JSON, missing/invalid fields, bad date, unknown channel |
| 404 | `not_found` | Unknown route |
| 500 | `internal_error` | Unhandled server-side failure (includes the DB failing mid-write) |
| 503 | `not_ready` | A critical dependency is unavailable (e.g. loader cannot open the database) |

`message` is human-readable and must never contain credentials or customer data.

## 4. Data shapes

### Transaction (raw, produced by the extractor)

```json
{
  "external_id": "SALSA-TX-00001",
  "source": "csv",
  "amount_minor": 47700,
  "currency": "PHP",
  "transaction_ts": "2026-10-01T02:54:09.000Z",
  "payload": { "id": "SALSA-TX-00001", "amount": "477.00", "discount": "0.00", "items": [ { "sku": "SAL-002", "qty": 3, "unit_price": "159.00" } ], "row": 2 }
}
```

`payload` holds the parsed CSV row (with `items` decoded from JSON) for traceability. The transformer is the
only service allowed to change anything above it.

### Transaction (transformed, produced by the transformer)

The transformed transaction is the raw transaction **plus** `dedupe_hash` — a
hex SHA-256 over the canonical fields (`source`, `external_id`, `amount_minor`,
`currency`, `transaction_ts`). No other field is added or removed.

### Rejected record

```json
{ "index": 4, "external_id": "SALSA-TX-00005", "reason": "invalid_amount" }
```

Reason codes, checked in this order (the first failing one is reported):

| Code | Rejected when |
|---|---|
| `missing_external_id` | `external_id` absent, empty, or not a string |
| `invalid_external_id` | over 100 characters, leading/trailing whitespace, or control characters |
| `invalid_source` | `source` not a non-empty string of at most 50 characters |
| `invalid_amount` | `amount_minor` not a safe integer, or beyond ±100,000,000 (1,000,000.00) |
| `invalid_currency` | not exactly 3 uppercase letters |
| `invalid_timestamp` | not `YYYY-MM-DDTHH:MM:SS[.sss]Z`, not a real instant (e.g. Feb 30), or before 2000-01-01 |
| `future_timestamp` | more than one hour after the transformer's clock |
| `invalid_payload` | `payload` present but not a JSON object |
| `invalid_items` | `payload.items` present but not a non-empty array of `{ sku or name, qty: positive integer, unit_price: ≥ 0 with at most 2 decimals }` |
| `invalid_discount` | `payload.discount` present but negative, non-numeric, or more than 2 decimals |
| `amount_mismatch` | `payload.items` present and `amount_minor` ≠ Σ(`qty` × `unit_price`) − `discount` |
| `duplicate_in_batch` | same `dedupe_hash` as an earlier row in the batch |

The extractor has one more code of its own, returned in its `rejected` array
as `{ "row": 7, "external_id": "SALSA-TX-00006", "reason": "wrong_field_count", "detail": "10 cells, header has 9" }`:
a CSV row whose cell count differs from the header's is not mapped, because
its values would be in the wrong columns.

## 5. Endpoints

### GET /health — every service

| | |
|---|---|
| Request | none |
| Response 200 | `{ "service": "extractor", "status": "ok", "version": "0.1.0", "uptime_s": 12 }` |
| Response 503 | error envelope `not_ready` — a critical dependency is down (e.g. loader lost the database); `status` in the 200 body is `"ok"` otherwise |
| Failure modes | Service not listening yet (connection refused) — this is what `start-etl.ps1` waits on; 503 while degraded |

`version` is the `package.json` version. `uptime_s` is whole seconds since process
start. `service` is the service name.

### POST /extract — extractor

| | |
|---|---|
| Request | `{ "since": "2026-10-12T00:00:00Z" }` — `since` optional; keeps CSV rows whose `timestamp` is at or after it; when absent every row is returned |
| Response 200 | `{ "run_id": "b3f1...", "rows": 2, "transactions": [ …raw transactions… ], "rejected": [ …CSV rows with the wrong cell count… ] }` |
| Response 400 | `invalid_request` — `since` present but not ISO 8601, or any field other than `since` |
| Response 500 | `internal_error` — the CSV file is missing, not a file, over 1.5 MB, not UTF-8, has more than 5,000 data rows, has an unterminated quote, or its header has a blank or repeated column or lacks `id`, `timestamp`, `amount` or `currency` |
| Failure modes | Bad file → 500; header-only or empty file → 200 with `rows: 0` and `transactions: []` |

`run_id` is minted here (UUID v4) and **carried by the caller** (scheduler)
through the pipeline into `POST /load`. `rows` always equals
`transactions.length`.

### POST /transform — transformer

| | |
|---|---|
| Request | `{ "transactions": [ …raw transactions… ] }` |
| Response 200 | `{ "rows_in": 2, "rows_out": 1, "transactions": [ …transformed… ], "rejected": [ …rejected records… ] }` |
| Response 400 | `invalid_request` — `transactions` missing, not an array, or over 5,000 entries; or any other top-level field |
| Response 500 | `internal_error` |
| Failure modes | Empty array → 200 with all counts 0; a record that fails validation goes to `rejected` with a reason, it is not an error |

Invariants: `rows_in = rows_out + rejected.length`; input transactions are never
mutated in place; duplicates **within the batch** are rejected as
`duplicate_in_batch` (duplicates against the database are the loader's job).

### POST /load — loader

| | |
|---|---|
| Request | `{ "run_id": "b3f1...", "transactions": [ …transformed transactions… ] }` |
| Response 200 | `{ "inserted": 1, "skipped_duplicates": 1 }` |
| Response 400 | `invalid_request` — `run_id` not 1–100 letters, digits, `-` or `_`; `transactions` missing/not an array; unknown fields on the request or a row; a row failing any transformer rule; a `dedupe_hash` that does not match the row's fields or repeats within the batch |
| Response 503 | `not_ready` — database cannot be opened |
| Response 500 | `internal_error` — write failed |
| Failure modes | Existing `dedupe_hash` → counted in `skipped_duplicates`, not an error; empty array → 200 with both counts 0 |

The loader writes with `INSERT OR IGNORE` keyed on `dedupe_hash` and, on success,
upserts the `etl_runs` row for `run_id` (`status = 'completed'`, `rows_in`,
`rows_out`, `finished_at`).

### GET /report/daily — reporter

| | |
|---|---|
| Request | `?date=YYYY-MM-DD` (required, local date) `&tz=+08:00` (optional UTC offset or `Z`; default: the reporter machine's offset) |
| Response 200 | see below |
| Response 400 | `invalid_request` — `date` missing, not `YYYY-MM-DD` or not a real date, `tz` malformed, or an unknown or repeated query parameter |
| Response 503 | `not_ready` — database unavailable |
| Response 500 | `internal_error` |
| Failure modes | A day with no transactions is **not** an error: 200 with zero counts and one warning entry |

```json
{
  "date": "2026-11-04",
  "tz": "+08:00",
  "range": { "start": "2026-11-03T16:00:00.000Z", "end": "2026-11-04T16:00:00.000Z" },
  "generated_at": "2026-11-04T09:59:05.000Z",
  "transactions_count": 42,
  "sales_total_minor": 1234500,
  "currency": "PHP",
  "data_quality": { "loaded_rows": 42, "total_rows": 42 },
  "by_store":   [ { "store_id": "STORE-LIPA", "transactions_count": 20, "sales_total_minor": 640000 } ],
  "by_payment": [ { "payment_method": "gcash", "transactions_count": 15, "sales_total_minor": 480000 } ],
  "top_items":  [ { "sku": "SAL-001", "name": "Classic Salsa Roja 250g", "qty": 31, "sales_total_minor": 461900 } ],
  "warnings": []
}
```

The day is `[start, end)` in UTC for the local `date` at offset `tz`.
`currency` is the most common currency that day (`null` on an empty day).
`by_store`, `by_payment` and `top_items` (top 5 by quantity) come from each
row's `payload_json`. `warnings` is a string array, e.g.
`["no transactions for this date"]`, plus a warning when the day mixes currencies.

### GET /report/activity — reporter

| | |
|---|---|
| Request | `?limit=20` (optional, 1–100) |
| Response 200 | `{ "generated_at", "loaded_transactions", "last_loaded_at", "runs": [etl_runs rows], "notifications": [notifications rows] }`, newest first |
| Response 400 | `invalid_request` — `limit` not plain digits in 1–100, or an unknown or repeated query parameter |
| Response 503 | `not_ready` — database unavailable |

The scheduler records a notification for every run, successful or failed,
so `notifications` is the pipeline's run history. `runs` only holds runs
that reached the loader.

### POST /notify — notifier

| | |
|---|---|
| Request | `{ "channel": "log", "subject": "ETL run completed", "body": "42 rows loaded" }` |
| Response 200 | `{ "delivered": true, "channel": "log", "notification_id": 3 }` |
| Response 400 | `invalid_request` — unknown `channel`; `subject`/`body` missing or too long; a line break or control character in `subject`; a control character other than tab or line break in `body`; or any other field |
| Response 503 | `not_ready` — database unavailable |
| Response 500 | `internal_error` |
| Failure modes | A failed send (upstream provider down) → 200 with `delivered: false`, not an error, so the pipeline is never blocked by notifications |

Valid channels this week: `log` (always works — records into the `notifications`
table and mirrors to the service log), `email`, `webhook` (stubs that may return
`delivered: false`).

### Scheduler — no pipeline endpoints

The scheduler only serves `GET /health`. On each cron tick (`ETL_CRON`) it runs
the pipeline **as a client**: `POST /extract` → `POST /transform` →
`POST /load` → `POST /notify`, threading the `run_id`, using the 10s timeout, and
recording the outcome via `/notify` on both success and failure.

Before using each response it checks the contract, and fails the run (with a
"broke the contract" notification) instead of passing bad data on:

- `/extract`: `run_id` is a non-empty string, `transactions` is an array,
  `rows` equals its length, and `rejected` (when present) is an array.
- `/transform`: `rows_in` equals the number of rows sent, `rows_out` equals
  `transactions.length`, and `rows_in = rows_out + rejected.length`.
- `/load`: `inserted` and `skipped_duplicates` are integers summing to the
  number of rows sent.

The run summary counts the extractor's and transformer's rejected rows
together and lists them by reason, e.g. `rejected 2 [amount_mismatch: 1, wrong_field_count: 1]`.

## 6. Happy-path example (scheduler's view)

```text
POST http://127.0.0.1:3001/extract      { "since": "2026-10-12T00:00:00Z" }
                                       → { "run_id": "b3f1", "rows": 2, "transactions": [t1, t2] }
POST http://127.0.0.1:3002/transform    { "transactions": [t1, t2] }
                                       → { "rows_in": 2, "rows_out": 2, "transactions": [t1', t2'], "rejected": [] }
POST http://127.0.0.1:3003/load         { "run_id": "b3f1", "transactions": [t1', t2'] }
                                       → { "inserted": 2, "skipped_duplicates": 0 }
POST http://127.0.0.1:3005/notify       { "channel": "log", "subject": "ETL run b3f1 completed", "body": "inserted 2, skipped 0" }
                                       → { "delivered": true, "channel": "log", "notification_id": 1 }
```

## 7. Manual smoke commands (PowerShell)

```powershell
curl.exe -s http://127.0.0.1:3001/health
curl.exe -s -X POST http://127.0.0.1:3002/transform -H "Content-Type: application/json" -d '{\"transactions\":[]}'
curl.exe -s "http://127.0.0.1:3004/report/daily?date=2026-10-13"
```

Quoting note: on Windows PowerShell 5.1 the embedded quotes in `-d` must be
written `\"` (verified against a live listener). On PowerShell 7+, drop the
backslashes: `-d '{"transactions":[]}'`.
