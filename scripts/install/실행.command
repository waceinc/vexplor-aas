#!/usr/bin/env bash
# 컴퓨터를 껐다 켠 뒤 다시 시작할 때 — 두 번 클릭하십시오.
set -uo pipefail
cd "$(dirname "$0")"

# 🔴 두 번 클릭하면 PATH가 최소한만 온다 — 설치.command와 같은 이유다
for _dir in /usr/local/bin /opt/homebrew/bin "$HOME/.docker/bin" \
            /Applications/Docker.app/Contents/Resources/bin; do
  [ -d "$_dir" ] && case ":$PATH:" in *":$_dir:"*) ;; *) PATH="$PATH:$_dir" ;; esac
done
export PATH

docker info >/dev/null 2>&1 || {
  echo "[X] Docker Desktop을 먼저 켜십시오."
  read -r -p "엔터를 누르면 닫힙니다."; exit 1
}

docker compose up -d || {
  echo "[X] 실행 실패 — 원인 보기:  docker compose logs app"
  read -r -p "엔터를 누르면 닫힙니다."; exit 1
}

PORT="$(grep -E '^APP_PORT=' .env 2>/dev/null | cut -d= -f2)"; PORT="${PORT:-8080}"
echo
echo "실행했습니다 — http://localhost:${PORT}"
echo "상태 보기:  docker compose logs -f app"
echo
read -r -p "엔터를 누르면 닫힙니다."
