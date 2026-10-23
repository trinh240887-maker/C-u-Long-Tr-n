@echo off
rem Ngung tu chay app (du lieu van giu trong C:\QuanLyQuan)
schtasks /end /tn "QuanLyQuan" >nul 2>&1
schtasks /delete /tn "QuanLyQuan" /f
taskkill /f /im node.exe >nul 2>&1
netsh advfirewall firewall delete rule name="QuanLyQuan" >nul 2>&1
echo Da ngung. Du lieu van con o C:\QuanLyQuan\du-lieu
pause
