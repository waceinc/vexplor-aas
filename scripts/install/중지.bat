@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 중지합니다. 저장된 자료는 그대로 남습니다.
docker compose down
echo.
echo 중지했습니다. 다시 켜려면 실행.bat 를 누르십시오.
echo.
pause
