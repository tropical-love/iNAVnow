@echo off
chcp 65001 >nul
title iNAVnow Local Server
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0manage.ps1"
