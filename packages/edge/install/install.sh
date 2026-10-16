#!/bin/sh
# VEXPLOR Edge — install on Linux with one command (docs/edge-install.md).
#
#   sudo ./install.sh --server https://aas.example.com --code 7KQ4-M2XD-9PRT [--proxy http://proxy:3128]
#                     [--ca-file corp-ca.pem] [--credentials-file credentials.json] [--name "Line 1"] [--no-service]
#
# Installs the program to /opt/vexplor-edge, keeps its key and queue in /var/lib/vexplor-edge (owner only), writes
# /etc/vexplor-edge/edge.json, registers with the one-time code, and starts the systemd service vexplor-edge.
# It reads equipment only after a person approves the read list on the server.
set -eu

SERVER=""; CODE=""; PROXY=""; CA=""; CREDENTIALS=""; NAME="VEXPLOR Edge"; SERVICE=1
while [ $# -gt 0 ]; do
  case "$1" in
    --server) SERVER="$2"; shift 2 ;;
    --code) CODE="$2"; shift 2 ;;
    --proxy) PROXY="$2"; shift 2 ;;
    --ca-file) CA="$2"; shift 2 ;;
    --credentials-file) CREDENTIALS="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --no-service) SERVICE=0; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done
[ -n "$SERVER" ] && [ -n "$CODE" ] || { echo "usage: sudo $0 --server https://… --code XXXX-XXXX-XXXX [options]" >&2; exit 2; }
[ "$(id -u)" -eq 0 ] || { echo "run as root (sudo)" >&2; exit 1; }
# The values go into a JSON file as they are — refuse quotes and backslashes rather than escape them
for value in "$SERVER" "$CODE" "$PROXY" "$NAME"; do
  case "$value" in *\"*|*\\*) echo "quotes and backslashes are not allowed: $value" >&2; exit 2 ;; esac
done
HERE=$(cd "$(dirname "$0")" && pwd)

id vexplor-edge >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin vexplor-edge
install -d -m 0755 /opt/vexplor-edge
install -m 0755 "$HERE/vexplor-edge" /opt/vexplor-edge/vexplor-edge
install -d -m 0700 -o vexplor-edge -g vexplor-edge /var/lib/vexplor-edge
install -d -m 0750 -o root -g vexplor-edge /etc/vexplor-edge

EXTRA=""
if [ -n "$CA" ]; then install -m 0640 -o root -g vexplor-edge "$CA" /etc/vexplor-edge/ca.pem; EXTRA="$EXTRA, \"caFile\": \"ca.pem\""; fi
if [ -n "$CREDENTIALS" ]; then install -m 0640 -o root -g vexplor-edge "$CREDENTIALS" /etc/vexplor-edge/credentials.json; EXTRA="$EXTRA, \"credentialsFile\": \"credentials.json\""; fi
if [ -n "$PROXY" ]; then EXTRA="$EXTRA, \"proxy\": \"$PROXY\""; fi
umask 027
cat > /etc/vexplor-edge/edge.json <<JSON
{ "server": "$SERVER", "stateDir": "/var/lib/vexplor-edge", "name": "$NAME"$EXTRA }
JSON
chown root:vexplor-edge /etc/vexplor-edge/edge.json

runuser -u vexplor-edge -- /opt/vexplor-edge/vexplor-edge register --config /etc/vexplor-edge/edge.json --code "$CODE"

if [ "$SERVICE" -eq 1 ]; then
  install -m 0644 "$HERE/vexplor-edge.service" /etc/systemd/system/vexplor-edge.service
  systemctl daemon-reload
  systemctl enable --now vexplor-edge
  echo "installed and started: systemctl status vexplor-edge · journalctl -u vexplor-edge"
else
  echo "installed (no service): runuser -u vexplor-edge -- /opt/vexplor-edge/vexplor-edge run --config /etc/vexplor-edge/edge.json"
fi
echo "Next: approve this device's read list on the server — it reads nothing before that."
