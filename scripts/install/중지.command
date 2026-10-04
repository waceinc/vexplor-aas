#!/usr/bin/env bash
# 잠시 내릴 때 — 두 번 클릭하십시오. 저장된 자료는 그대로 남습니다.
set -uo pipefail
cd "$(dirname "$0")"

for _dir in /usr/local/bin /opt/homebrew/bin "$HOME/.docker/bin" \
            /Applications/Docker.app/Contents/Resources/bin; do
  [ -d "$_dir" ] && case ":$PATH:" in *":$_dir:"*) ;; *) PATH="$PATH:$_dir" ;; esac
done
export PATH

echo "중지합니다. 저장된 자료는 그대로 남습니다."
docker compose down
echo
echo "중지했습니다. 다시 켜려면 실행.command 를 두 번 클릭하십시오."
echo
read -r -p "엔터를 누르면 닫힙니다."
