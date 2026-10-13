# GitHub Issues — Local POS ETL Microservices (Week 1)

Seven GitHub Issues, one per day, covering everything the README lists in
section 9 ("Recommended next step") so that `.\start-etl.ps1` works end to end
within one week.

## How these issues are created

This file is rendered by the GitHub CLI through the two launcher files in the
repository root:

- **Double-click `create-github-issues.bat`** — runs the PowerShell script with
  `ExecutionPolicy Bypass` and points it at this `github-issues.md`.
- **Or run from PowerShell:** `powershell -NoProfile -ExecutionPolicy Bypass -File .\create-github-issues.ps1`

Before running either one:

1. Install the [GitHub CLI](https://cli.github.com/) and run `gh auth login`.
2. Run it from inside this repository (the script resolves the current Git repo).

Re-running is safe: `create-github-issues.ps1` checks the repository's existing
issues and skips any issue whose title already exists, so a failed run can simply
be restarted. Each `## Issue N — Title` section below becomes one GitHub Issue;
everything under the heading is used as the issue body.

Suggested labels are written into each issue body for the person creating them
(`gh issue create` is not given labels automatically, so labels that do not exist
yet can be created first: `gh label create "setup"` etc.).

### Recommended issue order

1. Repository skeleton, `.gitignore`, and the start/stop scripts
2. `package.json` and dependencies
3. `scripts/init-db.js` and the SQLite schema
4. The inter-service HTTP contract
5. Entry points for all six services
6. Health checks, readiness, and graceful shutdown
7. Logging, retries, duplicate protection, and the smoke test

### GitHub project board columns

- `Backlog`
- `Ready`
- `In Progress`
- `Review / Testing`
- `Done`

### Scope guardrails

- Keep SQLite as the local database; it needs no server process (README section 7).
- Keep PowerShell as the single startup command: `.\start-etl.ps1` / `.\stop-etl.ps1`.
- Bind services to `127.0.0.1` on the proposed ports 3001–3005 (README section 2).
- The extractor talks to Google Sheets through an Apps Script Web App or the
  Sheets API; credentials stay in `.env` and are never committed (README section 8).
- Every issue must be finishable inside its scheduled day; move scope, not dates.

---

## Issue 1 — Bootstrap the repository skeleton and the PowerShell start/stop scripts

**Suggested labels:** `setup`, `enhancement`, `good first issue`  
**Schedule:** Day 1  
**Goal:** Turn the README's starter scripts into real files and create the folder layout from README section 3.  

The repository currently contains only the README, the license, and the issue
files. The startup script, the stop script, and every directory they expect are
still missing, so this issue unblocks the whole week.

### Tasks

- [x] Create `services\{scheduler,extractor,transformer,loader,reporter,notifier}`, `scripts`, `data`, and `logs`.
- [x] Add `start-etl.ps1` from README section 4 (Node check, `npm install`, DB init, PID file).
- [x] Add `stop-etl.ps1` from README section 5 (stop recorded PIDs, remove PID file).
- [x] Add `.gitignore` covering `node_modules/`, `logs/`, `data/*.db*`, and `.env`.
- [x] Confirm `data/` and `logs/` are created by the startup script when missing.

### Acceptance criteria

- [x] `.\start-etl.ps1` runs on a clean checkout and only warns that `index.js` entry points are missing.
- [x] `.\stop-etl.ps1` exits cleanly when no PID file exists.
- [x] `git status` stays clean after a start/stop cycle (logs, data, and `.env` are ignored).

### Dependencies

None. Complete this first.

### Day 1 notes

Verified on 2026-10-13: `.\start-etl.ps1` completes with only the six
"index.js not found" warnings, `.\stop-etl.ps1` exits 0 both with and without a
PID file, `logs/` and `data/` are recreated when deleted, and a start/stop cycle
leaves `git status` free of runtime noise.

Two minimal extras were added because the README's startup script cannot run at
all without them:

- `package.json` with project identity and npm scripts only — Issue 2 still owns
  the dependencies, `package-lock.json`, and `.env.example`.
- `scripts/init-db.js` as a placeholder that just creates `data/` — Issue 3
  replaces it with the real SQLite schema.

---

## Issue 2 — Add package.json, dependencies, and the environment template

**Suggested labels:** `setup`, `documentation`  
**Schedule:** Day 2  
**Goal:** Give `start-etl.ps1` something to install and give every service one configuration source.  

The startup script runs `npm install` when `node_modules` is missing and README
section 8 requires credentials to live outside the repository.

### Tasks

- [x] Create `package.json` (`private: true`, `engines.node >= 18`) with dependencies `express`, `better-sqlite3`, `dotenv`, `node-cron`.
- [x] Add npm scripts: `db:init` → `node scripts/init-db.js`, `etl:start` / `etl:stop` → the PowerShell scripts, `health` → `node scripts/health-check.js`.
- [x] Add `.env.example` documenting `PORT_EXTRACTOR=3001` … `PORT_NOTIFIER=3005`, `SCHEDULER_PORT`, `DB_PATH=./data/pos.db`, `SHEETS_ENDPOINT`, `APPS_SCRIPT_URL`, `API_TOKEN`, `LOG_DIR=./logs`, `ETL_CRON`.
- [x] Add `services/shared/config.js` that loads `.env`, applies defaults, and fails fast with one readable message when a required value is missing.
- [ ] Commit `package-lock.json` (generated and verified; pending review of the Day 1 + Day 2 batch).

### Acceptance criteria

- [x] A clean `npm install` completes without errors on Windows.
- [x] Copying `.env.example` to `.env` is enough to configure every service.
- [x] No secret values are committed; `.env` remains ignored.

### Dependencies

Issue 1.

### Day 2 notes

Verified on 2026-10-13:

- Clean `npm install` with `node_modules` deleted completes and `better-sqlite3`
  loads (SQLite 3.53.2).
- **npm 12 gotcha:** npm 12 blocks dependency install scripts unless allow-listed,
  and `better-sqlite3` needs its native build to function. The approval lives in
  `package.json` as `"allowScripts": { "better-sqlite3@12.11.1": true }`, so a
  clean checkout builds it automatically — no extra step for teammates.
- `services/shared/config.js` throws one combined readable error listing every
  missing required value (`SHEETS_ENDPOINT`, `API_TOKEN`) or malformed port, and
  names the `.env` file to fix.
- `npm run health` is wired, but `scripts/health-check.js` only arrives on Day 6 (Issue 6).
- Local `.env` is a copy of `.env.example` with placeholder values only and stays gitignored.

---

## Issue 3 — Implement scripts/init-db.js and the SQLite schema

**Suggested labels:** `enhancement`, `database`  
**Schedule:** Day 3  
**Goal:** Make the "Initializing database..." step of `start-etl.ps1` succeed and give the loader a schema with duplicate protection.  

The startup script aborts before launching any service when
`node .\scripts\init-db.js` exits non-zero, so this file must exist and be
idempotent.

### Tasks

- [x] Create `data/` if missing and open the database with `PRAGMA journal_mode=WAL`.
- [x] `transactions` table: `id`, `external_id`, `source`, `amount_minor`, `currency`, `transaction_ts`, `payload_json`, `dedupe_hash TEXT UNIQUE`, `created_at`.
- [x] `etl_runs` table: `run_id`, `started_at`, `finished_at`, `status`, `rows_in`, `rows_out`, `error`.
- [x] `notifications` table: `id`, `channel`, `subject`, `body`, `sent_at`.
- [x] Indexes on `transactions.transaction_ts` and `etl_runs.started_at`.
- [x] Use `IF NOT EXISTS` everywhere so a second run changes nothing.

### Acceptance criteria

- [x] `node scripts/init-db.js` succeeds twice in a row.
- [x] Inserting the same `dedupe_hash` twice is rejected by the unique constraint.
- [x] `.\start-etl.ps1` gets past the database step and starts reaching the per-service loop.

### Dependencies

Issue 2.

### Day 3 notes

Verified on 2026-10-13:

- `npm run db:init` twice: first run creates `data/pos.db` in WAL mode, the
  second opens it and changes nothing; both exit 0.
- A duplicate `dedupe_hash` insert is rejected with
  `UNIQUE constraint failed: transactions.dedupe_hash` and exactly one row remains.
- `.\start-etl.ps1` initializes the database and reaches the six per-service
  warnings, exit 0.
- Schema choices: `amount_minor` is INTEGER cents (no float drift), timestamps
  are ISO-8601 text, `etl_runs.run_id` is the primary key for run tracking, and
  `dedupe_hash` is what the loader will use for `INSERT OR IGNORE` on Day 7.
- Behavior change: `db:init` now loads config like the services do, so a `.env`
  must exist — on a fresh checkout copy `.env.example` to `.env` first (Issue 2).

---

## Issue 4 — Define the inter-service HTTP contract

**Suggested labels:** `documentation`, `enhancement`  
**Schedule:** Day 4  
**Goal:** Agree on request/response shapes before writing the six entry points (README section 2: HTTP on localhost between services).  

### Tasks

- [x] Add `docs/http-contract.md` with the port table (extractor 3001, transformer 3002, loader 3003, reporter 3004, notifier 3005, scheduler on its configured port) and the base URL rule `http://127.0.0.1:<port>`.
- [x] Define `GET /health` for every service → `{ "service", "status", "version", "uptime_s" }`.
- [x] Define `POST /extract { since? }` → `{ run_id, rows, transactions[] }`.
- [x] Define `POST /transform { transactions[] }` → `{ rows_in, rows_out, transactions[], rejected[] }`.
- [x] Define `POST /load { run_id, transactions[] }` → `{ inserted, skipped_duplicates }`.
- [x] Define `GET /report/daily?date=YYYY-MM-DD` and `POST /notify { channel, subject, body }`.
- [x] Define the error envelope `{ "error": { "code", "message" } }`, statuses 400 / 500 / 503, JSON only, 10s client timeout.

### Acceptance criteria

- [x] Every endpoint lists method, path, request, response, and failure mode.
- [x] Issue 5 can be implemented from this document alone.

### Dependencies

Issue 2 (ports and configuration come from `.env`).

### Day 4 notes

Verified on 2026-10-13:

- `docs/http-contract.md` covers all six services; every endpoint lists request,
  response, status codes, and failure modes.
- Decisions locked in for Day 5: the extractor mints `run_id` and the scheduler
  threads it into `/load`; the transformer computes `dedupe_hash` (SHA-256 over
  `source`, `external_id`, `amount_minor`, `currency`, `transaction_ts`); the
  loader upserts `etl_runs` on success; empty results are always 200, never errors.
- The curl smoke commands were run against a live listener: on Windows
  PowerShell 5.1 the `-d` payload needs `\"` escaping (pwsh 7+ drops the
  backslashes) — documented in the contract's quoting note.

---

## Issue 5 — Implement entry points for all six services

**Suggested labels:** `enhancement`  
**Schedule:** Day 5  
**Goal:** Make `.\start-etl.ps1` launch all six Node.js services instead of skipping them.  

`start-etl.ps1` starts any service that has `services\<name>\index.js` and writes
each process's output to `logs\<service>.out.log` / `.err.log`.

### Tasks

- [x] Add one `index.js` per service that loads `services/shared/config.js`.
- [x] Bind to `127.0.0.1` on the configured port (3001–3005, scheduler on its own).
- [x] Implement the endpoints from `docs/http-contract.md`; stub business logic is fine for reporter and notifier as long as the shapes are real.
- [x] Implement `GET /health` on every service.
- [x] Log one structured startup line and exit with code 1 plus a readable message when configuration is invalid.

### Acceptance criteria

- [x] `.\start-etl.ps1` reports six started processes with no "exited immediately" warnings.
- [x] `curl http://127.0.0.1:3001/health` (and 3002–3005) returns the documented JSON.
- [x] `logs\<service>.out.log` contains the startup line for each service.

### Dependencies

Issues 3 and 4.

### Day 5 notes

Verified on 2026-10-13:

- All six services start from `.\start-etl.ps1` (6 processes, no warnings), answer
  `/health` on 3001–3006 with the contract shape, and write a JSON startup line
  to their `.out.log`. All `.err.log` files empty.
- 18 endpoint checks passed covering: transform validation + all five rejection
  reasons + `dedupe_hash`, loader insert then duplicate-skip, reporter day/empty/
  bad-date, notifier log/stub/bad-channel, extractor 500-envelope on unreachable
  Sheets + 400 on bad `since`, plus 404 and malformed-JSON envelopes.
- Full pipeline E2E with a mock Sheets endpoint and a `* * * * *` cron tick:
  extract 3 → transform (1 rejected: bad amount) → load 2 → notify "ETL run
  completed". The **second** tick loaded 0 and skipped the same rows as
  duplicates — cross-run duplicate protection proven end to end.
- Shared bootstrap lives in `services/shared/app.js` (health, error envelope,
  5 MB JSON limit, startup line, config-failure exit 1) so the six entry points
  stay small and contract-consistent.
- Test rows, cron overrides, and throwaway files were removed afterwards; the
  stack was restarted from the real `.env` and re-verified healthy.

---

## Issue 6 — Add health checks, readiness waits, and graceful shutdown

**Suggested labels:** `enhancement`  
**Schedule:** Day 6  
**Goal:** Make the start/stop scripts safe: wait for readiness before declaring success, and never kill a process mid-write into SQLite.  

### Tasks

- [x] Handle `SIGTERM` / `SIGINT` in every service: stop accepting connections, close the database, exit 0.
- [x] Add `scripts/health-check.js` polling every `/health` endpoint with a timeout.
- [x] Make `start-etl.ps1` poll `/health` before printing "Startup commands completed."
- [x] Make `stop-etl.ps1` request a graceful stop first, wait, then force-kill only if still alive.
- [x] Verify a PID belongs to a `node` process before terminating it.

### Acceptance criteria

- [x] `.\stop-etl.ps1` leaves no orphaned node processes and no corrupted `data\pos.db`.
- [x] `npm run health` exits 0 while the stack is up and 1 after it stops.
- [x] Restarting immediately after stopping works without manual cleanup.

### Dependencies

Issue 5.

### Day 6 notes

Verified on 2026-10-13:

- Graceful stop on Windows uses a stop marker (`logs\<service>.stop`) because
  `Stop-Process` cannot deliver SIGTERM to a console process; services also
  handle SIGINT/SIGTERM where the OS can send them. All six services log
  `{"event":"shutdown","reason":"stop-file"}` and exit 0.
- `.\stop-etl.ps1` refuses to touch a PID that is not a node process, waits 5s
  for a graceful exit, and only then force-kills (both paths verified live).
- `start-etl.ps1` waits for `/health` on every started service (`--wait 15`)
  before printing "Startup commands completed"; full start-to-healthy ≈ 3.5s.
- **Two bugs found and fixed while testing:** (1) `npm run health` crashed with a
  libuv assertion on exit because fetch keep-alive sockets were still closing —
  probes now use `node:http` with `agent: false`; (2) the README's PID-file
  parsing nests arrays on Windows PowerShell 5.1 (`ConvertFrom-Json` emits a
  top-level JSON array as one object), which silently made the stop script a
  no-op with 6 running services — both scripts now unwrap it explicitly.
- `PRAGMA integrity_check` = ok after stops; immediate restart works with no
  manual cleanup.

---

## Issue 7 — Add logging, retries, duplicate protection, and an end-to-end smoke test

**Suggested labels:** `enhancement`, `documentation`  
**Schedule:** Day 7  
**Goal:** Make the pipeline trustworthy and leave the README matching reality (README section 6).  

### Tasks

- [x] Add `services/shared/logger.js`: one JSON-lines file per service under `logs\` plus mirrored console output (so `start-etl.ps1` redirection stays useful).
- [x] Add a retry helper (3 attempts, exponential backoff) used by the extractor and loader HTTP calls.
- [x] Make the loader use `INSERT OR IGNORE` keyed on `dedupe_hash` and report `skipped_duplicates`.
- [x] Add `scripts/smoke-test.js` that runs extract → transform → load against fixture data and asserts row counts and dedupe behaviour.
- [x] Update README section 6 with the new commands (`npm run health`, `npm run smoke`, log locations).

### Acceptance criteria

- [x] Running the smoke test twice in a row inserts rows only once.
- [x] `logs\*.jsonl` contains one line per event for a full pipeline run.
- [x] A new contributor can start, verify, and stop the stack using only the README.

### Dependencies

Issues 5 and 6.

### Day 7 notes

Verified on 2026-10-13:

- `services/shared/logger.js` appends one JSON object per event to
  `logs\<service>.jsonl` and mirrors every line to the console, so the
  `.out/.err` capture from `start-etl.ps1` keeps working; a failed log write
  never takes a service down. All six services now emit structured events
  (startup, extract, transform, load, report, notify, cron, pipeline, retry,
  error, shutdown).
- `services/shared/retry.js`: 3 attempts, 250 ms -> 500 ms backoff; retries
  transport errors and HTTP 5xx, fails fast on 4xx and malformed bodies.
  Wired into the extractor's Google Sheets call and every scheduler hop
  (extract/transform/load/notify) - which is how the pipeline's POST /load
  call gets retried. Retrying /load is safe because INSERT OR IGNORE is
  idempotent per dedupe_hash.
- Retries verified three ways: unit (3 attempts, 774 ms total), a live 5xx
  probe (endpoint hit exactly 3x, `{"event":"retry",...}` warn lines in the
  jsonl), and the real 08:45 cron tick (scheduler retried the extractor's
  500s, then logged `pipeline_failed` followed by a `notify`).
- Loader duplicate protection (INSERT OR IGNORE + `skipped_duplicates`) was
  already Day 5 code; the smoke test now proves it end to end: run 1 loaded
  2 rows (before=0), run 2 loaded 0 and skipped 2 (before=2), the database
  held exactly 2 `SMOKE-` rows after both, and `etl_runs.rows_out=0` for the
  duplicate run.
- `npm run smoke` = 11 checks, green on consecutive runs. It starts a
  throwaway extractor on port 3099 with `LOG_DIR=logs\smoke` against an
  in-process mock Sheets endpoint, drives the real transformer and loader,
  and finishes by asserting the jsonl logs received the run.
- JSON-lines AC: 6 `logs\*.jsonl` files, 40 events, every line a parseable
  `{ts,service,level,event,...}` object - including a full cron pipeline run
  (retry -> pipeline_failed -> notify) and `shutdown` events from all six
  services. The files append across restarts (12 startup / 12 shutdown
  events after two start-stop cycles); DB `integrity_check` = ok throughout.
- README section 6 now covers first-time setup (`npm install`, `.env`),
  `npm run health`, `npm run smoke`, the graceful stop, and both log
  locations; sections 4/5 warn not to overwrite the shipped scripts with the
  starter listings. Every documented command was executed during
  verification: start -> health -> smoke x2 -> stop -> restart -> stop.
- Until `SHEETS_ENDPOINT` points at a real endpoint, cron runs end in
  `pipeline_failed` + a `notify` (the placeholder 404s) - that is the
  documented retry/failure path working as designed, not a defect.
- Session note: PR #12's main-into-day6 merge had resolved `app.js` to the
  Day 5 copy, dropping the Issue 6 shutdown/banner code; restored on `day6`
  (4123576) before Day 7 was built on top of it.
- Follow-up UX: `start-etl.ps1` now prints each service's endpoint as it
  starts (`Starting extractor on 127.0.0.1:3001...`, port resolved from
  `.env` like `config.js`) and a final green/red service board (endpoint,
  status, PID, log file, last event parsed from the jsonl); `npm run health`
  shows `host:port` per service; README section 6 documents the live watch
  command (`Get-Content .\logs\*.jsonl -Wait -Tail 5`).
- Screen-clutter fix: services now launch with `-WindowStyle Hidden` in
  `start-etl.ps1`, so `npm run etl:start` no longer opens six blank console
  windows (verified: zero new visible windows across a full
  start/health/stop cycle via `EnumWindows`); output still lands in
  `logs\*.out.log`/`*.err.log`, and each service keeps its own hidden
  console, so it still outlives the terminal that started it.
