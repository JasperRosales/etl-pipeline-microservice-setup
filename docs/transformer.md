# Stage 2: Data Transformation Plan — S.A.L.S.A. Pipeline

## 1. Transformation Input and Processing Specification

- **Input Source:** Raw transaction records returned by the extractor and passed to the transformer by the scheduler. The transformer does not re-extract data or read staging files or tables.
- **Input Format and Location:** A JSON request body containing a `transactions` array, sent to `POST /transform` on port 3002.
- **Run ID and Batch Window:** The transformer request does not include or record a `run_id`, batch ID, or date window. The scheduler carries the extractor's run ID separately to the loader.
- **Batch Processing Method:** The Node.js/Express service processes the complete request array synchronously in memory, once per HTTP request. It has no independent schedule; the scheduler calls it during each pipeline run.
- **Batch Size and Failure Reruns:** The service uses the shared 5 MB JSON request-body limit. It does not split batches or retry requests itself. Scheduler retries are governed by the shared HTTP retry behavior.
- **Idempotency:** The transformer is stateless and deterministically computes the hash from the same canonical field values. Reprocessing a batch produces the same accepted/rejected result for unchanged input. Duplicate detection applies only within each individual request; loader-side deduplication handles previously stored records.
- **Transformation Scope:** Validate `external_id`, `amount_minor`, `currency`, and `transaction_ts`; reject repeated canonical-field hashes in the same batch; add `dedupe_hash` to accepted records. Accepted fields are otherwise preserved without cleaning, type conversion, aggregation, or business filtering.
- **Dependencies and Assumptions:** The extractor supplies the JSON transaction records. The scheduler forwards the accepted records to the loader and reports the rejected count. The transformer does not access SQLite or call other services.

---

## 2. Data Profiling and Issue Identification

The transformer does not profile a source dataset ahead of processing, calculate issue rates, or persist profiling reports. It identifies only the row-level issues listed below while handling each request. No affected-record counts are available until a batch is submitted.

| Table or File | Column | Issue Type | Example / Detection | Affected Records | Planned Treatment |
|---|---|---|---|---|---|
| Extractor transaction array | `external_id` | Missing or invalid identifier | Missing, `null`, non-string, or empty string | Not profiled in advance; counted per request in `rejected` | Reject as `missing_external_id` (Rule C-01). |
| Extractor transaction array | `amount_minor` | Missing or non-integer value | A numeric string or decimal value | Not profiled in advance; counted per request in `rejected` | Reject as `invalid_amount` (Rule C-02). |
| Extractor transaction array | `currency` | Invalid format | Lowercase or not exactly three uppercase letters | Not profiled in advance; counted per request in `rejected` | Reject as `invalid_currency` (Rule C-03). |
| Extractor transaction array | `transaction_ts` | Missing or unparseable timestamp | Missing value or string for which `Date.parse` returns `NaN` | Not profiled in advance; counted per request in `rejected` | Reject as `invalid_timestamp` (Rule C-04). |
| Extractor transaction array | Canonical transaction fields | In-batch duplicate | Repeated SHA-256 hash over canonical values | Not profiled in advance; counted per request in `rejected` | Reject later matching row as `duplicate_in_batch` (Rule C-05). |

---

## 3. Data Cleaning Rules

The implementation rejects invalid records; it does not repair values or silently drop them. Every rejected row is included in the response with its zero-based input index and reason. No rejected-record quarantine or persistent rejection store is implemented.

| Rule ID | Target | Condition | Action | Justification |
|---|---|---|---|---|
| C-01 | `transactions[].external_id` | Not a string, missing, `null`, or equal to the empty string | Reject as `missing_external_id` | The transformer requires a usable string identifier. Whitespace-only strings are not trimmed and therefore pass this check. |
| C-02 | `transactions[].amount_minor` | Value does not satisfy `Number.isInteger` | Reject as `invalid_amount` | The pipeline contract represents money as integer minor units. Negative integers are not separately rejected by the implementation. |
| C-03 | `transactions[].currency` | Not a string matching `^[A-Z]{3}$` | Reject as `invalid_currency` | Ensures the currency code has three uppercase ASCII letters. The transformer does not uppercase or otherwise normalize the input. |
| C-04 | `transactions[].transaction_ts` | Not a string or JavaScript `Date.parse` returns `NaN` | Reject as `invalid_timestamp` | Requires a parseable timestamp; strict ISO 8601 format is not enforced. |
| C-05 | Canonical transaction values | A valid row produces a hash already seen in the current request | Reject the later row as `duplicate_in_batch` | Prevents identical canonical values from appearing more than once in an accepted batch. |

---

## 4. Standardization and Data Type Rules

The transformer validates selected field types and formats but does not convert or normalize accepted values. It adds only the computed `dedupe_hash`.

| Rule ID | Column | Accepted Input | Standardization Performed | On Failure |
|---|---|---|---|---|
| S-01 | `external_id` | Non-empty string | None; original string is retained | Reject using C-01. |
| S-02 | `amount_minor` | JavaScript integer number | None; original integer is retained | Reject using C-02. |
| S-03 | `currency` | Three uppercase ASCII letters | None; lowercase values are not converted | Reject using C-03. |
| S-04 | `transaction_ts` | String parseable by JavaScript `Date.parse` | No timestamp conversion or canonical formatting | Reject using C-04. |
| S-05 | `dedupe_hash` | Not supplied as a required input | Compute lowercase hexadecimal SHA-256 from canonical field values joined by `\|` | Validated rows receive the computed value. |

Conversion failures are handled as row rejections; the transformer does not supply defaults or repair invalid values.

---

## 5. Business Transformation Rules

The implemented transformer has no business calculations, joins, lookups, aggregations, business exclusions, or dimensional modeling. Its only derived field is the technical deduplication hash.

| Rule ID | Input Columns | Logic | Output Column | Reason |
|---|---|---|---|---|
| B-01 | `source`, `external_id`, `amount_minor`, `currency`, `transaction_ts` | Join values in this order with `\|`, calculate SHA-256, and encode as lowercase hexadecimal | `dedupe_hash` | Provides a deterministic key for duplicate detection in this batch and idempotent duplicate handling by the loader. |
| B-02 | `dedupe_hash` values in the current request | Retain the first valid row with a hash; reject subsequent rows with the same hash | Accepted `transactions` or `rejected` entry | Prevents repeated canonical transactions from reaching the loader within one batch. |

The hash does not include `payload` or other extra input fields. The `source` field is included in the hash but is not independently validated by the transformer.

---

## 6. Transformed Data Contract and Naming Convention

### Required Input

| Input Field | Type / Rule |
|---|---|
| `transactions` | Required JSON array; an empty array is valid. |
| `transactions[].external_id` | Must be a non-empty string. |
| `transactions[].amount_minor` | Must be an integer. |
| `transactions[].currency` | Must match `^[A-Z]{3}$`. |
| `transactions[].transaction_ts` | Must be a string parseable by JavaScript `Date.parse`. |
| `transactions[].source` | Used in hash generation; not independently validated. |

Other input fields, including `payload`, are not validated or changed on accepted records.

### Output Contract

| Output | Type | Description |
|---|---|---|
| `rows_in` | Integer | Number of records in the submitted array. |
| `rows_out` | Integer | Number of accepted, unique-in-batch records. |
| `transactions` | Array | Accepted records with all original fields preserved and `dedupe_hash` added or replaced by the computed hash. |
| `rejected` | Array | Rejection summaries with zero-based `index`, string `external_id` when available (otherwise `null`), and `reason`. |

The response invariant is `rows_in = rows_out + rejected.length`. Reason codes are `missing_external_id`, `invalid_amount`, `invalid_currency`, `invalid_timestamp`, and `duplicate_in_batch`. The transformer does not specify target database nullability or keys; the loader owns persistence.

---

## 7. Transformation Validation and Data Quality Checks

| Check Name | Target | Purpose | Validation Criteria | Severity / Action |
|---|---|---|---|---|
| Request array check | Request `transactions` | Ensures the batch has the expected top-level shape. | Must be an array. | Request-level failure: HTTP 400 `invalid_request`. |
| Required identifier check | `external_id` | Ensures a non-empty string identifier. | String and not equal to `""`. | Reject only the affected row as `missing_external_id`. |
| Amount type check | `amount_minor` | Ensures money is represented as an integer minor-unit value. | `Number.isInteger(value)` is true. | Reject only the affected row as `invalid_amount`. |
| Currency format check | `currency` | Ensures the code has the expected format. | String matching `^[A-Z]{3}$`. | Reject only the affected row as `invalid_currency`. |
| Timestamp parse check | `transaction_ts` | Ensures the timestamp can be parsed. | String and `Date.parse(value)` is not `NaN`. | Reject only the affected row as `invalid_timestamp`. |
| In-batch duplicate check | Canonical-field hash | Prevents duplicate accepted hashes in one request. | No previously seen hash in the current batch. | Reject later match as `duplicate_in_batch`. |
| Record reconciliation | Request and response counts | Accounts for every input record. | `rows_in = rows_out + rejected.length`. | Returned as an invariant; the implementation does not separately fail the batch on this check. |

No explicit critical/non-critical severity framework, null-rate threshold, output primary-key check, referential-integrity check, or business aggregate check is implemented.

---

## 8. Transformation Metadata and Log Specification

| Field | Purpose | Example Value / Format |
|---|---|---|
| `rows_in` | Number of input records | `10` |
| `rows_out` | Number of accepted records | `8` |
| `rejected` | Number of rejected records, logged as a count | `2` |
| `ts` | Timestamp added by the shared logger | ISO 8601 UTC |
| `service` | Service name added by the shared logger | `transformer` |
| `level` | Log severity added by the shared logger | `info` |
| `event` | Identifies the logged operation | `transform` |

The transformer log event records only `rows_in`, `rows_out`, and the rejected count. It does not receive or log a `run_id`, parent run ID, batch window, rule-level counts, error codes, or duration. Rejected row details are returned in the HTTP response, not written to a quarantine store. The shared logger writes JSON lines to `LOG_DIR` (default `logs`) and mirrors events to the console.

---

## 9. Log Retention, Rejected Data, and Access

- **Transformation Log Location:** Shared service log file `logs/transformer.jsonl` by default, with console output; `LOG_DIR` can change the directory.
- **Rejected Data Location:** Rejection summaries are returned to the caller in the `rejected` response array. The transformer does not persist rejected records or implement a quarantine table or file.
- **Retention and Archiving:** The transformer and shared logger do not configure retention periods, archival, or deletion rules. These must be managed outside the service.
- **Access:** The service uses the shared HTTP bootstrap, which binds to `127.0.0.1` by default. No transformer-specific authentication or access-control mechanism is implemented.
- **Sensitive Data:** Rejection responses include the rejected row's string `external_id` when available, but do not include its entire payload. The transformer log contains counts only.

---

## 10. Transformation Acceptance and Handover Rules

The implementation has no configurable rejection-rate threshold, manual approval workflow, or separate batch-approval state. Its behavior is per request and per record:

| Overall Condition | Acceptance Decision | Pipeline Action |
|---|---|---|
| `transactions` is an array and contains valid unique rows | **ACCEPTED** | Return accepted transactions with computed hashes. |
| Some rows fail validation or duplicate an earlier hash in the same batch | **PARTIALLY ACCEPTED** | Return accepted rows and rejection summaries with HTTP 200. |
| Every row is rejected | **TRANSFORMATION RESPONSE ACCEPTED** | Return HTTP 200 with `rows_out: 0` and all records in `rejected`; scheduler proceeds with an empty accepted array. |
| `transactions` is missing or is not an array | **REQUEST REJECTED** | Return HTTP 400 `invalid_request`; the scheduler stops that pipeline run and attempts a failure notification. |
| Input array is empty | **ACCEPTED** | Return HTTP 200 with zero counts and empty arrays. |

**Handover:** The scheduler sends only the accepted `transactions` array to `POST /load`, along with the extractor-generated `run_id`. It counts rejected rows in the success summary. The transformer returns rejection details but does not persist or route them. No additional metadata or validation report is handed to the loader.

---

## 11. Common Transformation Problems and Mitigation

### Problem 1: Invalid Transaction Fields

- **Problem Description:** A transaction fails one or more required field checks.
- **Possible Cause:** The upstream data has a missing/empty identifier, non-integer minor-unit amount, incorrectly formatted currency, or unparseable timestamp.
- **Impact on Transformation Process:** That transaction is rejected with the first failing reason code; other rows continue to be processed.
- **Proposed Solution / Mitigation:** Use the returned `index`, `external_id`, and reason to identify the issue. Correct the source record and submit it in a later batch; the transformer does not repair it.

### Problem 2: Duplicate Records Within a Batch

- **Problem Description:** A later valid record produces a hash already seen in the same request.
- **Possible Cause:** The extractor output contains repeated canonical transaction values.
- **Impact on Transformation Process:** The later record is rejected as `duplicate_in_batch`.
- **Proposed Solution / Mitigation:** Review the source data and the returned rejection details. The transformer retains the first matching hash; the loader separately handles duplicates already persisted.

### Problem 3: Request Does Not Contain a Transactions Array

- **Problem Description:** The request body is missing `transactions` or provides a non-array value.
- **Possible Cause:** The caller sent an invalid request shape.
- **Impact on Transformation Process:** The complete request receives HTTP 400 `invalid_request`; no rows are transformed.
- **Proposed Solution / Mitigation:** Send a JSON object with `transactions` as an array. An empty array is valid.

# Transformer Feature

## Instructions

The transformer validates each raw transaction and returns accepted and
rejected records. It does not access the database or call external systems.
Despite the service name, it does not otherwise normalize accepted fields:
accepted transactions preserve their input fields and receive an added
`dedupe_hash`.

1. Obtain the raw transaction array from the extractor.
2. Send it as `transactions` in a JSON request to `POST /transform` on port
   3002.
3. Review the returned `transactions` and `rejected` arrays.
4. Forward only the accepted `transactions` to the loader.

## Architecture

The implementation is in `services/transformer/index.js`. It uses the shared
Express bootstrap (`services/shared/app.js`) and its request/error handling.
The service has two core helpers: `rejectionReason` checks required values and
`dedupeHash` creates a SHA-256 hash of the canonical transaction fields. It
keeps a per-request set of hashes to reject duplicates within the current
batch. It does not connect to SQLite; duplicates already stored are handled by
the loader.

## Tech Stack

- Node.js
- Express.js and the shared HTTP app bootstrap
- Native `crypto` module for SHA-256
- JSON-based local service communication

## Process

1. The caller sends `POST /transform` with a JSON body containing a
   `transactions` array.
2. If `transactions` is missing or not an array, the service returns 400
   `invalid_request`.
3. For each transaction, it checks for a non-empty string `external_id`, an
   integer `amount_minor`, a three-letter uppercase `currency`, and a
   parseable string `transaction_ts`.
4. Invalid rows are added to `rejected` with their zero-based input `index`,
   their string `external_id` when available (otherwise `null`), and a reason:
   `missing_external_id`, `invalid_amount`, `invalid_currency`, or
   `invalid_timestamp`.
5. For each valid row, it computes a hexadecimal SHA-256 `dedupe_hash` over
   `source`, `external_id`, `amount_minor`, `currency`, and `transaction_ts`
   joined with `|`.
6. Repeated hashes in the same batch are rejected as `duplicate_in_batch`.
   Other valid rows are copied with `dedupe_hash` added; the input is not
   mutated.
7. The response contains `rows_in`, `rows_out`, `transactions`, and
   `rejected`. `rows_in` equals `rows_out + rejected.length`.

Timestamp validation checks whether JavaScript can parse the string; it does
not enforce strict ISO 8601 syntax. An empty array succeeds with zero counts.

## Data Flow

The transformer receives raw records from the extractor, validates them, and
returns accepted records with hashes plus rejected records and reasons. The
scheduler sends accepted records to the loader. It counts rejected rows in the
run summary; rejected rows are not persisted by the loader unless another
component explicitly handles them.

## Service Documentation

### Transformer Service

- **Purpose:** Validate raw transactions and identify invalid or in-batch
  duplicate records before database insertion.
- **Responsibilities:** Check required field types and values, compute
  `dedupe_hash`, split accepted and rejected records, and report row counts.
- **Inputs:** `{ "transactions": [...] }` containing raw transaction objects.
- **Outputs:** `{ rows_in, rows_out, transactions, rejected }`; accepted
  transactions retain their fields and include `dedupe_hash`.
- **Dependencies:** Shared Express app bootstrap and native crypto module.
- **Interactions:** Receives raw transactions from the extractor through the
  scheduler and returns accepted records for the loader. The loader handles
  duplicates already present in the database.
