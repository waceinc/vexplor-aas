#!/usr/bin/env bash
# Runs the same steps in the same order as CI — use the same command to check locally.
#   bash scripts/ci.sh
# Important: never run tsc -b and vitest at the same time (they lock the same files and block each other). Hence sequential.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "▶ 1/10 Build (tsc -b)"
npx tsc -b

echo "▶ 2/10 Type check — web app, and the test code of every package"
npm run --silent typecheck --workspace @aas/web
# Important: vitest does not type-check. A test that reads a property that does not exist compares
# undefined with undefined and always passes (two such tests were found on 2026-10-14).
npx tsc -p tsconfig.tests.json

echo "▶ 3/10 UI build (vite) — does the shipped bundle actually build?"
# Important: a type check alone cannot see bundle-stage failures (asset paths, dynamic import, CSS processing)
npm run --silent build --workspace @aas/web > /dev/null

echo "▶ 4/10 Tests (vitest)"
npx vitest run

echo "▶ 5/10 IDTA Part 2 spec cross-check"
node scripts/part2-coverage.mjs

# ── The four checks below turn "things people had to remember" into automated checks ──────────────

echo "▶ 6/10 Do the rule documents match the code?"
node scripts/make-rule-list.mjs --check

echo "▶ 7/10 Dependency licenses — no copyleft at runtime?"
node scripts/make-third-party-notices.mjs --check

echo "▶ 8/10 No real company or product names in test files?"
# Important: do not skip when Python is missing — skipping makes us believe "it was checked"
if command -v python3 >/dev/null 2>&1 && python3 -c "" >/dev/null 2>&1; then
  python3 scripts/scan-fixture-names.py tests/fixtures >/dev/null
elif command -v python >/dev/null 2>&1; then
  python scripts/scan-fixture-names.py tests/fixtures >/dev/null
else
  echo "[FAIL] python not found — cannot check the test files." >&2
  exit 1
fi

echo "▶ 9/10 Do UI and server text go through the translator and exist in the English dictionary?"
# Important: if new Korean text is added to the UI without a dictionary entry, that spot alone stays Korean in the English UI
node scripts/i18n-scan.mjs --check
# Important: server-generated text (findings, reports, bundles, errors) follows the same contract — so no spot stays Korean in the English UI
node scripts/i18n-server-scan.mjs --check

echo "▶ 10/10 Does UI spacing use only tokens and the standard scale?"
# Important: hard-coded spacing numbers make padding differ per cell (measured 2026-10-14: 6 · 13 · 14px, 1px in the settings window)
node scripts/spacing-scan.mjs --check

echo "[PASS] CI passed"
