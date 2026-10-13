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
