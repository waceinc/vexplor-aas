@echo off
REM VEXPLOR AAS Studio install (Windows) — double-click this file.
REM Important: switch the code page to UTF-8 so Korean text is not garbled
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo.
echo ================================================
echo   VEXPLOR AAS Studio 설치
echo ================================================
echo.

REM ── (1) Check Docker ─────────────────────────────
where docker >nul 2>&1
if errorlevel 1 (
  echo [X] Docker Desktop이 설치돼 있지 않습니다.
  echo     https://www.docker.com/products/docker-desktop 에서 설치한 뒤 다시 실행하십시오.
  echo.
  pause
  exit /b 1
)

docker info >nul 2>&1
if errorlevel 1 (
  echo [X] Docker Desktop이 실행 중이 아닙니다.
  echo     시작 메뉴에서 Docker Desktop을 켜고, 고래 아이콘이 멈춘 뒤 다시 실행하십시오.
  echo.
  pause
  exit /b 1
)
echo [OK] Docker 확인

REM ── (2) Settings file ───────────────────────────────
if not exist ".env" (
  copy /y ".env.example" ".env" >nul
  echo.
  echo [!] 설정 파일 .env 를 만들었습니다.
  echo.
  echo     지금 메모장이 열립니다. 아래 한 줄만 채우고 저장한 뒤,
  echo     이 창을 닫고 설치.bat 를 다시 실행하십시오.
  echo.
  echo         POSTGRES_PASSWORD=   ^<- 데이터베이스 비밀번호 ^(아무 문자열^)
  echo.
  echo     ^(AAS_TOKEN 은 비워 두면 됩니다 - 사내 누구나 열고 고칠 수 있습니다.
  echo      특정 사람만 쓰게 하려면 그때 채우십시오.^)
  echo.
  notepad .env
  pause
  exit /b 0
)

REM Whether the password is empty — if empty, the database does not start
findstr /r "^POSTGRES_PASSWORD=..*" .env >nul
if errorlevel 1 (
  echo [X] .env 의 POSTGRES_PASSWORD 가 비어 있습니다. 채운 뒤 다시 실행하십시오.
  notepad .env
  pause
  exit /b 1
)

REM An access token is optional. The default use case is in-house, where anyone may open and edit.
REM But the program has a safeguard: "without a token, listen on this computer only",
REM so several people using it without a token need AAS_ALLOW_OPEN=1. Add it if missing.
findstr /r "^AAS_ALLOW_OPEN=" .env >nul
if errorlevel 1 (
  echo.>> .env
  echo # 토큰 없이 사내에서 함께 쓰기>> .env
  echo AAS_ALLOW_OPEN=1>> .env
)

findstr /r "^AAS_TOKEN=..*" .env >nul
if errorlevel 1 (
  echo [i] 접속 토큰 없이 설치합니다 - 사내 누구나 열고 고칠 수 있습니다.
  echo     나중에 잠그려면 .env 의 AAS_TOKEN= 에 값을 넣고 실행.bat 을 다시 누르십시오.
  echo.
) else (
  echo [i] 접속 토큰이 설정돼 있습니다 - 토큰을 가진 사람만 들어옵니다.
  echo.
)

REM ── (3) Load images ─────────────────────────
echo.
echo [..] 프로그램을 불러옵니다. 몇 분 걸립니다. 창을 닫지 마십시오.
docker load -i images.tar.gz
if errorlevel 1 (
  echo [X] 불러오기에 실패했습니다. images.tar.gz 파일이 온전한지 확인하십시오.
  pause
  exit /b 1
)

REM ── (4) Run ────────────────────────────────────
echo.
echo [..] 실행합니다.
docker compose up -d
if errorlevel 1 (
  echo [X] 실행에 실패했습니다. 아래 명령으로 원인을 확인하십시오:
  echo     docker compose logs app
  pause
  exit /b 1
)

REM Read the port (8080 if absent)
set PORT=8080
for /f "tokens=2 delims==" %%a in ('findstr /r "^APP_PORT=" .env') do set PORT=%%a

echo.
echo ================================================
echo   설치 완료
echo ================================================
echo.
echo   이 컴퓨터에서:   http://localhost:%PORT%
echo   다른 컴퓨터에서: http://^<이 컴퓨터의 IP^>:%PORT%
echo.
echo   IP 확인:  ipconfig  ^(IPv4 주소^)
echo.
echo   실행/중지는 실행.bat · 중지.bat 를 쓰십시오.
echo.
pause
