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

# Resolve a service's port the same way services/shared/config.js does:
# the .env value when present, otherwise the default. Keeps every console
# line truthful even when ports are overridden.
function Get-ServicePort([string]$Name) {
    $Defaults = @{ extractor = 3001; transformer = 3002; loader = 3003; reporter = 3004; notifier = 3005; scheduler = 3006 }
    $EnvName = if ($Name -eq "scheduler") { "SCHEDULER_PORT" } else { "PORT_" + $Name.ToUpper() }
    $EnvFile = Join-Path $ProjectRoot ".env"
    if (Test-Path $EnvFile) {
        foreach ($Line in Get-Content $EnvFile) {
            if ($Line -match "^\s*$EnvName\s*=\s*[""']?(\d+)") { return [int]$Matches[1] }
        }
    }
    return [int]$Defaults[$Name]
}

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
    # Unwrap manually: PS 5.1 ConvertFrom-Json emits a top-level array as one object.
    $Existing = Get-Content $PidFile -Raw | ConvertFrom-Json
    if ($Existing -isnot [array]) { $Existing = @($Existing) }
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

    # Clear a stale stop marker left behind by a previous hard kill (Issue 6)
    Remove-Item (Join-Path $LogDir "$Service.stop") -Force -ErrorAction SilentlyContinue

    $Port = Get-ServicePort $Service
    Write-Host "Starting $Service on 127.0.0.1:$Port..." -ForegroundColor Green

    # -WindowStyle Hidden: each service still gets its own console (so it
    # outlives the terminal that started it), but the window is never shown.
    # Without it, six blank console windows pop up on start - the service
    # output already goes to the log files above.
    $Process = Start-Process `
        -FilePath (Get-Command node).Source `
        -ArgumentList "index.js" `
        -WorkingDirectory $ServiceDir `
        -WindowStyle Hidden `
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

# Wait until every started service answers /health before declaring success (Issue 6)
if ($Started.Count -gt 0) {
    Write-Host "Waiting for services to become healthy..." -ForegroundColor Yellow
    node .\scripts\health-check.js --wait 15
    if ($LASTEXITCODE -ne 0) {
        Write-Warning "Some services are not healthy yet. Check the logs in $LogDir."
    }
}

# Service board: endpoint, status, PID, log file and last event, so the whole
# stack is visible at a glance and shows activity as services are called.
if ($Started.Count -gt 0) {
    Write-Host "`nServices" -ForegroundColor Cyan
    Write-Host ("{0,-11} {1,-15} {2,-9} {3,-7} {4,-24} {5}" -f `
        "Service", "Endpoint", "Status", "PID", "Log", "Last event") -ForegroundColor DarkGray

    foreach ($Entry in $Started) {
        $Port = Get-ServicePort $Entry.Service

        $Status = "down"
        try {
            $Health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 3
            if ($Health.service -eq $Entry.Service) { $Status = "healthy" } else { $Status = "unexpected" }
        }
        catch { }

        $Jsonl = Join-Path $LogDir "$($Entry.Service).jsonl"
        $LastEvent = "-"
        if (Test-Path $Jsonl) {
            $Line = Get-Content $Jsonl -Tail 1 -ErrorAction SilentlyContinue
            if ($Line) {
                try {
                    $Event = $Line | ConvertFrom-Json
                    $LastEvent = "$($Event.event)  $((Get-Date $Event.ts).ToString('HH:mm:ss'))"
                }
                catch { $LastEvent = "(unparsed line)" }
            }
        }

        $Cells = @($Entry.Service, "127.0.0.1:$Port", $Status, $Entry.ProcessId, "logs\$($Entry.Service).jsonl", $LastEvent)
        $Row = "{0,-11} {1,-15} {2,-9} {3,-7} {4,-24} {5}" -f $Cells
        if ($Status -eq "healthy") { Write-Host $Row -ForegroundColor Green }
        else { Write-Host $Row -ForegroundColor Red }
    }
}

Write-Host "`nStartup commands completed." -ForegroundColor Cyan
Write-Host "Started processes: $($Started.Count)"
Write-Host "Logs: $LogDir"
Write-Host "Stop with: .\stop-etl.ps1"
Write-Host "Watch:     Get-Content .\logs\*.jsonl -Wait -Tail 5"
