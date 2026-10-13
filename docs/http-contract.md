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
| Extractor | 3001 | `http://127.0.0.1:3001` | Pulls transactions from Google Sheets |
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
- **No auth between services.** They are localhost-only. The token
  (`API_TOKEN`) is used only on the outbound call from the extractor to Google
  Sheets (README section 8), never between these services.
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
  "external_id": "SHEET-ROW-1234",
  "source": "google-sheets",
  "amount_minor": 1250,
  "currency": "USD",
  "transaction_ts": "2026-10-13T09:30:00Z",
  "payload": { "row": 1234, "raw_columns": ["..."] }
}
```

`payload` holds the untouched source row for traceability. The transformer is the
only service allowed to change anything above it.

### Transaction (transformed, produced by the transformer)

The transformed transaction is the raw transaction **plus** `dedupe_hash` — a
hex SHA-256 over the canonical fields (`source`, `external_id`, `amount_minor`,
`currency`, `transaction_ts`). No other field is added or removed.

### Rejected record

```json
{ "index": 4, "external_id": "SHEET-ROW-1240", "reason": "invalid_amount" }
```

Reason codes: `missing_external_id`, `invalid_amount`, `invalid_currency`,
`invalid_timestamp`, `duplicate_in_batch`.

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
| Request | `{ "since": "2026-10-12T00:00:00Z" }` — `since` optional; when absent the extractor uses its default window (the last full day) |
| Response 200 | `{ "run_id": "b3f1...", "rows": 2, "transactions": [ …raw transactions… ] }` |
| Response 400 | `invalid_request` — `since` present but not ISO 8601 |
| Response 500 | `internal_error` — Google Sheets / Apps Script call failed after its own retries |
| Failure modes | Bad `API_TOKEN` or unreachable endpoint upstream → 500; empty sheet → 200 with `rows: 0` and `transactions: []` |

`run_id` is minted here (UUID v4) and **carried by the caller** (scheduler)
through the pipeline into `POST /load`. `rows` always equals
`transactions.length`.

### POST /transform — transformer

| | |
|---|---|
| Request | `{ "transactions": [ …raw transactions… ] }` |
| Response 200 | `{ "rows_in": 2, "rows_out": 1, "transactions": [ …transformed… ], "rejected": [ …rejected records… ] }` |
| Response 400 | `invalid_request` — `transactions` missing or not an array |
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
| Response 400 | `invalid_request` — `run_id` missing/not a string, or `transactions` missing/not an array |
| Response 503 | `not_ready` — database cannot be opened |
| Response 500 | `internal_error` — write failed |
| Failure modes | Existing `dedupe_hash` → counted in `skipped_duplicates`, not an error; empty array → 200 with both counts 0 |

The loader writes with `INSERT OR IGNORE` keyed on `dedupe_hash` and, on success,
upserts the `etl_runs` row for `run_id` (`status = 'completed'`, `rows_in`,
`rows_out`, `finished_at`).

### GET /report/daily — reporter

| | |
|---|---|
| Request | `?date=YYYY-MM-DD` (required, local date) |
| Response 200 | see below |
| Response 400 | `invalid_request` — `date` missing or not `YYYY-MM-DD` |
| Response 503 | `not_ready` — database unavailable |
| Response 500 | `internal_error` |
| Failure modes | A day with no transactions is **not** an error: 200 with zero counts and one warning entry |

```json
{
  "date": "2026-10-13",
  "generated_at": "2026-10-13T23:59:05Z",
  "transactions_count": 42,
  "sales_total_minor": 123456,
  "currency": "USD",
  "data_quality": { "loaded_rows": 42, "total_rows": 45 },
  "warnings": []
}
```

`warnings` is a string array, e.g. `["no transactions for this date"]`.
`data_quality` reports how many extracted rows survived to the database.

### POST /notify — notifier

| | |
|---|---|
| Request | `{ "channel": "log", "subject": "ETL run completed", "body": "42 rows loaded" }` |
| Response 200 | `{ "delivered": true, "channel": "log", "notification_id": 3 }` |
| Response 400 | `invalid_request` — unknown `channel`, or `subject`/`body` missing |
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
