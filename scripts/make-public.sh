#!/usr/bin/env bash
# 공개 저장소에 올릴 폴더를 **따로 뽑는다** — 이 저장소 자체는 건드리지 않는다.
#
#   bash scripts/make-public.sh            # 뽑고 검사한다            → out/public
#   bash scripts/make-public.sh --verify   # + 뽑은 폴더에서 설치·빌드·시험까지 돌려 본다
#
# 🔴 **이 저장소를 그대로 공개하면 안 된다.** 남의 저작물(PDF)·사업 자료·내부 기록이 섞여 있고,
#    지운다 해도 **이력에 남는다**(예전 커밋에 토큰이 박혔던 적이 있다). 그래서 깎아 내지 않고
#    허용한 것만 새 폴더로 뽑아, 거기서 **이력 없는 첫 커밋**으로 시작한다.
#
# 🔴 커밋된 것(HEAD)만 나간다. 작업 중인 변경·무시된 파일(out/ · .env)은 따라가지 않는다 —
#    「뽑은 것」과 「검토한 것」이 같아야 하기 때문이다. 먼저 커밋하고 돌릴 것.
#
# 🔴 여기서 **올리지는 않는다.** 공개는 되돌릴 수 없으니 마지막 한 걸음은 사람이 한다(끝에 안내).
set -euo pipefail
cd "$(dirname "$0")/.."

OUT="out/public"
VERIFY=0
for arg in "$@"; do
  case "$arg" in
    --verify) VERIFY=1 ;;
    *) echo "모르는 인자: $arg" >&2; exit 2 ;;
  esac
done

# 나가는 것 — **여기 없는 것은 나가지 않는다.** 새 파일을 공개하려면 여기에 적어야 한다.
ALLOW=(
  # 뿌리
  .dockerignore .env.example .gitattributes .gitignore .github
  Caddyfile.example Dockerfile docker-compose.yml
  LICENSE NOTICE README.md README.en.md CONTRIBUTING.md SECURITY.md THIRD-PARTY-NOTICES.md
  package.json package-lock.json tsconfig.json tsconfig.base.json vitest.config.ts
  # 코드 · 시험
  apps packages tests templates
  # 문서 — 쓰는 사람용만. 개발 기록·규칙 실측 자료는 싣지 않는다
  docs/사용법.md docs/설치.md docs/배포_호스팅.md docs/규칙_목록.md docs/images docs/spec
  # 도구
  scripts/ci.sh scripts/lint.mjs scripts/roundtrip.mjs scripts/part2-coverage.mjs
  scripts/make-rule-list.mjs scripts/make-third-party-notices.mjs scripts/set-license.mjs
  scripts/scan-fixture-names.py scripts/check-public-tree.mjs scripts/make-public.sh
  scripts/aas-test-engines.py scripts/basyx-check.py
  scripts/i18n-scan.mjs scripts/i18n-append.mjs scripts/make-samples.mjs
  scripts/opcua-browse.mjs scripts/plc-simulator.mjs scripts/make-demo-aasx.mjs scripts/make-bundle-demo.mjs
  scripts/make-release.sh scripts/install
)

if [ -n "$(git status --porcelain)" ]; then
  echo "🔴 커밋하지 않은 변경이 있습니다 — 그것은 나가지 않습니다. 먼저 커밋하십시오." >&2
  git status --short | head -10 >&2
  exit 1
fi

echo "▶ 1/4 뽑기 — HEAD에서 허용한 것만"
# 🔴 공개 저장소의 이력(.git)은 **지키고** 내용만 갈아 끼운다. 통째로 지우면 두 번째 공개부터
#    이력이 끊겨 「첫 공개」만 거듭하게 된다. 내용은 전부 지우고 다시 뽑는다 — 이 저장소에서
#    지운 파일이 공개 쪽에 남아 있으면 안 되기 때문이다(그 뒤 git add -A가 삭제까지 잡는다).
#
# 🔴 `.git`을 **옮기지 않는다 — 손대지 않는다.** 처음엔 「밖으로 옮기고 → 폴더를 지우고 →
#    되돌려 놓는」 식으로 짰는데, 폴더를 지우다 실패하면(누가 그 안에 들어가 있으면 지워지지
#    않는다) 이력이 밖에 나가 있는 채로 멈추고, **다음 실행이 그것을 지운다.** 실제로 겪었다.
#    지킬 것을 옮기는 순간 잃을 수 있는 틈이 생긴다. 그 자리에 두고 나머지만 비운다.
mkdir -p "$OUT"
find "$OUT" -mindepth 1 -maxdepth 1 ! -name '.git' -exec rm -rf {} +
# 🔴 git archive는 **커밋된 내용**만 내보낸다. 작업 폴더를 복사하면 무시된 파일이 딸려 간다
git -c core.quotepath=off archive --format=tar HEAD -- "${ALLOW[@]}" | tar -x -C "$OUT"
echo "   파일 $(find "$OUT" -type f -not -path "$OUT/.git/*" | wc -l)개"

echo "▶ 2/4 나가면 안 되는 것이 섞였는가"
node scripts/check-public-tree.mjs "$OUT"

echo "▶ 3/4 시험 파일에 실제 회사·제품 이름이 없는가"
if command -v python3 >/dev/null 2>&1 && python3 -c "" >/dev/null 2>&1; then PY=python3; else PY=python; fi
"$PY" scripts/scan-fixture-names.py "$OUT/tests/fixtures" | tail -1

if [ "$VERIFY" = "1" ]; then
  echo "▶ 4/4 뽑은 폴더가 **혼자 서는가** — 설치·빌드·시험"
  # 🔴 「여기서는 된다」는 확인이 아니다. 뺀 파일에 기대고 있었다면 뽑은 폴더에서만 깨진다.
  #    전에 빌드한 자리에서만 도는 꾸러미를 낸 적이 있다 — 옮겨서 돌려 봐야 확인이다
  ( cd "$OUT" && npm ci --no-audit --no-fund >/dev/null && bash scripts/ci.sh )
else
  echo "▶ 4/4 (건너뜀) 혼자 서는지 보려면 --verify"
fi

if [ -d "$OUT/.git" ]; then
  cat <<EOF

✅ 공개할 폴더를 갈아 끼웠습니다: $OUT  (공개 저장소의 이력은 그대로입니다)

   올리는 것은 사람이 합니다 — 한 번 나가면 되돌릴 수 없습니다.
     cd $OUT
     git status --short            # 무엇이 바뀌었는지 먼저 본다
     git add -A && git commit -m "<무엇을 왜 바꿨는지>"
     git push
EOF
else
  cat <<EOF

✅ 공개할 폴더가 준비됐습니다: $OUT

   올리는 것은 사람이 합니다 — 한 번 나가면 되돌릴 수 없습니다.
     cd $OUT
     git init -b main && git add -A && git commit -m "첫 공개"
     git remote add origin <새 저장소 주소>
     git push -u origin main

   🔴 올리기 전에: 사내에서 쓰던 토큰은 **전부 새로 바꾸십시오.**
      이 폴더에는 이력이 없지만, 예전에 쓰던 값이 어디선가 살아 있을 수 있습니다.
EOF
fi
