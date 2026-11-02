@echo off
set "PATH=C:\Program Files\nodejs;%PATH%"
echo Starting Public HTTPS Tunnel for Port 3000...
echo Share the generated https://... URL with target phones.
npx localtunnel --port 3000
pause

