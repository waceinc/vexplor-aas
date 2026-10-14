#!/usr/bin/env bash
# Runs the same steps in the same order as CI — use the same command to check locally.
#   bash scripts/ci.sh
# Important: never run tsc -b and vitest at the same time (they lock the same files and block each other). Hence sequential.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "▶ 1/10 빌드 (tsc -b)"
npx tsc -b

echo "▶ 2/10 웹 타입 검사"
npm run --silent typecheck --workspace @aas/web

echo "▶ 3/10 화면 빌드 (vite) — 배포본이 실제로 만들어지는가"
# Important: a type check alone cannot see bundle-stage failures (asset paths, dynamic import, CSS processing)
npm run --silent build --workspace @aas/web > /dev/null

echo "▶ 4/10 테스트 (vitest)"
npx vitest run

echo "▶ 5/10 IDTA Part 2 규격 대조"
node scripts/part2-coverage.mjs

# ── The four checks below turn "things people had to remember" into automated checks ──────────────

echo "▶ 6/10 규칙 문서가 코드와 같은가"
node scripts/make-rule-list.mjs --check

echo "▶ 7/10 의존성 라이선스 — 런타임에 카피레프트가 없는가"
node scripts/make-third-party-notices.mjs --check

echo "▶ 8/10 시험 파일에 실제 회사·제품 이름이 없는가"
# Important: do not skip when Python is missing — skipping makes us believe "it was checked"
if command -v python3 >/dev/null 2>&1 && python3 -c "" >/dev/null 2>&1; then
  python3 scripts/scan-fixture-names.py tests/fixtures >/dev/null
elif command -v python >/dev/null 2>&1; then
  python scripts/scan-fixture-names.py tests/fixtures >/dev/null
else
  echo "🔴 python이 없습니다 — 시험 파일 검사를 할 수 없습니다." >&2
  exit 1
fi

echo "▶ 9/10 화면 글자와 서버 글이 번역기를 거치고 영어 사전에 있는가"
# Important: if new Korean text is added to the UI without a dictionary entry, that spot alone stays Korean in the English UI
node scripts/i18n-scan.mjs --check
# Important: server-generated text (findings, reports, bundles, errors) follows the same contract — so no spot stays Korean in the English UI
node scripts/i18n-server-scan.mjs --check

echo "▶ 10/10 화면 간격이 토큰과 표준 단계로만 되어 있는가"
# Important: hard-coded spacing numbers make padding differ per cell (measured 2026-10-14: 6 · 13 · 14px, 1px in the settings window)
node scripts/spacing-scan.mjs --check

echo "✅ CI 통과"
