@echo off
chcp 65001 >nul
title Cai dat may chu quan
rem Bam chuot phai -> "Run as administrator"
net session >nul 2>&1
if errorlevel 1 (
  echo Can chay voi quyen quan tri: bam chuot PHAI vao file nay -^> Run as administrator
  pause & exit /b
)
where node >nul 2>nul
if errorlevel 1 (
  echo Chua cai Node.js. Mo trang nodejs.org, tai ban LTS, cai xong bam lai file nay.
  start "" https://nodejs.org
  pause & exit /b
)
mkdir C:\QuanLyQuan\du-lieu 2>nul
mkdir C:\QuanLyQuan\sao-luu-ngoai 2>nul
echo [1/4] Tu chay app khi bat may (ke ca chua dang nhap Windows)...
schtasks /create /tn "QuanLyQuan" /tr "\"%~dp0chay-may-chu.bat\"" /sc onstart /ru SYSTEM /rl highest /f >nul
echo [2/4] Tat che do ngu / tat man hinh khong anh huong...
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /hibernate off
echo [3/4] Mo cong 3000 cho dien thoai / may tinh khac trong quan...
netsh advfirewall firewall delete rule name="QuanLyQuan" >nul 2>&1
netsh advfirewall firewall add rule name="QuanLyQuan" dir=in action=allow protocol=TCP localport=3000 profile=any >nul
echo [4/4] Chay app ngay...
schtasks /run /tn "QuanLyQuan" >nul
timeout /t 5 /nobreak >nul
echo.
echo  XONG. App chay ngam, tu bat lai khi mo may / mat dien co dien lai.
echo  Tren may nay mo: http://localhost:3000
echo  Dien thoai / may tinh khac trong quan mo 1 dia chi duoi day:
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4"') do for /f "tokens=*" %%b in ("%%a") do echo     http://%%b:3000
echo.
echo  Du lieu: C:\QuanLyQuan\du-lieu    Ban sao luu ngoai: C:\QuanLyQuan\sao-luu-ngoai
echo  (Trong Google Drive tren may: Cai dat -^> Thu muc tren may tinh -^> them thu muc sao-luu-ngoai)
start "" http://localhost:3000
pause
