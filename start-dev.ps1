#!/usr/bin/env pwsh

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "   IA NOC Agent - Development Startup" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

Write-Host "[1/4] Installing backend dependencies..." -ForegroundColor Yellow
Set-Location backend
if (-not (Test-Path node_modules)) {
    npm install
}
Set-Location ..

Write-Host ""
Write-Host "[2/4] Installing frontend dependencies..." -ForegroundColor Yellow
Set-Location frontend
if (-not (Test-Path node_modules)) {
    npm install
}
Set-Location ..

Write-Host ""
Write-Host "[3/4] Building shared types..." -ForegroundColor Yellow
Write-Host "Shared types are in TypeScript, no build needed." -ForegroundColor Gray

Write-Host ""
Write-Host "[4/4] Starting development servers..." -ForegroundColor Yellow
Write-Host ""
Write-Host "Backend will run on http://localhost:3001" -ForegroundColor Green
Write-Host "Frontend will run on http://localhost:5173" -ForegroundColor Green
Write-Host ""
Write-Host "Press Ctrl+C to stop both servers." -ForegroundColor Gray
Write-Host ""

# Start backend in background job
$backendJob = Start-Job -ScriptBlock {
    Set-Location "$PSScriptRoot\backend"
    npm run dev
}

# Wait a bit for backend to start
Start-Sleep -Seconds 3

# Start frontend in background job
$frontendJob = Start-Job -ScriptBlock {
    Set-Location "$PSScriptRoot\frontend"
    npm run dev
}

Write-Host "Both servers started." -ForegroundColor Green
Write-Host "Backend Job ID: $($backendJob.Id)" -ForegroundColor Gray
Write-Host "Frontend Job ID: $($frontendJob.Id)" -ForegroundColor Gray
Write-Host ""
Write-Host "Use 'Receive-Job -Id <id>' to see output" -ForegroundColor Gray
Write-Host "Use 'Stop-Job -Id <id>' to stop a server" -ForegroundColor Gray
Write-Host ""

# Keep script running
try {
    while ($true) {
        Start-Sleep -Seconds 10
    }
}
finally {
    Write-Host "Stopping servers..." -ForegroundColor Yellow
    Stop-Job $backendJob
    Stop-Job $frontendJob
    Write-Host "Servers stopped." -ForegroundColor Green
}