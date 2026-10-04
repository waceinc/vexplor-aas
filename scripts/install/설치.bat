@echo off
REM VEXPLOR AAS Studio 설치 (윈도우) — 이 파일을 두 번 클릭하십시오.
REM 🔴 한글이 깨지지 않게 코드페이지를 UTF-8로 바꾼다
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo.
echo ================================================
echo   VEXPLOR AAS Studio 설치
echo ================================================
echo.

REM ── ① Docker 확인 ─────────────────────────────
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

REM ── ② 설정 파일 ───────────────────────────────
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

REM 비밀번호가 비었는지 — 비면 데이터베이스가 뜨지 않는다
findstr /r "^POSTGRES_PASSWORD=..*" .env >nul
if errorlevel 1 (
  echo [X] .env 의 POSTGRES_PASSWORD 가 비어 있습니다. 채운 뒤 다시 실행하십시오.
  notepad .env
  pause
  exit /b 1
)

REM 접속 토큰은 없어도 된다. 사내에서 누구나 열고 고쳐도 되는 것이 기본 쓰임새다.
REM 다만 프로그램에는 "토큰이 없으면 이 컴퓨터에서만 연다"는 안전장치가 있어서,
REM 토큰 없이 여러 사람이 쓰려면 AAS_ALLOW_OPEN=1이 있어야 한다. 없으면 넣어 준다.
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

REM ── ③ 이미지 불러오기 ─────────────────────────
echo.
echo [..] 프로그램을 불러옵니다. 몇 분 걸립니다. 창을 닫지 마십시오.
docker load -i images.tar.gz
if errorlevel 1 (
  echo [X] 불러오기에 실패했습니다. images.tar.gz 파일이 온전한지 확인하십시오.
  pause
  exit /b 1
)

REM ── ④ 실행 ────────────────────────────────────
echo.
echo [..] 실행합니다.
docker compose up -d
if errorlevel 1 (
  echo [X] 실행에 실패했습니다. 아래 명령으로 원인을 확인하십시오:
  echo     docker compose logs app
  pause
  exit /b 1
)

REM 포트 읽기 (없으면 8080)
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
