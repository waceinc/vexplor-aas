#!/usr/bin/env bash
# VEXPLOR AAS Studio 설치 (맥) — 이 파일을 두 번 클릭하십시오.
# 🔴 .command 확장자라 파인더에서 두 번 클릭하면 터미널이 열린다.
#    (처음에는 "확인되지 않은 개발자" 경고가 날 수 있다 — 우클릭 → 열기)
set -uo pipefail
cd "$(dirname "$0")"

echo
echo "================================================"
echo "  VEXPLOR AAS Studio 설치"
echo "================================================"
echo

# 🔴 파인더에서 두 번 클릭하면 PATH가 /usr/bin:/bin:/usr/sbin:/sbin 뿐이다.
#    Docker CLI는 /usr/local/bin 등에 있어서 "설치돼 있지 않습니다"로 잘못 멈춘다(실측).
#    터미널에서는 잘 되는데 두 번 클릭만 안 되는 원인이 이것이다.
for _dir in /usr/local/bin /opt/homebrew/bin "$HOME/.docker/bin" \
            /Applications/Docker.app/Contents/Resources/bin; do
  [ -d "$_dir" ] && case ":$PATH:" in *":$_dir:"*) ;; *) PATH="$PATH:$_dir" ;; esac
done
export PATH

if ! command -v docker >/dev/null 2>&1; then
  echo "[X] Docker Desktop이 설치돼 있지 않습니다."
  echo "    https://www.docker.com/products/docker-desktop 에서 설치한 뒤 다시 실행하십시오."
  echo; read -r -p "엔터를 누르면 닫힙니다."; exit 1
fi

# 🔴 Docker를 DMG 창에서 바로 실행하면 CLI가 /Volumes/... 를 가리킨다.
#    지금은 돌지만 DMG를 빼거나 재부팅하면 통째로 사라진다 — 미리 잡아 준다.
if readlink "$(command -v docker)" 2>/dev/null | grep -q '^/Volumes/'; then
  echo "[X] Docker가 아직 「응용 프로그램」 폴더에 설치되지 않았습니다."
  echo "    지금은 DMG(디스크 이미지) 창에서 돌고 있어서, 재부팅하면 사라집니다."
  echo
  echo "    1) Docker Desktop을 끕니다"
  echo "    2) DMG 창을 열어 Docker 아이콘을 「응용 프로그램」 폴더로 끌어다 놓습니다"
  echo "    3) 응용 프로그램에서 Docker를 켜고, 이 파일을 다시 두 번 클릭합니다"
  echo; read -r -p "엔터를 누르면 닫힙니다."; exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "[X] Docker Desktop이 실행 중이 아닙니다."
  echo "    Docker Desktop을 켜고 고래 아이콘이 멈춘 뒤 다시 실행하십시오."
  echo; read -r -p "엔터를 누르면 닫힙니다."; exit 1
fi
echo "[OK] Docker 확인"

if [ ! -f .env ]; then
  cp .env.example .env
  echo
  echo "[!] 설정 파일 .env 를 만들었습니다."
  echo
  echo "    지금 편집기가 열립니다. 아래 한 줄만 채우고 저장한 뒤,"
  echo "    설치.command 를 다시 실행하십시오."
  echo
  echo "        POSTGRES_PASSWORD=   <- 데이터베이스 비밀번호 (아무 문자열)"
  echo
  echo "    (AAS_TOKEN 은 비워 두면 됩니다 — 사내 누구나 열고 고칠 수 있습니다."
  echo "     특정 사람만 쓰게 하려면 그때 채우십시오.)"
  echo
  open -e .env 2>/dev/null || true
  read -r -p "엔터를 누르면 닫힙니다."; exit 0
fi

grep -Eq '^POSTGRES_PASSWORD=.+' .env || {
  echo "[X] .env 의 POSTGRES_PASSWORD 가 비어 있습니다. 채운 뒤 다시 실행하십시오."
  open -e .env 2>/dev/null || true
  read -r -p "엔터를 누르면 닫힙니다."; exit 1
}
# 접속 토큰은 **없어도 된다**. 사내에서 누구나 열고 고쳐도 되는 것이 기본 쓰임새다.
# 다만 프로그램에는 "토큰이 없으면 이 컴퓨터에서만 연다"는 안전장치가 있어서,
# 토큰 없이 여러 사람이 쓰려면 AAS_ALLOW_OPEN=1이 있어야 한다. 없으면 넣어 준다.
grep -Eq '^AAS_ALLOW_OPEN=' .env || printf '\n# 토큰 없이 사내에서 함께 쓰기\nAAS_ALLOW_OPEN=1\n' >> .env

if grep -Eq '^AAS_TOKEN=.+' .env; then
  echo "[i] 접속 토큰이 설정돼 있습니다 — 토큰을 가진 사람만 들어옵니다."
else
  echo "[i] 접속 토큰 없이 설치합니다 — 사내 누구나 열고 고칠 수 있습니다."
  echo "    나중에 잠그려면 .env 의 AAS_TOKEN= 에 값을 넣고 실행.command 를 다시 누르십시오."
fi

echo
echo "[..] 프로그램을 불러옵니다. 몇 분 걸립니다. 창을 닫지 마십시오."
gunzip -c images.tar.gz | docker load || {
  echo "[X] 불러오기 실패 — images.tar.gz 가 온전한지 확인하십시오."
  read -r -p "엔터를 누르면 닫힙니다."; exit 1
}

echo
echo "[..] 실행합니다."
docker compose up -d || {
  echo "[X] 실행 실패 — 원인 보기:  docker compose logs app"
  read -r -p "엔터를 누르면 닫힙니다."; exit 1
}

PORT="$(grep -E '^APP_PORT=' .env | cut -d= -f2)"; PORT="${PORT:-8080}"
IP="$(ipconfig getifaddr en0 2>/dev/null || echo '이 맥의 IP')"

echo
echo "================================================"
echo "  설치 완료"
echo "================================================"
echo
echo "  이 맥에서:       http://localhost:${PORT}"
echo "  다른 컴퓨터에서: http://${IP}:${PORT}"
echo
echo "  중지:  docker compose down      (자료는 남습니다)"
echo "  실행:  docker compose up -d"
echo "  상태:  docker compose logs -f app"
echo
read -r -p "엔터를 누르면 닫힙니다."
