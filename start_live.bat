@echo off
set "PATH=C:\Program Files\nodejs;%PATH%"
start "Node Server" cmd /c "node server.js"
timeout /t 2 /nobreak >nul
echo ====================================================
echo Starting Cloudflare Public HTTPS Tunnel...
echo Copy the generated https://*.trycloudflare.com URL!
echo ====================================================
cloudflared.exe tunnel --url http://localhost:3000
pause

