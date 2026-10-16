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
    *) echo "Unknown argument: $arg" >&2; exit 2 ;;
  esac
done

# What goes out — **anything not listed here does not go out.** To publish a new file, list it here.
ALLOW=(
  # root
  .dockerignore .env.example .gitattributes .gitignore .github
  Caddyfile.example Dockerfile docker-compose.yml
  LICENSE NOTICE README.md README.ko.md CONTRIBUTING.md CONTRIBUTING.ko.md SECURITY.md SECURITY.ko.md THIRD-PARTY-NOTICES.md
  package.json package-lock.json tsconfig.json tsconfig.base.json tsconfig.tests.json vitest.config.ts .nvmrc
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
  scripts/i18n-scan.mjs scripts/i18n-server-scan.mjs scripts/spacing-scan.mjs scripts/comment-guard.mjs
  scripts/i18n-append.mjs scripts/make-samples.mjs
  scripts/opcua-browse.mjs scripts/plc-simulator.mjs scripts/make-demo-aasx.mjs scripts/make-bundle-demo.mjs
  scripts/make-release.sh scripts/install scripts/pack-libraries.mjs
)

if [ -n "$(git status --porcelain)" ]; then
  echo "[FAIL] There are uncommitted changes — they will not go out. Commit first." >&2
  git status --short | head -10 >&2
  exit 1
fi

echo "▶ 1/4 Extract — only what is allowed, from HEAD"
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
echo "   Files: $(find "$OUT" -type f -not -path "$OUT/.git/*" | wc -l)"

echo "▶ 2/4 Did anything that must not go out slip in?"
node scripts/check-public-tree.mjs "$OUT"

echo "▶ 3/4 No real company or product names in test files?"
if command -v python3 >/dev/null 2>&1 && python3 -c "" >/dev/null 2>&1; then PY=python3; else PY=python; fi
"$PY" scripts/scan-fixture-names.py "$OUT/tests/fixtures" | tail -1

if [ "$VERIFY" = "1" ]; then
  echo "▶ 4/4 Does the extracted folder **stand on its own**? — install, build, test"
  # Important: "it works here" is not verification. If it relied on an excluded file, it breaks only in the extracted folder.
  #    We once shipped a bundle that only ran where it had been built before — it is verified only after running it elsewhere
  ( cd "$OUT" && npm ci --no-audit --no-fund >/dev/null && bash scripts/ci.sh )
else
  echo "▶ 4/4 (skipped) use --verify to check that it stands on its own"
fi

if [ -d "$OUT/.git" ]; then
  cat <<EOF

[OK] Replaced the contents of the folder to publish: $OUT  (the public repository history is kept)

   A person does the push — once it is out it cannot be taken back.
     cd $OUT
     git status --short            # look at what changed first
     git add -A && git commit -m "<what changed and why>"
     git push
EOF
else
  cat <<EOF

[OK] The folder to publish is ready: $OUT

   A person does the push — once it is out it cannot be taken back.
     cd $OUT
     git init -b main && git add -A && git commit -m "Initial public release"
     git remote add origin <new repository URL>
     git push -u origin main

   [WARN] Before pushing: **rotate every token** that was used internally.
      This folder has no history, but old values may still be alive somewhere.
EOF
fi
