@echo off
chcp 65001 >nul
rem 종료 로직은 manage.ps1 한 곳에만 둔다 — 여기 복제하면 PID 검증 같은 안전장치가 빠진 채 남는다
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0manage.ps1" -Op stop
pause
