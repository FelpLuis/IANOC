@echo off
echo ========================================
echo   IA NOC Agent - Development Startup
echo ========================================
echo.

echo [1/4] Installing backend dependencies...
cd backend
if not exist node_modules (
    npm install
)
cd ..

echo.
echo [2/4] Installing frontend dependencies...
cd frontend
if not exist node_modules (
    npm install
)
cd ..

echo.
echo [3/4] Building shared types...
echo Shared types are in TypeScript, no build needed.

echo.
echo [4/4] Starting development servers...
echo.
echo Backend will run on http://localhost:3001
echo Frontend will run on http://localhost:5173
echo.
echo Press Ctrl+C to stop both servers.
echo.

start "IA NOC Backend" cmd /k "cd backend && npm run dev"
timeout /t 3 /nobreak >nul
start "IA NOC Frontend" cmd /k "cd frontend && npm run dev"

echo.
echo Both servers started in separate windows.
echo Check the windows for logs.