@echo off
rem ==========================================================================
rem  Verwaltung maCura Mobil - Start per Doppelklick
rem
rem  1. prueft, ob Node.js ab Version 22.5 installiert ist
rem  2. installiert beim ersten Mal die benoetigten Pakete
rem  3. startet den Server und oeffnet den Browser, sobald er antwortet
rem
rem  Der Browser wird mit 127.0.0.1 statt "localhost" geoeffnet. Windows loest
rem  "localhost" teils ueber IPv6 auf; mit der festen Adresse funktioniert es
rem  in Firefox, Chrome und Edge gleichermassen.
rem
rem  Dieses Fenster offen lassen, solange mit der Verwaltung gearbeitet wird.
rem  Schliessen beendet die Verwaltung.
rem ==========================================================================
setlocal
title Verwaltung maCura Mobil
set "ADRESSE=http://127.0.0.1:8082/"
cd /d "%~dp0server"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js ist nicht installiert.
  echo Bitte installieren: https://nodejs.org  ^(Version "LTS"^)
  echo oder in der Eingabeaufforderung: winget install OpenJS.NodeJS.LTS
  echo Danach diese Datei erneut starten.
  goto :ende
)

node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=5)?0:1)"
if errorlevel 1 (
  echo.
  for /f "delims=" %%v in ('node --version') do echo Installiert ist Node.js %%v - benoetigt wird mindestens 22.5.
  echo Bitte aktualisieren: winget upgrade OpenJS.NodeJS.LTS
  goto :ende
)

rem Laeuft die Verwaltung schon (z. B. in einem anderen Fenster)? Dann nur den
rem Browser oeffnen, statt einen zweiten Server zu starten.
powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing '%ADRESSE%' -TimeoutSec 2 | Out-Null; exit 0 } catch { exit 1 }"
if not errorlevel 1 (
  echo Die Verwaltung laeuft bereits. Browser wird geoeffnet.
  start "" "%ADRESSE%"
  goto :eof
)

if not exist node_modules (
  echo Erster Start: benoetigte Pakete werden installiert ...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo.
    echo Die Installation ist fehlgeschlagen. Bitte die Meldungen oben pruefen.
    goto :ende
  )
)

rem Browser im Hintergrund oeffnen, sobald der Server antwortet (max. 30 s).
start "" /b powershell -NoProfile -Command "for ($i = 0; $i -lt 60; $i++) { try { Invoke-WebRequest -UseBasicParsing '%ADRESSE%' -TimeoutSec 1 | Out-Null; Start-Process '%ADRESSE%'; break } catch { Start-Sleep -Milliseconds 500 } }"

echo.
echo Verwaltung wird gestartet: %ADRESSE%
echo Zum Beenden dieses Fenster schliessen oder Strg+C druecken.
echo.
node server.js

echo.
echo Die Verwaltung wurde beendet.

:ende
echo.
pause
