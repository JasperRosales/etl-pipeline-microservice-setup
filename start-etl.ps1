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
