# Stage 3: Data Load Documentation

## Objective

The goal of this stage is to load the validated, transformed dataset handed over from the Transformation Stage into the target database, and to confirm that the loaded data is complete, accurate, traceable, and ready for use by reports and downstream analysis.

This pipeline is batch only. Data is loaded in scheduled, bounded batches. Streaming, micro-batch, and real-time loading are out of scope.

All documentation is written in Markdown language.

## 1. Load Source and Target Specification

### Load Input

- The load input is the accepted transformed transaction payload produced by the transformer.
- The source is the scheduler-to-loader handover through `POST /load` on port `3003`.
- Input location: `services/loader/store.js` and the HTTP entry point in `services/loader/index.js`.
- Transformation run ID: the loader receives the extractor-generated `run_id` from the caller.
- Batch window: the loader loads the current request batch only; it does not recalculate or re-extract data.

### Target System

- Target system: local SQLite database used by the POS ETL microservice.
- Database management system: SQLite.
- Target database name: configured via `DB_PATH` (default `./data/pos.db`).
- Target schema: `transactions` table and `etl_runs` table created by `scripts/init-db.js`.

### Load Method

- Load tool: Node.js service with `better-sqlite3`.
- Load trigger: scheduler sends a JSON request to `POST /load` after transformation succeeds.
- Write logic: the service validates the inbound batch, then inserts rows using `INSERT OR IGNORE` keyed on `dedupe_hash`.
- Batch frequency: depends on the scheduler configuration; in the local setup, the ETL pipeline can run on a defined cron schedule.

### Load Scope

- The loader writes only accepted, transformed transactions.
- It loads into the `transactions` table in the configured database.
- It updates the `etl_runs` row for the associated `run_id`.
- The loader does not extract, transform, or clean new data during this stage.

### Limitations and Assumptions

- The loader assumes the database is already initialized and available.
- If the database cannot be opened, the service returns `503 not_ready`.
- The service has write access to the configured SQLite file.
- The implementation assumes the caller sends only valid transformed rows from the transformer.
- The loader does not use credentials, tokens, or secrets in documentation.

Requirement: The load must use only the data handed over from the Transformation Stage. It must not re-extract or re-transform data.

## 2. Target Tables and Column Specification

### Table 1: `transactions`

| Field | Type | Purpose | Notes |
|---|---|---|---|
| `id` | INTEGER | Primary key | Auto-incrementing SQLite key |
| `external_id` | TEXT | Source transaction identifier | Stored from transformed row |
| `source` | TEXT | Source system label | Example: `csv` |
| `amount_minor` | INTEGER | Amount in minor units | Stores cents or equivalent integer units |
| `currency` | TEXT | ISO currency code | Default `PHP` |
| `transaction_ts` | TEXT | Transaction timestamp | ISO 8601 UTC string |
| `payload_json` | TEXT | Original payload | Serialized JSON object |
| `dedupe_hash` | TEXT | Idempotency key | Unique index; duplicate load is ignored |
| `created_at` | TEXT | Row creation timestamp | Default SQLite `datetime('now')` |

- Table type: staging/transaction store
- Primary key: `id`
- Unique constraint: `dedupe_hash`
- Important relationship: one row represents one accepted transformed transaction

### Table 2: `etl_runs`

| Field | Type | Purpose | Notes |
|---|---|---|---|
| `run_id` | TEXT | Pipeline run identifier | Primary key |
| `started_at` | TEXT | Load start timestamp | ISO datetime |
| `finished_at` | TEXT | Load end timestamp | Upserted after write |
| `status` | TEXT | Run status | Example: `completed` |
| `rows_in` | INTEGER | Number of input rows | Request array length |
| `rows_out` | INTEGER | Number inserted this batch | Count of new rows |
| `error` | TEXT | Error text | Optional |

- Table type: run tracking/audit table
- Primary key: `run_id`
- Relationship: one run record is linked to the batch being loaded

## 3. Load Strategy and Rules

### Load Type

- The loader performs an incremental batch insert for each accepted transformed batch.
- It does not replace the full table on each load.

### Write Logic

- Insert only for rows that are new.
- Existing rows with the same `dedupe_hash` are skipped.
- Transaction writes are done inside a single SQLite transaction.
- `etl_runs` is updated with `ON CONFLICT(run_id) DO UPDATE` to keep run status current.

### Handling of Changing Data

- The loader does not update existing transaction rows by business logic; it prevents duplicates via unique `dedupe_hash`.
- If the same record appears again, it is treated as a duplicate and counted in `skipped_duplicates`.
- Late-arriving or modified records are not re-processed in this stage; they are only loaded if the caller resends a valid transformed row with the same unique hash.

### Load Order and Dependencies

- The loader depends on a valid transformed batch produced by the transformer.
- The `run_id` is assumed to be passed from the extractor or scheduler.
- There are no parent-child table dependencies beyond the `etl_runs` summary record.

### Transaction and Rollback Handling

- The loader wraps the batch insert in a SQLite transaction.
- If the transaction fails, the entire database write is rolled back in the normal SQLite transactional model.
- The `etl_runs` upsert happens after the insert transaction, so a write failure may still leave transaction rows persisted if the upsert fails after insert success.

### Rerun and Idempotency

- Running the same batch twice must not create duplicate transaction records.
- Idempotency is enforced by the unique `dedupe_hash` and `INSERT OR IGNORE`.
- A retried load is safe because the same transaction key is ignored rather than duplicated.

## 4. Pre-Load Validation Checks

| Check Name | Target | Purpose | Validation Criteria | Severity |
|---|---|---|---|---|
| Request structure check | `POST /load` body | Ensure valid input | Body must be a JSON object with `run_id` and `transactions` | Critical |
| Run ID validation | `run_id` | Confirm valid batch identifier | 1–100 characters, letters/digits/`-`/`_` | Critical |
| Transactions array validation | `transactions` | Ensure batch content is present | Must be an array | Critical |
| Unknown field validation | request and row keys | Prevent malformed payloads | Only allowed fields accepted | Critical |
| `dedupe_hash` validation | each transaction | Ensure hash exists and is valid | Must be a 64-character lowercase hex SHA-256 | Critical |
| Transformer rule validation | each row | Confirm row was accepted by transform stage | Must pass `rejectionReason(tx)` check | Critical |
| Hash integrity validation | each row | Ensure hash matches fields | `tx.dedupe_hash === dedupeHash(tx)` | Critical |
| Duplicate in batch validation | row set | Prevent same hash repeated within one request | No repeated hash allowed in a single batch | Critical |
| Database readiness check | SQLite file | Ensure writing is possible | Database opens successfully | Critical |

Required considerations:
- Target database connection and write permissions
- Schema availability for `transactions` and `etl_runs`
- Valid transformation handover from transformer stage
- No duplicate rows within the same request
- Database file path must be correct and writable

## 5. Post-Load Validation and Reconciliation

| Check Name | Target | Purpose | Validation Criteria | Severity |
|---|---|---|---|---|
| Record insertion check | `transactions` table | Confirm data was written | `rows_out` equals new inserts | Critical |
| Duplicate skip check | `skipped_duplicates` | Confirm duplicates were ignored | Existing `dedupe_hash` values are counted but not inserted | Critical |
| Run record reconciliation | `etl_runs` | Confirm status summary updated | `run_id` row exists with `rows_in` and `rows_out` | Critical |
| Primary key safety | `transactions` table | Prevent duplicate rows | Unique `dedupe_hash` satisfied | Critical |
| Row count match | request vs DB | Validate batch totals | Request size equals inserted + skipped duplicates | Critical |
| Data availability | reporter queries | Make sure data is readable | Data can be queried from the same SQLite database | Non-critical |

Scope limitation: The loader does not perform new cleaning or transformation logic after writing. It validates only the accepted transformed rows and records the batch outcome.

## 6. Load Metadata and Log Specification

The implementation logs key details for monitoring and recovery.

| Field | Purpose | Example Value / Format |
|---|---|---|
| `run_id` | Unique pipeline run identifier | `b3f1...` |
| `inserted` | Number of new rows persisted | `5` |
| `skipped_duplicates` | Number of existing rows ignored | `2` |
| `status` | Result of the ETL run | `completed` |
| `started_at` | Load start time | ISO 8601 UTC timestamp |
| `finished_at` | Load completion time | ISO 8601 UTC timestamp |
| `rows_in` | Incoming row count | request `transactions.length` |
| `rows_out` | Rows inserted this batch | `inserted` |
| `error` | Failure detail if needed | error message or `NULL` |

The service uses logs like `load` and `load_failed` to trace writes and diagnose problems. These logs are used for operational monitoring, troubleshooting, auditing, and run-level traceability.

## 7. Log Retention, Rejected Data, and Access

- Log storage location: local service logs under the configured runtime environment, plus console output from the Node.js service.
- Retention period: not explicitly configured in this local project; operational retention should be managed by the deployment or local system owner.
- Rejected data: the loader does not maintain a separate rejected-record table; bad rows are rejected at request validation time before insertion.
- Access: the local environment owner or developer has access to the database and logs for maintenance and debugging.
- Archiving: not implemented in the local setup; the project is designed for local development, not long-term production retention.

Requirement: Logs and any errors must be retained long enough to support troubleshooting and recovery of failed loads.

## 8. Load Acceptance, Rollback, and Completion Rules

### Automatic Approval

The batch is considered successful when:
- the request structure is valid,
- every row passes validation,
- the database opens successfully,
- insertion completes without a database write error.

### Manual Review

Manual review is required only when operational issues occur, such as:
- database access problems,
- unexpected validation failures,
- mismatch between input array length and inserted count,
- unclear or abnormal load behavior.

### Rejection or Failure

A load fails when:
- `run_id` is invalid,
- `transactions` is not an array,
- a row is missing or has invalid `dedupe_hash`,
- a hash is repeated or mismatched,
- database write fails, or
- the service cannot open the configured SQLite database.

In these cases, the service returns an error response and does not silently continue.

### Completion and Handover

When the batch completes successfully:
- `etl_runs` is updated,
- the response returns `{ "inserted": X, "skipped_duplicates": Y }`,
- the data is then available for downstream reporting and queries.

The loader acts as the final handoff point before the reporting stage uses the stored transaction data.

## 9. Common Load Problems and Mitigation

| Problem | Possible Cause | Impact | Mitigation |
|---|---|---|---|
| Duplicate rows after rerun | Same batch is sent again without dedupe protection | Inflated record counts | Use `dedupe_hash` and `INSERT OR IGNORE` |
| Database not ready | SQLite file path invalid or database unavailable | Load fails with `503` | Confirm `DB_PATH`, ensure the database is created |
| Invalid request payload | Caller sends malformed body or unknown fields | Load rejected with `400` | Validate request and row keys before loading |
| Hash mismatch | Transaction fields changed after transformer stage | Row is rejected as invalid | Recompute and compare `dedupe_hash` before insert |
| Partial load confusion | Run status not updated correctly | Audit trail becomes unreliable | Upsert `etl_runs` after the insert transaction |
| Retry causing duplicates | No unique key on the load table | Data duplication across runs | Enforce `UNIQUE` on `dedupe_hash` |

### Expected Output

The documentation is consistent with the implemented load process and provides enough information for a team member to understand, validate, monitor, and maintain the load stage. The loaded data is validated, reconciled with the transformed input, and recorded so every batch can be traced, audited, and recovered. New extraction or transformation logic is not added in this stage.

---

# Loader Feature

## Instructions

The loader persists accepted transformed transactions in SQLite and updates
the ETL run record. Initialize the database using `npm run db:init` from the
microservice project directory, or let `start-etl.ps1` initialize it before
starting services.

1. Ensure the database is initialized and `DB_PATH` points to the intended
   SQLite file (default `./data/pos.db`).
2. Send `POST /load` on port 3003 with a non-empty string `run_id` and a
   `transactions` array.
3. Supply transformed transactions that contain a string `dedupe_hash`.
4. Review `inserted` and `skipped_duplicates` in the response.

The loader uses SQLite `INSERT OR IGNORE` keyed by the unique `dedupe_hash`, so
repeated transaction inserts are skipped rather than duplicated.

## Architecture

The implementation is in `services/loader/index.js`. It uses `better-sqlite3`
for persistence, the shared config module for the database path, and the shared
Express bootstrap for HTTP startup and common behavior. It validates the
request shape, serializes each transaction's `payload` into `payload_json`,
performs all transaction inserts within one SQLite transaction, then upserts
the corresponding `etl_runs` record. The run upsert occurs after and outside
the transaction that inserts transaction rows.

## Tech Stack

- Node.js
- Express.js and shared HTTP app bootstrap
- SQLite through `better-sqlite3`
- Shared environment configuration
- SQLite transactions and `INSERT OR IGNORE`
- JSON over local HTTP

## Process

1. The caller sends `POST /load` with `{ run_id, transactions }` to port 3003.
2. The service requires `run_id` to be a non-empty string,
   `transactions` to be an array, and each transaction to have a string
   `dedupe_hash`; invalid request shapes return 400 `invalid_request`.
3. It opens the configured database. Failure to open it returns 503
   `not_ready`.
4. It maps transaction fields to the SQLite columns and JSON-serializes
   `payload` as `payload_json`.
5. It inserts the batch inside a SQLite transaction using
   `INSERT OR IGNORE`. It counts inserted rows and rows ignored due to existing
   hashes.
6. After the inserts complete, it upserts `etl_runs` with `status: "completed"`,
   `rows_in` equal to the request array length, `rows_out` equal to rows
   inserted by this request, and current timestamps for `started_at` and
   `finished_at`.
7. It returns `{ inserted, skipped_duplicates }`. An empty array is valid and
   returns zero for both counts. Database write errors return 500
   `internal_error`.

The run-record upsert is not part of the transaction containing the
transaction inserts. If the upsert fails after the inserts succeed, the
request can return an error even though transaction rows were written.

## Data Flow

The scheduler passes the extractor's `run_id` and the transformer's accepted
transactions to the loader. The loader persists rows in `transactions` and
records run counts in `etl_runs`. The reporter reads the transaction table.
The loader does not send notifications.

## Service Documentation

### Loader Service

- **Purpose:** Persist transformed transaction rows and maintain a record of
  the load attempt.
- **Responsibilities:** Validate the request shape, serialize payloads, insert
  transactions idempotently by `dedupe_hash`, count inserts and duplicates,
  and upsert `etl_runs`.
- **Inputs:** `{ run_id, transactions }` with transformed records containing a
  string `dedupe_hash`.
- **Outputs:** `{ inserted, skipped_duplicates }` and an upserted `etl_runs`
  row on successful completion.
- **Dependencies:** SQLite database, `better-sqlite3`, shared config, and
  shared Express app bootstrap.
- **Interactions:** Receives accepted transactions and the extractor's run ID
  via the scheduler; supplies persisted data to the reporter.
