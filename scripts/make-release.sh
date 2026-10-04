#!/usr/bin/env bash
#
# 배포 꾸러미 만들기 — 다른 회사·다른 현장에 통째로 건네는 한 폴더.
#
# 🔴 왜 이미지까지 싸는가: 배포처가 **폐쇄망 공장**이다(기획서 Ⅷ). 인터넷이 없으면
#    `docker compose up`이 이미지를 못 받아 온다. USB로 반입해 설치 한 번이면 끝나야 한다.
#
# 🔴 CPU 종류가 맞아야 돈다. 애플 실리콘 맥에서 만든 arm64 이미지는 **윈도우/리눅스 서버
#    (amd64)에서 안 뜬다.** 그래서 꾸러미를 CPU별로 따로 만든다 — 받는 쪽이 고르지 않게
#    파일 이름에 박아 둔다.
#
# 사용:
#   bash scripts/make-release.sh              # 둘 다 만든다 (windows + mac)
#   bash scripts/make-release.sh 1.0.0 windows
#   bash scripts/make-release.sh 1.0.0 mac
set -euo pipefail

cd "$(dirname "$0")/.."
VERSION="${1:-$(grep -o "PRODUCT_VERSION = '[^']*'" packages/aas-core/src/version.ts | cut -d"'" -f2)}"
TARGET="${2:-all}"
DB_IMAGE="timescale/timescaledb:latest-pg17"

# 받는 쪽 환경 → CPU 종류. 윈도우·일반 리눅스 서버는 amd64, 애플 실리콘 맥은 arm64
build_one() {
  local kind="$1" platform="$2"
  local app_image="aas-platform:${VERSION}-${kind}"
  local stage="out/release/VEXPLOR-AAS-Studio-${VERSION}-${kind}"

  echo
  echo "════ ${kind} (${platform}) ════"
  rm -rf "${stage}"; mkdir -p "${stage}"

  # 🔴 provenance·sbom을 끈다. 켜 두면 매니페스트 목록이 되어 `docker save`가
  #    다른 CPU 것까지 끌고 들어간다(실측: 꾸러미가 576MB → 1.0GB로 부풀었다)
  echo "▶ 앱 이미지 빌드"
  docker buildx build --platform "${platform}" --provenance=false --sbom=false \
    -t "${app_image}" --load . >/dev/null

  # 🔴 DB도 **CPU별 전용 태그**로 박아 둔다. 공용 태그(timescale/…:latest-pg17)를 그대로 쓰면
  #    직전에 받아 둔 다른 CPU 판이 섞여 들어간다(실측으로 잡았다)
  local db_image="aas-db:${VERSION}-${kind}"
  echo "▶ DB 이미지 확보"
  docker pull --quiet --platform "${platform}" "${DB_IMAGE}" >/dev/null
  docker tag "${DB_IMAGE}" "${db_image}"

  # 🔴 두 이미지를 한 파일로 — 두 개로 나누면 하나만 반입되는 사고가 난다
  echo "▶ 이미지를 파일로 저장 (몇 분 걸립니다)"
  # 🔴 `--platform`을 준다. Docker Desktop의 이미지 저장소는 여러 CPU 판을 함께 들고 있어서,
  #    그냥 save하면 다른 CPU 것까지 딸려 나온다(실측: 윈도우 꾸러미에 arm64가 섞였다)
  docker save --platform "${platform}" "${app_image}" "${db_image}" | gzip > "${stage}/images.tar.gz"

  echo "▶ 실행 파일 모으기"
  sed -e "s|build: \.|image: ${app_image}|" \
      -e "s|image: timescale/timescaledb:latest-pg17|image: ${db_image}|" \
      docker-compose.yml > "${stage}/docker-compose.yml"
  cp .env.example "${stage}/.env.example"
  cp docs/설치.md "${stage}/설치안내서.md"
  cp docs/사용법.md "${stage}/사용법.md"
  cp out/VEXPLOR_AAS_Studio_매뉴얼.pptx "${stage}/매뉴얼.pptx" 2>/dev/null || true
  mkdir -p "${stage}/문서"; cp -r docs/images "${stage}/문서/images" 2>/dev/null || true

  if [ "${kind}" = "windows" ]; then
    cp scripts/install/설치.bat "${stage}/설치.bat"
    cp scripts/install/실행.bat "${stage}/실행.bat"
    cp scripts/install/중지.bat "${stage}/중지.bat"
    cp scripts/install/README-윈도우.txt "${stage}/먼저읽어보세요.txt"
  else
    for f in 설치 실행 중지; do
      cp "scripts/install/${f}.command" "${stage}/${f}.command"
      chmod +x "${stage}/${f}.command"
    done
    cp scripts/install/README-맥.txt "${stage}/먼저읽어보세요.txt"
  fi

  # 🔴 윈도우로 가는 글 파일은 줄바꿈을 CRLF로 바꾼다. 배치 파일은 LF만 있으면
  #    goto·괄호 블록이 어긋나고, 안내문은 메모장에서 한 줄로 붙어 보인다.
  if [ "${kind}" = "windows" ]; then
    for f in "${stage}"/*.bat "${stage}"/먼저읽어보세요.txt; do
      [ -f "${f}" ] && perl -pi -e 's/(?<!\r)\n/\r\n/' "${f}"
    done
  fi

  # 🔴 꾸러미에 뜻하지 않은 것이 딸려 들어가면 크기가 배로 뛴다
  #    (실측: 풀어 본 images/ 폴더가 남아 571MB → 1.1GB가 됐다).
  #    이름으로 대조하지 않는다 — macOS는 한글 파일명을 분해해 저장해서(NFD)
  #    스크립트 안의 한글(NFC)과 글자가 안 맞는다. **크기로** 본다.
  local images_mb total_mb
  images_mb=$(( $(wc -c < "${stage}/images.tar.gz") / 1024 / 1024 ))
  total_mb=$(du -sm "${stage}" | cut -f1)
  if [ $(( total_mb - images_mb )) -gt 50 ]; then
    echo "🔴 꾸러미가 예상보다 큽니다 — 이미지 ${images_mb}MB인데 전체 ${total_mb}MB입니다."
    echo "   딸려 들어간 것이 없는지 보십시오:"
    du -sh "${stage}"/* | sort -rh | head -5
    exit 1
  fi

  (cd out/release && tar --exclude '.DS_Store' -czf "VEXPLOR-AAS-Studio-${VERSION}-${kind}.tar.gz" "VEXPLOR-AAS-Studio-${VERSION}-${kind}")
  echo "✅ out/release/VEXPLOR-AAS-Studio-${VERSION}-${kind}.tar.gz  ($(du -h "out/release/VEXPLOR-AAS-Studio-${VERSION}-${kind}.tar.gz" | cut -f1))"
}

case "${TARGET}" in
  windows) build_one windows linux/amd64 ;;
  mac)     build_one mac     linux/arm64 ;;
  all)     build_one windows linux/amd64; build_one mac linux/arm64 ;;
  *) echo "두 번째 인자는 windows · mac · all 중 하나입니다."; exit 1 ;;
esac

echo
echo "받는 쪽이 할 일:"
echo "  윈도우: 압축 풀고 → 설치.bat 두 번 클릭"
echo "  맥:     압축 풀고 → 설치.command 두 번 클릭"
