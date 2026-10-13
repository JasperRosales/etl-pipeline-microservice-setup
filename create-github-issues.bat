@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0create-github-issues.ps1" -IssuesFile "%~dp0github-issues.md"
echo.
pause
