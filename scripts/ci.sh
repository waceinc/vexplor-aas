#!/usr/bin/env bash
# CI가 도는 순서 그대로 — 로컬에서도 같은 명령으로 확인한다.
#   bash scripts/ci.sh
# 🔴 tsc -b와 vitest를 동시에 돌리지 않는다(같은 파일을 잡아 서로 막힌다). 그래서 순차다.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "▶ 1/8 빌드 (tsc -b)"
npx tsc -b

echo "▶ 2/8 웹 타입 검사"
npm run --silent typecheck --workspace @aas/web

echo "▶ 3/8 테스트 (vitest)"
npx vitest run

echo "▶ 4/8 IDTA Part 2 규격 대조"
node scripts/part2-coverage.mjs

# ── 아래 넷은 「사람이 기억해서 지키던 것」을 검사로 바꾼 것이다 ──────────────

echo "▶ 5/8 규칙 문서가 코드와 같은가"
node scripts/make-rule-list.mjs --check

echo "▶ 6/8 의존성 라이선스 — 런타임에 카피레프트가 없는가"
node scripts/make-third-party-notices.mjs --check

echo "▶ 7/8 시험 파일에 실제 회사·제품 이름이 없는가"
# 🔴 파이썬이 없다고 건너뛰지 않는다 — 건너뛰면 「검사했다」고 믿게 된다
if command -v python3 >/dev/null 2>&1 && python3 -c "" >/dev/null 2>&1; then
  python3 scripts/scan-fixture-names.py tests/fixtures >/dev/null
elif command -v python >/dev/null 2>&1; then
  python scripts/scan-fixture-names.py tests/fixtures >/dev/null
else
  echo "🔴 python이 없습니다 — 시험 파일 검사를 할 수 없습니다." >&2
  exit 1
fi

echo "▶ 8/8 화면 글자가 번역기를 거치고 영어 사전에 있는가"
# 🔴 화면에 한국어를 새로 적고 사전을 빼먹으면, 영어 화면의 그 자리만 한국어로 남는다
node scripts/i18n-scan.mjs --check

echo "✅ CI 통과"
