@echo off
chcp 65001 >nul
title MAY CHU QUAN - dung tat
rem Chay app lien tuc: app loi/tat thi 5 giay sau tu chay lai. Nhat ky: C:\QuanLyQuan\nhat-ky.txt
cd /d "%~dp0.."
set PORT=3000
set DATA_DIR=C:\QuanLyQuan\du-lieu
set BACKUP_COPY_DIR=C:\QuanLyQuan\sao-luu-ngoai
set PRINT_LOCAL=1
if not exist C:\QuanLyQuan mkdir C:\QuanLyQuan
:lap
echo [%date% %time%] Bat dau chay app >> C:\QuanLyQuan\nhat-ky.txt
node --disable-warning=ExperimentalWarning server.js >> C:\QuanLyQuan\nhat-ky.txt 2>&1
echo [%date% %time%] App dung, chay lai sau 5 giay >> C:\QuanLyQuan\nhat-ky.txt
timeout /t 5 /nobreak >nul
goto lap
