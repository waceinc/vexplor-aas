#!/usr/bin/env bash
# CI가 도는 순서 그대로 — 로컬에서도 같은 명령으로 확인한다.
#   bash scripts/ci.sh
# 🔴 tsc -b와 vitest를 동시에 돌리지 않는다(같은 파일을 잡아 서로 막힌다). 그래서 순차다.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "▶ 1/10 빌드 (tsc -b)"
npx tsc -b

echo "▶ 2/10 웹 타입 검사"
npm run --silent typecheck --workspace @aas/web

echo "▶ 3/10 화면 빌드 (vite) — 배포본이 실제로 만들어지는가"
# 🔴 타입 검사만으로는 번들 단계의 실패(자산 경로 · 동적 import · CSS 처리)를 못 본다
npm run --silent build --workspace @aas/web > /dev/null

echo "▶ 4/10 테스트 (vitest)"
npx vitest run

echo "▶ 5/10 IDTA Part 2 규격 대조"
node scripts/part2-coverage.mjs

# ── 아래 넷은 「사람이 기억해서 지키던 것」을 검사로 바꾼 것이다 ──────────────

echo "▶ 6/10 규칙 문서가 코드와 같은가"
node scripts/make-rule-list.mjs --check

echo "▶ 7/10 의존성 라이선스 — 런타임에 카피레프트가 없는가"
node scripts/make-third-party-notices.mjs --check

echo "▶ 8/10 시험 파일에 실제 회사·제품 이름이 없는가"
# 🔴 파이썬이 없다고 건너뛰지 않는다 — 건너뛰면 「검사했다」고 믿게 된다
if command -v python3 >/dev/null 2>&1 && python3 -c "" >/dev/null 2>&1; then
  python3 scripts/scan-fixture-names.py tests/fixtures >/dev/null
elif command -v python >/dev/null 2>&1; then
  python scripts/scan-fixture-names.py tests/fixtures >/dev/null
else
  echo "🔴 python이 없습니다 — 시험 파일 검사를 할 수 없습니다." >&2
  exit 1
fi

echo "▶ 9/10 화면 글자와 서버 글이 번역기를 거치고 영어 사전에 있는가"
# 🔴 화면에 한국어를 새로 적고 사전을 빼먹으면, 영어 화면의 그 자리만 한국어로 남는다
node scripts/i18n-scan.mjs --check
# 🔴 서버가 만드는 글(지적 문구·결과서·번들·오류)도 같은 약속 — 영어 화면에서 그 자리만 한국어로 남지 않게
node scripts/i18n-server-scan.mjs --check

echo "▶ 10/10 화면 간격이 토큰과 표준 단계로만 되어 있는가"
# 🔴 간격에 숫자를 직접 적으면 칸마다 여백이 갈린다(2026-10-14 실측: 6 · 13 · 14px, 설정 창 1px)
node scripts/spacing-scan.mjs --check

echo "✅ CI 통과"
