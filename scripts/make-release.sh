#!/usr/bin/env bash
#
# Build a release bundle — one folder handed over whole to another company or site.
#
# Important: why the images are bundled too: the target is an **air-gapped factory** (spec Ⅷ). Without internet
#    `docker compose up` cannot pull images. Carrying it in on USB and installing once must be enough.
#
# Important: the CPU type has to match. An arm64 image built on an Apple silicon Mac **does not start on a
#    Windows/Linux server (amd64).** So a separate bundle is built per CPU — the CPU is baked into
#    the file name so the receiving side does not have to choose.
#
# Usage:
#   bash scripts/make-release.sh              # builds both (windows + mac)
#   bash scripts/make-release.sh 1.0.0 windows
#   bash scripts/make-release.sh 1.0.0 mac
set -euo pipefail

cd "$(dirname "$0")/.."
VERSION="${1:-$(grep -o "PRODUCT_VERSION = '[^']*'" packages/aas-core/src/version.ts | cut -d"'" -f2)}"
TARGET="${2:-all}"
DB_IMAGE="timescale/timescaledb:latest-pg17"

# Receiving environment → CPU type. Windows and ordinary Linux servers are amd64, Apple silicon Macs are arm64
build_one() {
  local kind="$1" platform="$2"
  local app_image="aas-platform:${VERSION}-${kind}"
  local stage="out/release/VEXPLOR-AAS-Studio-${VERSION}-${kind}"

  echo
  echo "════ ${kind} (${platform}) ════"
  rm -rf "${stage}"; mkdir -p "${stage}"

  # Important: turn off provenance and sbom. When on, the image becomes a manifest list and `docker save`
  #    drags in the other CPU's image too (measured: the bundle grew from 576MB → 1.0GB)
  echo "▶ Build the app image"
  docker buildx build --platform "${platform}" --provenance=false --sbom=false \
    -t "${app_image}" --load . >/dev/null

  # Important: pin the DB to a **CPU-specific tag** too. Using the shared tag (timescale/…:latest-pg17) as-is
  #    mixes in the other CPU's copy pulled just before (caught by measurement)
  local db_image="aas-db:${VERSION}-${kind}"
  echo "▶ Fetch the DB image"
  docker pull --quiet --platform "${platform}" "${DB_IMAGE}" >/dev/null
  docker tag "${DB_IMAGE}" "${db_image}"

  # Important: both images in one file — splitting into two leads to accidents where only one gets carried in
  echo "▶ Save the images to a file (takes a few minutes)"
  # Important: pass `--platform`. Docker Desktop's image store holds several CPU variants together,
  #    so a plain save pulls the other CPU's image along (measured: arm64 got mixed into the Windows bundle)
  docker save --platform "${platform}" "${app_image}" "${db_image}" | gzip > "${stage}/images.tar.gz"

  echo "▶ Collect the run files"
  sed -e "s|build: \.|image: ${app_image}|" \
      -e "s|image: timescale/timescaledb:latest-pg17|image: ${db_image}|" \
      docker-compose.yml > "${stage}/docker-compose.yml"
  cp .env.example "${stage}/.env.example"
  cp docs/설치.md "${stage}/설치안내서.md"
  cp docs/사용법.md "${stage}/사용법.md"
  cp docs/install.md "${stage}/install.md"
  cp docs/usage.md "${stage}/usage.md"
  # Important: the file and folder names inside the bundle stay Korean — they are what the Korean customer sees
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

  # Important: text files going to Windows get CRLF line endings. With LF only, batch files
  #    misalign goto and parenthesized blocks, and the readme shows up as one line in Notepad.
  if [ "${kind}" = "windows" ]; then
    for f in "${stage}"/*.bat "${stage}"/먼저읽어보세요.txt; do
      [ -f "${f}" ] && perl -pi -e 's/(?<!\r)\n/\r\n/' "${f}"
    done
  fi

  # Important: if something unintended slips into the bundle its size doubles
  #    (measured: a leftover unpacked images/ folder took it from 571MB → 1.1GB).
  #    Do not compare by name — macOS stores Korean file names decomposed (NFD),
  #    so they do not match the Korean (NFC) in the script. Check **by size**.
  local images_mb total_mb
  images_mb=$(( $(wc -c < "${stage}/images.tar.gz") / 1024 / 1024 ))
  total_mb=$(du -sm "${stage}" | cut -f1)
  if [ $(( total_mb - images_mb )) -gt 50 ]; then
    echo "[FAIL] The bundle is larger than expected — images are ${images_mb}MB but the total is ${total_mb}MB."
    echo "   Check whether something slipped in:"
    du -sh "${stage}"/* | sort -rh | head -5
    exit 1
  fi

  (cd out/release && tar --exclude '.DS_Store' -czf "VEXPLOR-AAS-Studio-${VERSION}-${kind}.tar.gz" "VEXPLOR-AAS-Studio-${VERSION}-${kind}")
  echo "[OK] out/release/VEXPLOR-AAS-Studio-${VERSION}-${kind}.tar.gz  ($(du -h "out/release/VEXPLOR-AAS-Studio-${VERSION}-${kind}.tar.gz" | cut -f1))"
}

case "${TARGET}" in
  windows) build_one windows linux/amd64 ;;
  mac)     build_one mac     linux/arm64 ;;
  all)     build_one windows linux/amd64; build_one mac linux/arm64 ;;
  *) echo "The second argument must be one of windows · mac · all."; exit 1 ;;
esac

echo
echo "What the receiving side does:"
echo "  Windows: unpack → double-click 설치.bat"
echo "  Mac:     unpack → double-click 설치.command"
