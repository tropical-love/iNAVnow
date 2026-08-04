@echo off
chcp 65001 >nul
rem 시작 로직도 manage.ps1 한 곳에만 둔다 (stop.bat과 동일한 이유). 브라우저도 거기서 연다.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0manage.ps1" -Op start
