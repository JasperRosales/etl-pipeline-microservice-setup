param(
    [string]$IssuesFile = ".\github-issues.md"
)

$ErrorActionPreference = "Stop"

# Run this script from inside the target GitHub repository.
if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    throw "GitHub CLI (gh) was not found. Install it from https://cli.github.com/ and reopen PowerShell."
}

if (-not (Test-Path $IssuesFile)) {
    throw "Cannot find '$IssuesFile'. Put github-issues.md in this folder or pass its path."
}

$repoRoot = (& git rev-parse --show-toplevel 2>$null)
if ($LASTEXITCODE -ne 0 -or -not $repoRoot) {
    throw "This folder is not inside a Git repository. Run this from the target repository folder."
}

& gh auth status
if ($LASTEXITCODE -ne 0) {
    throw "You are not authenticated. Run: gh auth login"
}

$content = Get-Content -Raw -Encoding UTF8 $IssuesFile
$pattern = '(?ms)^## Issue \d+ — (?<title>[^\r\n]+)\r?\n(?<body>.*?)(?=^## Issue \d+ — |\z)'
$matches = [regex]::Matches($content, $pattern)

if ($matches.Count -eq 0) {
    throw "No issue sections found. Expected headings like '## Issue 1 — Title'."
}

# Prevent accidental duplicates by checking all issue titles in this repository.
$existingJson = & gh issue list --state all --limit 500 --json title
if ($LASTEXITCODE -ne 0) {
    throw "Could not retrieve existing GitHub issues."
}
$existingTitles = @($existingJson | ConvertFrom-Json | ForEach-Object { $_.title })

$tempBody = Join-Path $env:TEMP "github-issue-body.md"
$created = 0
$skipped = 0

foreach ($match in $matches) {
    $title = $match.Groups["title"].Value.Trim()
    $body = $match.Groups["body"].Value.Trim()

    if ($existingTitles -contains $title) {
        Write-Host "SKIP (title already exists): $title" -ForegroundColor Yellow
        $skipped++
        continue
    }

    Set-Content -Path $tempBody -Value $body -Encoding UTF8
    Write-Host "Creating: $title" -ForegroundColor Cyan
    & gh issue create --title $title --body-file $tempBody
    if ($LASTEXITCODE -ne 0) {
        Remove-Item $tempBody -ErrorAction SilentlyContinue
        throw "Failed while creating issue '$title'. Fix the error and rerun; existing matching titles will be skipped."
    }

    $existingTitles += $title
    $created++
}

Remove-Item $tempBody -ErrorAction SilentlyContinue
Write-Host "`nFinished. Created: $created | Skipped existing titles: $skipped" -ForegroundColor Green
