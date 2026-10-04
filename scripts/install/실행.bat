@echo off
chcp 65001 >nul
cd /d "%~dp0"
docker info >nul 2>&1 || (echo [X] Docker Desktop을 먼저 켜십시오. & pause & exit /b 1)
docker compose up -d
set PORT=8080
for /f "tokens=2 delims==" %%a in ('findstr /r "^APP_PORT=" .env') do set PORT=%%a
echo.
echo 실행했습니다 - http://localhost:%PORT%
echo 상태 보기: docker compose logs -f app
echo.
pause
