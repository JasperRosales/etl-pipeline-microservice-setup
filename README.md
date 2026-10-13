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
| Extractor | 3001 | Retrieves transaction data from Google Sheets or an Apps Script endpoint |
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

This basic stop script stops the recorded Node.js processes. For a more robust implementation, services should handle graceful shutdown, and the stop script should verify process identity before terminating a process.

## 6. Running the system

Open PowerShell in the project directory.

### Start all services

```powershell
.\start-etl.ps1
```

### Stop all recorded services

```powershell
.\stop-etl.ps1
```

### View recent extractor errors

```powershell
Get-Content .\logs\extractor.err.log -Tail 50
```

The first run requires the database initialization script and service entry points to exist. The startup script skips any service whose `index.js` file is missing.

## 7. Database choice

SQLite is recommended for the local prototype because it does not require a separate database server process. If the project later moves to PostgreSQL or MySQL, the startup script will also need to start or verify the database server.

## 8. Google Sheets connectivity

The microservices can run locally, but the extractor needs internet access to retrieve Google Sheets data through a Google Apps Script Web App or another configured Sheets API integration.

The extractor should keep credentials and endpoint configuration in `.env` or another appropriate configuration mechanism. Do not commit secrets to the repository.

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
