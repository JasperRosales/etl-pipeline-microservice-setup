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

- [ ] Create `data/` if missing and open the database with `PRAGMA journal_mode=WAL`.
- [ ] `transactions` table: `id`, `external_id`, `source`, `amount_minor`, `currency`, `transaction_ts`, `payload_json`, `dedupe_hash TEXT UNIQUE`, `created_at`.
- [ ] `etl_runs` table: `run_id`, `started_at`, `finished_at`, `status`, `rows_in`, `rows_out`, `error`.
- [ ] `notifications` table: `id`, `channel`, `subject`, `body`, `sent_at`.
- [ ] Indexes on `transactions.transaction_ts` and `etl_runs.started_at`.
- [ ] Use `IF NOT EXISTS` everywhere so a second run changes nothing.

### Acceptance criteria

- [ ] `node scripts/init-db.js` succeeds twice in a row.
- [ ] Inserting the same `dedupe_hash` twice is rejected by the unique constraint.
- [ ] `.\start-etl.ps1` gets past the database step and starts reaching the per-service loop.

### Dependencies

Issue 2.

---

## Issue 4 — Define the inter-service HTTP contract

**Suggested labels:** `documentation`, `enhancement`  
**Schedule:** Day 4  
**Goal:** Agree on request/response shapes before writing the six entry points (README section 2: HTTP on localhost between services).  

### Tasks

- [ ] Add `docs/http-contract.md` with the port table (extractor 3001, transformer 3002, loader 3003, reporter 3004, notifier 3005, scheduler on its configured port) and the base URL rule `http://127.0.0.1:<port>`.
- [ ] Define `GET /health` for every service → `{ "service", "status", "version", "uptime_s" }`.
- [ ] Define `POST /extract { since? }` → `{ run_id, rows, transactions[] }`.
- [ ] Define `POST /transform { transactions[] }` → `{ rows_in, rows_out, transactions[], rejected[] }`.
- [ ] Define `POST /load { run_id, transactions[] }` → `{ inserted, skipped_duplicates }`.
- [ ] Define `GET /report/daily?date=YYYY-MM-DD` and `POST /notify { channel, subject, body }`.
- [ ] Define the error envelope `{ "error": { "code", "message" } }`, statuses 400 / 500 / 503, JSON only, 10s client timeout.

### Acceptance criteria

- [ ] Every endpoint lists method, path, request, response, and failure mode.
- [ ] Issue 5 can be implemented from this document alone.

### Dependencies

Issue 2 (ports and configuration come from `.env`).

---

## Issue 5 — Implement entry points for all six services

**Suggested labels:** `enhancement`  
**Schedule:** Day 5  
**Goal:** Make `.\start-etl.ps1` launch all six Node.js services instead of skipping them.  

`start-etl.ps1` starts any service that has `services\<name>\index.js` and writes
each process's output to `logs\<service>.out.log` / `.err.log`.

### Tasks

- [ ] Add one `index.js` per service that loads `services/shared/config.js`.
- [ ] Bind to `127.0.0.1` on the configured port (3001–3005, scheduler on its own).
- [ ] Implement the endpoints from `docs/http-contract.md`; stub business logic is fine for reporter and notifier as long as the shapes are real.
- [ ] Implement `GET /health` on every service.
- [ ] Log one structured startup line and exit with code 1 plus a readable message when configuration is invalid.

### Acceptance criteria

- [ ] `.\start-etl.ps1` reports six started processes with no "exited immediately" warnings.
- [ ] `curl http://127.0.0.1:3001/health` (and 3002–3005) returns the documented JSON.
- [ ] `logs\<service>.out.log` contains the startup line for each service.

### Dependencies

Issues 3 and 4.

---

## Issue 6 — Add health checks, readiness waits, and graceful shutdown

**Suggested labels:** `enhancement`  
**Schedule:** Day 6  
**Goal:** Make the start/stop scripts safe: wait for readiness before declaring success, and never kill a process mid-write into SQLite.  

### Tasks

- [ ] Handle `SIGTERM` / `SIGINT` in every service: stop accepting connections, close the database, exit 0.
- [ ] Add `scripts/health-check.js` polling every `/health` endpoint with a timeout.
- [ ] Make `start-etl.ps1` poll `/health` before printing "Startup commands completed."
- [ ] Make `stop-etl.ps1` request a graceful stop first, wait, then force-kill only if still alive.
- [ ] Verify a PID belongs to a `node` process before terminating it.

### Acceptance criteria

- [ ] `.\stop-etl.ps1` leaves no orphaned node processes and no corrupted `data\pos.db`.
- [ ] `npm run health` exits 0 while the stack is up and 1 after it stops.
- [ ] Restarting immediately after stopping works without manual cleanup.

### Dependencies

Issue 5.

---

## Issue 7 — Add logging, retries, duplicate protection, and an end-to-end smoke test

**Suggested labels:** `enhancement`, `documentation`  
**Schedule:** Day 7  
**Goal:** Make the pipeline trustworthy and leave the README matching reality (README section 6).  

### Tasks

- [ ] Add `services/shared/logger.js`: one JSON-lines file per service under `logs\` plus mirrored console output (so `start-etl.ps1` redirection stays useful).
- [ ] Add a retry helper (3 attempts, exponential backoff) used by the extractor and loader HTTP calls.
- [ ] Make the loader use `INSERT OR IGNORE` keyed on `dedupe_hash` and report `skipped_duplicates`.
- [ ] Add `scripts/smoke-test.js` that runs extract → transform → load against fixture data and asserts row counts and dedupe behaviour.
- [ ] Update README section 6 with the new commands (`npm run health`, `npm run smoke`, log locations).

### Acceptance criteria

- [ ] Running the smoke test twice in a row inserts rows only once.
- [ ] `logs\*.jsonl` contains one line per event for a full pipeline run.
- [ ] A new contributor can start, verify, and stop the stack using only the README.

### Dependencies

Issues 5 and 6.
