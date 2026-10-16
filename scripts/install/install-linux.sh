#!/usr/bin/env bash
# VEXPLOR AAS Studio — site server install on Linux with one command (docs/site-install.md, lead request §6 H1).
#
#   sudo ./install.sh [--dir /opt/vexplor-aas] [--port 8080] [--with-edge] [--edge-name "Line 1"]
#                     [--edge-credentials credentials.json]
#
# Loads the bundled images (AAS Studio + TimescaleDB), writes .env with generated secrets, starts both with Docker
# Compose and waits until the server answers. With --with-edge it also installs the remote collector from the bundle on
# the same server, registered to this AAS Studio (EDGE=on); it reads nothing until a person approves its read list.
# After a reboot everything comes back by itself: Docker is enabled, the containers restart unless stopped, and the
# collector is a systemd service.
#
# Important: the file is called install.sh, not 설치.sh — on a server it is typed over SSH, where a Korean name is a
#    keyboard problem. Its messages stay Korean, like the other installers.
# Important: Docker Engine and its Compose plugin must already be there. A factory server is often offline, so this
#    script installs no packages; it says which ones to install.
# Important: a second run keeps .env (and so the database password) — it only loads images and starts again, which is
#    how an upgrade is installed.
set -euo pipefail

DIR=/opt/vexplor-aas; PORT=""; EDGE=0; EDGE_NAME="VEXPLOR Edge"; EDGE_CREDENTIALS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) DIR="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --with-edge) EDGE=1; shift ;;
    --edge-name) EDGE_NAME="$2"; shift 2 ;;
    --edge-credentials) EDGE_CREDENTIALS="$2"; shift 2 ;;
    *) echo "[X] 모르는 옵션: $1" >&2; exit 2 ;;
  esac
done
[ "$(id -u)" -eq 0 ] || { echo "[X] 관리자 권한으로 실행하십시오:  sudo $0" >&2; exit 1; }
HERE=$(cd "$(dirname "$0")" && pwd)

echo
echo "================================================"
echo "  VEXPLOR AAS Studio 현장 서버 설치 (Linux)"
echo "================================================"

if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
  echo "[X] Docker Engine 과 Compose 플러그인이 필요합니다."
  echo "    Ubuntu:  sudo apt install docker.io docker-compose-v2"
  echo "    그 밖:   https://docs.docker.com/engine/install/  (인터넷이 없는 서버는 패키지를 미리 받아 설치)"
  exit 1
fi
if command -v systemctl >/dev/null 2>&1; then systemctl enable --now docker >/dev/null 2>&1 || true; fi
docker info >/dev/null 2>&1 || { echo "[X] Docker 가 돌고 있지 않습니다:  systemctl status docker" >&2; exit 1; }
echo "[OK] Docker $(docker version --format '{{.Server.Version}}') · $(docker compose version --short)"

# The program files go to DIR; the images are loaded straight from the bundle and not copied
install -d -m 0755 "$DIR"
if [ "$HERE" != "$DIR" ]; then
  shopt -s dotglob # .env.example is one of them
  for file in "$HERE"/*; do
    case "$(basename "$file")" in images.tar.gz | vexplor-edge-*.tar.gz) ;; *) cp -R "$file" "$DIR/" ;; esac
  done
fi
install -d -m 0755 "$DIR/templates"

secret() { head -c 32 /dev/urandom | base64 | tr -d '\n/+=' | cut -c1-"$1"; }
setting() { # setting KEY VALUE — set or add one line of .env
  if grep -Eq "^$1=" "$DIR/.env"; then sed -i "s|^$1=.*|$1=$2|" "$DIR/.env"; else printf '%s=%s\n' "$1" "$2" >> "$DIR/.env"; fi
}
if [ ! -f "$DIR/.env" ]; then
  cp "$DIR/.env.example" "$DIR/.env"
  # The superuser is only for the database itself; the app gets its own account, owner of its tables (T3)
  setting POSTGRES_USER postgres
  setting POSTGRES_PASSWORD "$(secret 32)"
  setting AAS_DB_USER aas_app
  setting AAS_DB_PASSWORD "$(secret 32)"
  setting AAS_SECRET_KEY "$(head -c 32 /dev/urandom | base64 | tr -d '\n')"
  setting AAS_SETUP_CODE "$(secret 12)"
  echo "[OK] 설정 파일을 만들었습니다: $DIR/.env (데이터베이스 계정 · 비밀 키 · 첫 관리자 코드 생성)"
else
  echo "[i] 기존 설정 파일을 그대로 씁니다: $DIR/.env"
fi
[ -n "$PORT" ] && setting APP_PORT "$PORT"
[ "$EDGE" -eq 1 ] && setting EDGE on
chmod 600 "$DIR/.env"
PORT="$(grep -E '^APP_PORT=' "$DIR/.env" | cut -d= -f2)"; PORT="${PORT:-8080}"

echo "[..] 프로그램을 불러옵니다(몇 분 걸립니다)."
gunzip -c "$HERE/images.tar.gz" | docker load >/dev/null
echo "[..] 실행합니다."
(cd "$DIR" && docker compose up -d >/dev/null)

printf '[..] 서버가 답하기를 기다립니다'
for _ in $(seq 1 90); do
  if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then break; fi
  printf '.'; sleep 2
done
echo
curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 || { echo "[X] 서버가 답하지 않습니다. 원인 보기:  cd $DIR && docker compose logs app" >&2; exit 1; }
echo "[OK] $(cd "$DIR" && docker compose logs app 2>/dev/null | grep -m1 -E '저장소|store' | sed 's/^[^|]*| *//')"

if [ "$EDGE" -eq 1 ]; then
  EDGE_PACKAGE=$(ls "$HERE"/vexplor-edge-*-linux-*.tar.gz 2>/dev/null | head -1)
  [ -n "$EDGE_PACKAGE" ] || { echo "[X] 꾸러미에 원격 수집기(vexplor-edge-*-linux-*.tar.gz)가 없습니다." >&2; exit 1; }
  TOKEN="$(grep -E '^AAS_TOKEN=' "$DIR/.env" | cut -d= -f2- || true)"
  CODE=$(curl -fsS -X POST ${TOKEN:+-H "Authorization: Bearer $TOKEN"} "http://127.0.0.1:$PORT/edge/registration-codes" | sed -n 's/.*"code":"\([^"]*\)".*/\1/p')
  [ -n "$CODE" ] || { echo "[X] 등록 코드를 만들지 못했습니다(EDGE=on 인지, 토큰이 맞는지 확인)." >&2; exit 1; }
  WORK=$(mktemp -d); tar xzf "$EDGE_PACKAGE" -C "$WORK"
  "$WORK"/vexplor-edge-*/install.sh --server "http://127.0.0.1:$PORT" --code "$CODE" --name "$EDGE_NAME" \
    ${EDGE_CREDENTIALS:+--credentials-file "$EDGE_CREDENTIALS"}
  rm -r "$WORK"
fi

IP=$(hostname -I 2>/dev/null | awk '{print $1}')
echo
echo "================================================"
echo "  설치 완료"
echo "================================================"
echo "  주소:        http://${IP:-이 서버의 IP}:$PORT"
echo "  첫 관리자:   화면에서 계정을 만들 때 코드 $(grep -E '^AAS_SETUP_CODE=' "$DIR/.env" | cut -d= -f2-)"
echo "  설치 위치:   $DIR  (설정 .env · 자료는 Docker 볼륨)"
echo "  상태:        cd $DIR && docker compose ps   ·   docker compose logs -f app"
[ "$EDGE" -eq 1 ] && echo "  원격 수집기: systemctl status vexplor-edge — 서버에서 읽을 목록을 승인해야 읽기 시작합니다"
echo "  재부팅해도 스스로 다시 올라옵니다."
