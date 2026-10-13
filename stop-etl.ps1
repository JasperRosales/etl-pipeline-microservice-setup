$ProjectRoot = $PSScriptRoot
$LogDir = Join-Path $ProjectRoot "logs"
$PidFile = Join-Path $LogDir "service-pids.json"
$GraceSeconds = 5

if (-not (Test-Path $PidFile)) {
    Write-Host "No service PID file found."
    exit 0
}

# NOTE: Windows PowerShell 5.1's ConvertFrom-Json emits a top-level JSON array
# as a single non-enumerated object, so @(...) would nest it. Unwrap manually.
$Services = Get-Content $PidFile -Raw | ConvertFrom-Json
if ($Services -isnot [array]) { $Services = @($Services) }

foreach ($Service in $Services) {
    $Process = Get-Process -Id $Service.ProcessId -ErrorAction SilentlyContinue

    if (-not $Process) {
        Write-Host "$($Service.Service) is not running."
        continue
    }

    # Never kill a PID that is no longer one of our node services (Issue 6).
    if ($Process.ProcessName -ne "node") {
        Write-Warning "PID $($Service.ProcessId) is '$($Process.ProcessName)', not node - refusing to stop it (PID reused?)."
        continue
    }

    Write-Host "Stopping $($Service.Service) gracefully..."

    # Windows cannot deliver SIGTERM to a console process, so ask the service
    # to shut down through its stop marker instead; the service stops
    # accepting connections, drains in-flight requests, and exits 0.
    $StopFile = Join-Path $LogDir "$($Service.Service).stop"
    Set-Content -Path $StopFile -Value "stop requested $(Get-Date -Format o)" -Encoding utf8

    $Deadline = (Get-Date).AddSeconds($GraceSeconds)
    while ((Get-Date) -lt $Deadline) {
        Start-Sleep -Milliseconds 250
        $Process.Refresh()
        if ($Process.HasExited) { break }
    }

    if ($Process.HasExited) {
        Write-Host "$($Service.Service) stopped gracefully."
    }
    else {
        Write-Warning "$($Service.Service) did not stop within ${GraceSeconds}s - force killing."
        Stop-Process -Id $Service.ProcessId -Force
    }

    Remove-Item $StopFile -Force -ErrorAction SilentlyContinue
}

Remove-Item $PidFile -Force -ErrorAction SilentlyContinue
Write-Host "Stop commands completed."
