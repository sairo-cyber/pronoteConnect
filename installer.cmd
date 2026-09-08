@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1" %*
if errorlevel 1 (
  echo.
  echo PronoteConnect n'a pas pu terminer l'installation.
  if exist "%~dp0.data\logs\last-install-error.txt" type "%~dp0.data\logs\last-install-error.txt"
  echo.
  pause
)
