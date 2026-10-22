@echo off
chcp 65001 >nul
title App quan - chay tai quan
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Chua cai Node.js. Mo trang nodejs.org, tai ban LTS, bam Next den het, roi bam dup file nay lai.
  start "" https://nodejs.org
  pause
  exit /b
)
echo.
echo  App dang chay tren may nay: http://localhost:3000
echo  Dien thoai cung wifi mo 1 trong cac dia chi:
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do for /f "tokens=*" %%b in ("%%a") do echo     http://%%b:3000
echo.
echo  Windows hoi "Allow access" thi bam Allow. DUNG TAT cua so nay khi dang ban.
echo.
start "" http://localhost:3000
set PORT=3000
node --disable-warning=ExperimentalWarning server.js
pause
