@echo off
chcp 65001 >nul
title Khoi phuc du lieu
rem Dat file .db (tai tu Railway: Cai dat -> Sao luu -> Tai toan bo du lieu, hoac file trong sao-luu-ngoai) vao CUNG thu muc nay roi bam dup.
net session >nul 2>&1
if errorlevel 1 (
  echo Can chay voi quyen quan tri: bam chuot PHAI vao file nay -^> Run as administrator
  pause & exit /b
)
cd /d "%~dp0"
set FILE=
for /f "delims=" %%f in ('dir /b /o-d *.db 2^>nul') do if not defined FILE set FILE=%%f
if not defined FILE (
  echo Khong thay file .db trong thu muc may-chu-quan. Chep file du lieu vao day roi chay lai.
  pause & exit /b
)
echo Se thay du lieu hien tai bang file: %FILE%
echo Du lieu cu duoc giu lai trong C:\QuanLyQuan\du-lieu\truoc-khoi-phuc-*.db
choice /m "Tiep tuc"
if errorlevel 2 exit /b
schtasks /end /tn "QuanLyQuan" >nul 2>&1
taskkill /f /im node.exe >nul 2>&1
timeout /t 3 /nobreak >nul
mkdir C:\QuanLyQuan\du-lieu 2>nul
set STAMP=%date:~-4%%date:~3,2%%date:~0,2%-%time:~0,2%%time:~3,2%
set STAMP=%STAMP: =0%
if exist C:\QuanLyQuan\du-lieu\quanly.db move /y C:\QuanLyQuan\du-lieu\quanly.db "C:\QuanLyQuan\du-lieu\truoc-khoi-phuc-%STAMP%.db" >nul
del /q C:\QuanLyQuan\du-lieu\quanly.db-wal C:\QuanLyQuan\du-lieu\quanly.db-shm 2>nul
copy /y "%FILE%" C:\QuanLyQuan\du-lieu\quanly.db >nul
move /y "%FILE%" "%FILE%.da-dung" >nul
schtasks /run /tn "QuanLyQuan" >nul
echo XONG. Doi 10 giay roi mo http://localhost:3000 dang nhap bang PIN cu.
pause
