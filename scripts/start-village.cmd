@echo off
rem Virelune Agent Village - double-click to start, then open http://127.0.0.1:4317
cd /d "%~dp0.."
where node >nul 2>nul || (echo Node.js is not installed. Run scripts\setup.ps1 first. & pause & exit /b 1)
start "" "http://127.0.0.1:4317"
npm start
pause
