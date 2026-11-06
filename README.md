# Local POS ETL Microservices — PowerShell Starter

## 1. Overview

Use PowerShell as the single startup command for the local ETL microservices. One script initializes the database and launches the Node.js services, avoiding the need to open multiple terminals manually.

### Technology stack

- **PowerShell** — starts and stops the local services.
- **Node.js** — runs each microservice.
- **SQLite** — local database; no separate database server process is required.
- **HTTP on localhost** — enables communication between services.
- **`node-cron`** — schedules ETL runs inside the scheduler service.

SQLite should be initialized before the services start. The database file and tables can be created automatically if they do not exist.

The main objectives of the project are to:

- provide a simple, local-first ETL workflow for POS-style data;
- isolate responsibilities into dedicated microservices;
- make setup and operation repeatable through PowerShell scripts;
- ensure each pipeline stage can be independently tested and monitored;
- maintain a clear contract between services via HTTP endpoints and shared configuration; and
- allow the system to be run and stopped reliably with health checks and graceful shutdown behavior.

The system is organized around six services: extractor, transformer, loader, reporter, notifier, and scheduler. Shared utilities handle configuration, HTTP bootstrapping, structured logging, and database initialization.

## 3.2 Table of Contents

- [Project Overview](docs/project-overview.md)
- [ETL Setup and System Configuration](docs/etl-setup.md)
- [Extractor Feature](docs/extractor.md)
- [Transformer Feature](docs/transformer.md)
- [Loader Feature](docs/loader.md)
- [Reporter Feature](docs/reporter.md)
- [Notifier Feature](docs/notifier.md)
- [Scheduler Feature](docs/scheduler.md)
- [Shared Infrastructure and Database](docs/shared-infrastructure.md)

## 3.3 Members

| Member | Role |
|---|---|
| Rosales Jasper B. | Master |
| Mendoza Iladio T. | Documentation |
| Agquiz Nino Joseph B. | Issuer |

## 2. Workflow

1. Run `.\start-etl.ps1`.
2. PowerShell checks that Node.js is available.
3. PowerShell installs dependencies if `node_modules` is missing.
4. The database initialization script creates the SQLite database and tables if needed.
5. PowerShell launches the available Node.js services as separate processes.
6. Each service writes output to its own log files.
7. Use `.\stop-etl.ps1` to stop the recorded service processes.

### Services

| Service | Local port | Responsibility |
|---|---:|---|
| Extractor | 3001 | Reads transaction data from a CSV file (`CSV_PATH`) |
| Transformer | 3002 | Validates, cleans, and deduplicates extracted data |
| Loader | 3003 | Stores processed transactions in SQLite |
| Reporter | 3004 | Generates sales reports |
| Notifier | 3005 | Sends or records notifications |
| Scheduler | Depends on implementation | Triggers the ETL pipeline on a schedule |

The ports are proposed defaults. Configure the actual services to use these ports and bind to `127.0.0.1` for local-only access.

## 3. Recommended project structure

```text
pos-etl-local/
├── services/
│   ├── scheduler/
│   │   └── index.js
│   ├── extractor/
│   │   └── index.js
│   ├── transformer/
│   │   └── index.js
│   ├── loader/
│   │   └── index.js
│   ├── reporter/
│   │   └── index.js
│   └── notifier/
│       └── index.js
├── scripts/
│   └── init-db.js
├── data/
├── logs/
├── start-etl.ps1
├── stop-etl.ps1
├── package.json
└── .env
```

## 4. PowerShell startup script

Save the following as `start-etl.ps1` in the project root.

```powershell
$ErrorActionPreference = "Stop"

$ProjectRoot = $PSScriptRoot
$Services = @(
    "extractor",
    "transformer",
    "loader",
    "reporter",
    "notifier",
    "scheduler"
)

$LogDir = Join-Path $ProjectRoot "logs"
$PidFile = Join-Path $LogDir "service-pids.json"

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $ProjectRoot "data") | Out-Null

Write-Host "`n=== Local POS ETL Startup ===" -ForegroundColor Cyan

# Check Node.js
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "Node.js is not installed or is missing from PATH."
}

# Install dependencies if needed
if (-not (Test-Path (Join-Path $ProjectRoot "node_modules"))) {
    Write-Host "Installing project dependencies..." -ForegroundColor Yellow
    Push-Location $ProjectRoot
    try {
        npm install
        if ($LASTEXITCODE -ne 0) {
            throw "npm install failed."
        }
    }
    finally {
        Pop-Location
    }
}

# Initialize the SQLite database and tables
Write-Host "Initializing database..." -ForegroundColor Yellow
Push-Location $ProjectRoot
try {
    node .\scripts\init-db.js
    if ($LASTEXITCODE -ne 0) {
        throw "Database initialization failed. Services were not started."
    }
}
finally {
    Pop-Location
}

# Prevent accidental duplicate startup
if (Test-Path $PidFile) {
    $Existing = Get-Content $PidFile -Raw | ConvertFrom-Json
    $Running = @($Existing | Where-Object {
        Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
    })

    if ($Running.Count -gt 0) {
        throw "Services may already be running. Run .\stop-etl.ps1 first."
    }

    Remove-Item $PidFile -Force
}

$Started = @()

foreach ($Service in $Services) {
    $ServiceDir = Join-Path $ProjectRoot "services\$Service"
    $EntryPoint = Join-Path $ServiceDir "index.js"

    if (-not (Test-Path $EntryPoint)) {
        Write-Warning "Skipping $Service`: index.js not found."
        continue
    }

    $Stdout = Join-Path $LogDir "$Service.out.log"
    $Stderr = Join-Path $LogDir "$Service.err.log"

    Write-Host "Starting $Service..." -ForegroundColor Green

    $Process = Start-Process `
        -FilePath (Get-Command node).Source `
        -ArgumentList "index.js" `
        -WorkingDirectory $ServiceDir `
        -RedirectStandardOutput $Stdout `
        -RedirectStandardError $Stderr `
        -PassThru

    $Started += [PSCustomObject]@{
        Service   = $Service
        ProcessId = $Process.Id
    }

    Start-Sleep -Milliseconds 300

    if ($Process.HasExited) {
        Write-Warning "$Service exited immediately. Check $Stderr"
    }
}

$Started | ConvertTo-Json |
    Set-Content -Path $PidFile -Encoding utf8

Write-Host "`nStartup commands completed." -ForegroundColor Cyan
Write-Host "Started processes: $($Started.Count)"
Write-Host "Logs: $LogDir"
Write-Host "Stop with: .\stop-etl.ps1"
```

### Startup script prerequisites

This script assumes:

- Each service has an `index.js` entry point.
- `scripts/init-db.js` exists and initializes the SQLite database.
- `package.json` is present and lists the required dependencies.
- Each service handles its own configuration and startup errors.

This is a starter script, not a complete implementation of the database initializer or microservices. It launches services as separate processes and records their process IDs for shutdown.

The repository already ships a `start-etl.ps1` with everything above plus dependency installation, duplicate-startup protection, stale stop-marker cleanup, and a readiness wait on `GET /health` for every service before it reports success. Use the shipped file — do not replace it with the starter listing above.

## 5. PowerShell stop script

Save the following as `stop-etl.ps1` in the project root.

```powershell
$ProjectRoot = $PSScriptRoot
$PidFile = Join-Path $ProjectRoot "logs\service-pids.json"

if (-not (Test-Path $PidFile)) {
    Write-Host "No service PID file found."
    exit 0
}

$Services = @(Get-Content $PidFile -Raw | ConvertFrom-Json)

foreach ($Service in $Services) {
    $Process = Get-Process -Id $Service.ProcessId -ErrorAction SilentlyContinue

    if ($Process) {
        Write-Host "Stopping $($Service.Service)..."
        Stop-Process -Id $Service.ProcessId
    }
}

Remove-Item $PidFile -Force
Write-Host "Stop commands completed."
```

This basic stop script stops the recorded Node.js processes. The repository already ships a hardened `stop-etl.ps1`: it unwraps PowerShell 5.1's single-object JSON array, refuses to touch a PID that is no longer a `node` process, writes a `logs\<service>.stop` marker for a graceful shutdown, waits 5 seconds, and only then force-kills. Use the shipped file — do not replace it with the starter listing above.

## 6. Running the system

Open PowerShell in the project directory.

### First-time setup

```powershell
npm install
Copy-Item .env.example .env    # works as is with the bundled CSV
```

The extractor reads sales from a CSV file. `.env.example` points it at the
bundled demo file (120 sales):

```
CSV_PATH=./data/transactions.csv
```

The file needs a header row with at least an `id` column; the usual columns
are `id,timestamp,amount,currency,store_id,cashier_id,payment_method,discount,items`,
with `items` as a JSON array in one quoted cell. See
[docs/extractor.md](docs/extractor.md) for the full format. The file is read
again on every run, so rows you append are loaded on the next run and rows
already loaded are skipped as duplicates.

### Start all services

```powershell
.\start-etl.ps1
```

Initializes the database, starts all six services, and waits until every one answers `GET /health` before printing `Startup commands completed.`

The scheduler runs the pipeline every **30 seconds** (`ETL_CRON=*/30 * * * * *`,
6-field cron with seconds first). If a run is still going when the next tick
fires, that tick is skipped and logged as `tick_skipped`. Use a 5-field
expression such as `*/15 * * * *` for a slower schedule.

### Start one service on its own

```powershell
npm run start:extractor      # 3001
npm run start:transformer    # 3002
npm run start:loader         # 3003 (initializes the database first)
npm run start:reporter       # 3004 (initializes the database first)
npm run start:notifier       # 3005 (initializes the database first)
npm run start:scheduler      # 3006
```

Each command runs one service in the foreground of the current terminal and
prints its output there. Stop it with `Ctrl+C`. Use this to work on or debug a
single service. A service that calls others (the scheduler, or
`npm run pipeline`) still needs those services running too.

### Run the pipeline once and show every output

```powershell
npm run pipeline             # add -- --full to print every row
```

Calls each service in order (health, extract, transform, load, notify, daily
and activity reports) and prints every response. Requires the stack to be running.

### Test the pipeline with wrong data

```powershell
npm run pipeline:bad                 # transform + load + report the sample file
npm run pipeline:bad -- --no-load    # transform only, nothing written to the database
npm run pipeline -- --input my-cases.json
```

`data/samples/bad-transactions.json` holds 23 sample transactions: one or
more for every transformer rejection reason (`missing_external_id` through
`duplicate_in_batch`) plus two valid control rows. Each case says which
reason it should get (`"expect"`, or `null` for valid). The run skips the
extractor, sends the file to the transformer, and prints an
expected-vs-actual table. It exits with code 1 if any case does not match.

To test a new kind of wrong data, add a case to the file (or write your own file
in the same shape) with the reason you expect. The two valid rows
(`SAMPLE-OK-001`, `SAMPLE-OK-002`, dated 2026-01-15, store `STORE-SAMPLE`)
are loaded into the database once. Later runs count them as duplicates, and
`npm run db:reset` removes them.

### Seed the database

```powershell
npm run db:init
npm run db:seed              # load every sale in CSV_PATH (data\transactions.csv: 120 sales)
npm run db:reset             # empty the tables, then load the CSV again
```

The seed sends every row through the same code as a pipeline run (extractor
CSV reading and mapping, transformer checks, loader checks and insert). The rows therefore get
the same types as real ones: `source` `csv`, `amount_minor` as whole
centavos, `transaction_ts` in ISO 8601 UTC. It prints any rejected rows with
their reason, and running it again only reports duplicates.

If your database was loaded when `source` was still `salsa-pos-api` (or
`google-sheets`), run `npm run db:reset` once. `source` is part of
the duplicate check, so otherwise every sale is stored twice, once under each
name.

### Run the validator tests

```powershell
npm test
```

Runs the unit and HTTP tests in `test\` with `node --test`. They cover the
extractor's CSV reading and row mapping, the transformer validators and dedupe
hash, the config validator (ports, CSV path, cron), and request validation on
every service. The full list of checks is in
[docs/http-contract.md](docs/http-contract.md). You do not need the stack running: each test
starts its own services on spare ports with a temporary database.

### Check service health

```powershell
npm run health
```

Exit code `0` = all six services healthy (script-friendly); `1` = at least one service is down.

### Run the end-to-end smoke test

```powershell
npm run smoke
```

Drives the full extract -> transform -> load pipeline against fixture data and asserts row counts and duplicate protection. Requires the stack to be running. Safe to rerun as often as you like: fixture rows are prefixed `SMOKE-` and are inserted into the database exactly once ever — later runs report them as `skipped_duplicates`.

### Stop all services

```powershell
.\stop-etl.ps1
```

Asks each service to shut down gracefully via a `logs\<service>.stop` marker, waits 5 seconds, then force-kills only what is still alive (and only after verifying the PID belongs to a `node` process).

### View recent extractor errors

```powershell
Get-Content .\logs\extractor.err.log -Tail 50
```

### View the structured event log

```powershell
Get-Content .\logs\extractor.jsonl -Tail 50
```

Every service writes each event twice:

- `logs\<service>.jsonl`: one JSON object per line, for tools and scripts.
- `logs\<service>.out.log` / `logs\<service>.err.log`: the same events as one
  readable line each (also what `npm run start:<service>` prints), e.g.
  `2026-11-04 05:52:08Z WARN  [transformer] transform_rejected run_id=b3f1 index=4 external_id=SALSA-TX-00005 reason=invalid_amount`.

To check that a service actually did its job, follow these events:

| Service | Events |
|---|---|
| every service | `request` for each call (method, path, status, duration; plus `error`/`message` on a 4xx/5xx). `GET /health` is not logged. |
| extractor | `extract` (rows, rejected, first/last id); `extract_rejected` per CSV row it could not map |
| transformer | `transform` (rows_in, rows_out, rejected, counts by reason); `transform_rejected` per rejected row (index, external_id, reason) |
| loader | `load_inserted` per newly stored row; `load` (rows, inserted, skipped_duplicates, first 5 skipped ids) |
| notifier | `notify` (notification_id, channel, delivered, subject, body) |
| reporter | `report` (date, count, total, warnings); `activity` |
| scheduler | `pipeline_start`, `stage_ok` after extract / transform / load, then `pipeline_ok` or `pipeline_failed` |

Lines from one run share its `run_id`, so `Select-String b3f1 .\logs\*.out.log` shows that run across every service.

The first run requires the database initialization script and service entry points to exist. The startup script skips any service whose `index.js` file is missing.

## 7. Database choice

SQLite is recommended for the local prototype because it does not require a separate database server process. If the project later moves to PostgreSQL or MySQL, the startup script will also need to start or verify the database server.

## 8. Data source

The extractor reads transactions from the local CSV file at `CSV_PATH`
(default `data/transactions.csv`), so the pipeline needs no internet access and
no API token. Set `CSV_PATH` in `.env` to use a different file. A row with an
empty `currency` cell is loaded as `PHP`. Do not commit
real customer data to the repository.

## 9. Recommended next step

Create the missing project files so the starter works end to end:

- `package.json` and dependencies
- `.env.example`
- `scripts/init-db.js` and the SQLite schema
- Entry points for all six services
- A consistent HTTP contract between services
- Health-check endpoints, startup readiness checks, and graceful shutdown
- Logging, retries, and duplicate-transaction protection

Once these are implemented, `.\start-etl.ps1` can serve as the single command to initialize the database and start the complete local ETL environment.
