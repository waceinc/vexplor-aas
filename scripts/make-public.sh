#!/usr/bin/env bash
# **Extracts a separate folder** to push to the public repository — this repository itself is left untouched.
#
#   bash scripts/make-public.sh            # extract and check            → out/public
#   bash scripts/make-public.sh --verify   # + install, build and test inside the extracted folder
#
# Important: **this repository must not be published as-is.** It mixes in third-party works (PDF), business material and internal records,
#    and even deleted files **stay in history** (a token was once committed in an old commit). So instead of trimming down,
#    only what is allowed is extracted into a new folder, which starts from a **first commit with no history**.
#
# Important: only committed content (HEAD) goes out. Work-in-progress changes and ignored files (out/ · .env) do not follow —
#    because "what was extracted" must equal "what was reviewed". Commit first, then run.
#
# Important: this script **does not push.** Publishing cannot be undone, so the last step is done by a person (instructions at the end).
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

# What goes out — **anything not listed here does not go out.** To publish a new file, list it here.
ALLOW=(
  # root
  .dockerignore .env.example .gitattributes .gitignore .github
  Caddyfile.example Dockerfile docker-compose.yml
  LICENSE NOTICE README.md README.ko.md CONTRIBUTING.md SECURITY.md THIRD-PARTY-NOTICES.md
  package.json package-lock.json tsconfig.json tsconfig.base.json vitest.config.ts
  # code · tests
  apps packages tests templates
  # docs — user-facing only. Development logs and rule measurement material are not included
  docs/사용법.md docs/설치.md docs/배포_호스팅.md docs/규칙_목록.md docs/images docs/spec
  docs/usage.md docs/install.md docs/deployment.md docs/rules.md
  # tools
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
# Important: **keep** the public repository's history (.git) and only swap the contents. Deleting it wholesale breaks
#    history from the second publish on, so every publish becomes a "first publish". All content is cleared and re-extracted —
#    files deleted in this repository must not linger on the public side (git add -A then also picks up deletions).
#
# Important: **do not move `.git` — do not touch it.** The first version did "move it out → delete the folder →
#    move it back", but if deleting the folder fails (it cannot be deleted while someone is inside it)
#    the history is left outside, and **the next run deletes it.** This actually happened.
#    The moment you move what you must keep, a gap opens where it can be lost. Leave it in place and empty the rest.
mkdir -p "$OUT"
find "$OUT" -mindepth 1 -maxdepth 1 ! -name '.git' -exec rm -rf {} +
# Important: git archive exports **committed content** only. Copying the working folder drags ignored files along
git -c core.quotepath=off archive --format=tar HEAD -- "${ALLOW[@]}" | tar -x -C "$OUT"
echo "   파일 $(find "$OUT" -type f -not -path "$OUT/.git/*" | wc -l)개"

echo "▶ 2/4 나가면 안 되는 것이 섞였는가"
node scripts/check-public-tree.mjs "$OUT"

echo "▶ 3/4 시험 파일에 실제 회사·제품 이름이 없는가"
if command -v python3 >/dev/null 2>&1 && python3 -c "" >/dev/null 2>&1; then PY=python3; else PY=python; fi
"$PY" scripts/scan-fixture-names.py "$OUT/tests/fixtures" | tail -1

if [ "$VERIFY" = "1" ]; then
  echo "▶ 4/4 뽑은 폴더가 **혼자 서는가** — 설치·빌드·시험"
  # Important: "it works here" is not verification. If it relied on an excluded file, it breaks only in the extracted folder.
  #    We once shipped a bundle that only ran where it had been built before — it is verified only after running it elsewhere
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
