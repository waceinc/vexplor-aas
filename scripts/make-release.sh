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
#   bash scripts/make-release.sh 1.0.0 linux          # site server, x86_64: install.sh + the remote collector (docs/site-install.md)
#   bash scripts/make-release.sh 1.0.0 linux-arm64    # the same for ARM servers (and tests on an ARM Mac)
#   bash scripts/make-release.sh 1.0.0 linux community   # third argument: the database edition (below)
#
# Two database editions (TimescaleDB licence review 2026-10-16, lead request §7 T2):
#   apache2    (default)  TimescaleDB Apache-2 Edition — `<TIMESCALE>-pg17-oss`, Apache 2.0. No compression and no
#                         continuous aggregates; for free installs and anything handed over without a contract.
#   community             TimescaleDB Community Edition — `<TIMESCALE>-pg17`, Timescale License. Only for customers with
#                         a paid licence agreement that carries the third-party-software clause.
# Both are pinned to one TimescaleDB version, never `latest` — what was shipped must be provable (TSL 7.2). Each bundle
# carries THIRD-PARTY-NOTICES.txt, the licence texts under licenses/, BUNDLE.txt (images and digests), and its hash is
# added to out/release/SHA256SUMS.
#
# Important: without Docker Desktop's buildx (e.g. podman as docker) the images are built with plain `docker build` and
#    saved under docker.io/library/<name> — podman would otherwise save them as localhost/<name>, a name the
#    receiving Docker does not match against docker-compose.yml.
# Important: build an x86_64 bundle on an x86_64 machine or with Docker Desktop (Rosetta). Under podman's qemu emulation on
#    an ARM Mac the web build crashes (exit 139, measured 2026-10-16); an ARM bundle builds natively there.
set -euo pipefail

cd "$(dirname "$0")/.."
VERSION="${1:-$(grep -o "PRODUCT_VERSION = '[^']*'" packages/aas-core/src/version.ts | cut -d"'" -f2)}"
TARGET="${2:-all}"
EDITION="${3:-apache2}"
TIMESCALE=2.30.2
case "${EDITION}" in
  apache2)   DB_IMAGE="timescale/timescaledb:${TIMESCALE}-pg17-oss"; EDITION_NAME="TimescaleDB Apache-2 Edition"; SUFFIX="" ;;
  community) DB_IMAGE="timescale/timescaledb:${TIMESCALE}-pg17"; EDITION_NAME="TimescaleDB Community Edition"; SUFFIX="-community" ;;
  *) echo "The third argument must be apache2 or community."; exit 1 ;;
esac

# Receiving environment → CPU type. Windows and ordinary Linux servers are amd64, Apple silicon Macs are arm64
build_one() {
  local kind="$1" platform="$2"
  local app_image="aas-platform:${VERSION}-${kind}"
  local name="VEXPLOR-AAS-Studio-${VERSION}-${kind}${SUFFIX}"
  local stage="out/release/${name}"

  echo
  echo "════ ${kind} (${platform}) · ${EDITION_NAME} ════"
  rm -rf "${stage}"; mkdir -p "${stage}"

  # Important: turn off provenance and sbom. When on, the image becomes a manifest list and `docker save`
  #    drags in the other CPU's image too (measured: the bundle grew from 576MB → 1.0GB)
  echo "▶ Build the app image"
  local buildx=1
  docker buildx version >/dev/null 2>&1 || buildx=0
  if [ "${buildx}" -eq 1 ]; then
    docker buildx build --platform "${platform}" --provenance=false --sbom=false \
      -t "${app_image}" --load . >/dev/null
  else
    docker build --platform "${platform}" -t "docker.io/library/${app_image}" . >/dev/null
  fi

  # Important: pin the DB to a **CPU-specific tag** too. Using the shared tag (timescale/…:latest-pg17) as-is
  #    mixes in the other CPU's copy pulled just before (caught by measurement)
  local db_image="aas-db:${VERSION}-${kind}-${EDITION}"
  echo "▶ Fetch the DB image"
  docker pull --quiet --platform "${platform}" "${DB_IMAGE}" >/dev/null
  if [ "${buildx}" -eq 1 ]; then docker tag "${DB_IMAGE}" "${db_image}"; else docker tag "${DB_IMAGE}" "docker.io/library/${db_image}"; fi

  # Important: both images in one file — splitting into two leads to accidents where only one gets carried in
  echo "▶ Save the images to a file (takes a few minutes)"
  # Important: pass `--platform`. Docker Desktop's image store holds several CPU variants together,
  #    so a plain save pulls the other CPU's image along (measured: arm64 got mixed into the Windows bundle)
  if [ "${buildx}" -eq 1 ]; then
    docker save --platform "${platform}" "${app_image}" "${db_image}" | gzip > "${stage}/images.tar.gz"
  else
    docker save "docker.io/library/${app_image}" "docker.io/library/${db_image}" | gzip > "${stage}/images.tar.gz"
  fi

  echo "▶ Collect the run files"
  sed -e "s|build: \.|image: ${app_image}|" \
      -e "s|image: timescale/timescaledb:latest-pg17|image: ${db_image}|" \
      docker-compose.yml > "${stage}/docker-compose.yml"
  cp .env.example "${stage}/.env.example"
  mkdir -p "${stage}/db"; cp db/10-app-user.sh "${stage}/db/10-app-user.sh"; chmod +x "${stage}/db/10-app-user.sh"

  # Licences: the database edition's notice first, then this product's own dependencies
  mkdir -p "${stage}/licenses"
  cp LICENSE "${stage}/LICENSE"; cp NOTICE "${stage}/NOTICE"
  if [ "${EDITION}" = "community" ]; then
    cp scripts/install/licenses/TimescaleDB-TSL.txt "${stage}/licenses/"
  else
    cp scripts/install/licenses/TimescaleDB-Apache-2.0.txt scripts/install/licenses/TimescaleDB-NOTICE.txt "${stage}/licenses/"
  fi
  { sed "s/@TIMESCALE@/${TIMESCALE}/" "scripts/install/licenses/NOTICE-${EDITION}.txt"; echo; echo; cat THIRD-PARTY-NOTICES.md; } > "${stage}/THIRD-PARTY-NOTICES.txt"
  # What exactly went in — the database image by its registry digest, so the edition and version can be proven later
  {
    echo "VEXPLOR AAS Studio ${VERSION} · ${kind} (${platform}) · built $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "database: ${EDITION_NAME} ${TIMESCALE} — ${DB_IMAGE}"
    echo "database digest: $(docker image inspect --format '{{join .RepoDigests " "}}' "${DB_IMAGE}" 2>/dev/null)"
    echo "app image: ${app_image} $(docker image inspect --format '{{.Id}}' "${app_image}" 2>/dev/null || docker image inspect --format '{{.Id}}' "docker.io/library/${app_image}")"
  } > "${stage}/BUNDLE.txt"
  cp docs/설치.md "${stage}/설치안내서.md"
  cp docs/사용법.md "${stage}/사용법.md"
  cp docs/install.md "${stage}/install.md"
  cp docs/usage.md "${stage}/usage.md"
  # Important: the file and folder names inside the bundle stay Korean — they are what the Korean customer sees
  cp out/VEXPLOR_AAS_Studio_매뉴얼.pptx "${stage}/매뉴얼.pptx" 2>/dev/null || true
  mkdir -p "${stage}/문서"; cp -r docs/images "${stage}/문서/images" 2>/dev/null || true

  if [ "${kind}" = "linux" ] || [ "${kind}" = "linux-arm64" ]; then
    # The site server: one command, plus the remote collector for the same CPU (packed fresh for this version)
    cp scripts/install/install-linux.sh "${stage}/install.sh"; chmod +x "${stage}/install.sh"
    # The licence notice is on the first page of the install guide (review §4 (가))
    { sed "s/@TIMESCALE@/${TIMESCALE}/" "scripts/install/licenses/NOTICE-${EDITION}.txt"; echo; echo; cat scripts/install/README-리눅스.txt; } > "${stage}/먼저읽어보세요.txt"
    cp docs/현장설치.md "${stage}/현장설치.md"; cp docs/site-install.md "${stage}/site-install.md"
    local edge_platform=linux-x64 edge_flag=""
    [ "${kind}" = "linux-arm64" ] && { edge_platform=linux-arm64; edge_flag=--arm64; }
    node scripts/pack-edge.mjs ${edge_flag} >/dev/null
    cp "out/edge/vexplor-edge-${VERSION}-${edge_platform}.tar.gz" "${stage}/"
  elif [ "${kind}" = "windows" ]; then
    cp scripts/install/설치.bat "${stage}/설치.bat"
    cp scripts/install/실행.bat "${stage}/실행.bat"
    cp scripts/install/중지.bat "${stage}/중지.bat"
    { sed "s/@TIMESCALE@/${TIMESCALE}/" "scripts/install/licenses/NOTICE-${EDITION}.txt"; echo; echo; cat scripts/install/README-윈도우.txt; } > "${stage}/먼저읽어보세요.txt"
  else
    for f in 설치 실행 중지; do
      cp "scripts/install/${f}.command" "${stage}/${f}.command"
      chmod +x "${stage}/${f}.command"
    done
    { sed "s/@TIMESCALE@/${TIMESCALE}/" "scripts/install/licenses/NOTICE-${EDITION}.txt"; echo; echo; cat scripts/install/README-맥.txt; } > "${stage}/먼저읽어보세요.txt"
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
  # The Linux bundle carries the remote collector package on purpose — it counts as expected, like the images
  for edge in "${stage}"/vexplor-edge-*.tar.gz; do
    [ -f "${edge}" ] && images_mb=$(( images_mb + $(wc -c < "${edge}") / 1024 / 1024 ))
  done
  total_mb=$(du -sm "${stage}" | cut -f1)
  if [ $(( total_mb - images_mb )) -gt 50 ]; then
    echo "[FAIL] The bundle is larger than expected — images are ${images_mb}MB but the total is ${total_mb}MB."
    echo "   Check whether something slipped in:"
    du -sh "${stage}"/* | sort -rh | head -5
    exit 1
  fi

  # Important: --no-xattrs — macOS tar otherwise records Apple file attributes, and GNU tar on the server prints a
  #    warning for every file (measured on Ubuntu 24.04)
  (cd out/release && COPYFILE_DISABLE=1 tar --no-xattrs --exclude '.DS_Store' -czf "${name}.tar.gz" "${name}")
  # The hash of what was shipped — one line per bundle, replaced when the same bundle is built again
  local sum
  sum="$(shasum -a 256 "out/release/${name}.tar.gz" | cut -d' ' -f1)"
  touch out/release/SHA256SUMS
  grep -v "  ${name}.tar.gz\$" out/release/SHA256SUMS > out/release/SHA256SUMS.new || true
  echo "${sum}  ${name}.tar.gz" >> out/release/SHA256SUMS.new; mv out/release/SHA256SUMS.new out/release/SHA256SUMS
  echo "[OK] out/release/${name}.tar.gz  ($(du -h "out/release/${name}.tar.gz" | cut -f1)) · sha256 ${sum}"
}

case "${TARGET}" in
  windows) build_one windows linux/amd64 ;;
  mac)     build_one mac     linux/arm64 ;;
  linux)   build_one linux   linux/amd64 ;;
  linux-arm64) build_one linux-arm64 linux/arm64 ;;
  all)     build_one windows linux/amd64; build_one mac linux/arm64; build_one linux linux/amd64 ;;
  *) echo "The second argument must be one of windows · mac · linux · linux-arm64 · all."; exit 1 ;;
esac

echo
echo "What the receiving side does:"
echo "  Windows: unpack → double-click 설치.bat"
echo "  Mac:     unpack → double-click 설치.command"
echo "  Linux:   unpack → sudo ./install.sh [--with-edge]"
