**English** · [한국어](CONTRIBUTING.ko.md)

# Contributing

Thank you for wanting to improve this project. There are only a few rules.

## Getting started

Node.js 24 LTS is recommended (22 or later works; `.nvmrc` pins 24).

```bash
npm ci
npx tsc -b              # build
npx vitest run          # tests
bash scripts/ci.sh      # the same 10 steps as CI — run once before you push
```

**Do not run `npx tsc -b` and `npx vitest run` at the same time.** They lock the same files and block each other.

To work on the UI, start two processes:

```bash
npm run dev:api     # API on 8080
npm run dev:web     # UI on 5173
```

## Seven rules

### 1. Check that a test actually catches the defect

If you fix a defect, run the new test once against the code *before* the fix and watch it fail.
A test that passes whether or not the bug is there is worse than no test — it makes people believe they are protected.

### 2. The three store implementations pass the same tests

`packages/store` has in-memory, folder and PostgreSQL implementations; all three must pass
`packages/store/test/conformance.ts`. If you add behaviour to the store, add a test there.
If you change a database table, change `SCHEMA_SQL` (latest full schema) and `MIGRATIONS` (statements that upgrade an
old database) in `schema.ts` **together**.

### 3. Regenerate generated documents

```bash
npx tsc -b && node scripts/make-rule-list.mjs      # docs/rules.md (English) and docs/규칙_목록.md (Korean)
```

`docs/rules.md`, `docs/규칙_목록.md` and `THIRD-PARTY-NOTICES.md` are generated from code. Do not edit them by hand —
CI checks that they match the code.

### 4. No real equipment data in test files

AASX files in `tests/fixtures/` use invented names only — no real manufacturer, model or contact details.

```bash
python scripts/scan-fixture-names.py tests/fixtures     # exit code 1 if it finds any
```

### 5. Comments explain *why*, in English

The code says what it does; comments say why it does it that way and what must not be done.
Write comments in English. `Important:` marks a place where a careless change breaks something silently.

Comments sometimes mention `PROGRESS §4` or `docs/rules/…`. Those point to internal development notes that are not
published; the meaning is written out in the comment itself.

### 6. Every user-facing sentence goes through the translator — UI and server

The product ships in Korean and English. Korean source text is the dictionary key, so a missing translation shows the
Korean original instead of a blank.

```tsx
<button title={tr('이 파일 열기')}>{tr('열기')}</button>          // one string
fill(tr('파일 {0}건을 지웠습니다.'), { 0: count })                 // a sentence with values
<T k={'<b>{0}건</b>이 남았습니다'} v={[count]} />                  // a sentence with bold text
```

- UI English goes to `apps/web/src/en.ts`; server English (linter findings, reports, API errors) goes to
  `packages/aas-core/src/i18n/en/*.ts`. Server code uses `tr()` / `fill()` from `@aas/core`; the language comes from
  each request (`Accept-Language`, `?lang=`).
- **Translate whole sentences.** Do not glue translated fragments together — English word order breaks.
- If a string is a value rather than text (a font name, a folder name fixed by a submission format), put
  `// i18n-ignore — <reason>` on the line above.

```bash
node scripts/i18n-scan.mjs --check          # UI
node scripts/i18n-server-scan.mjs --check   # server
```

### 7. Spacing uses tokens only

No pixel numbers for margin, padding, gap or position. Use the named tokens (`--space-pane`, `--space-stack`,
`--pad-card`, …) or multiples of `--spacing` on the standard scale; line height uses `--leading-tight|normal|relaxed`.

```bash
node scripts/spacing-scan.mjs --check
```

## Working with standards

- The AAS metamodel is **pinned to V3.0**. Do not mix in 3.1 — lossless round-trips break.
- The Part 2 REST API follows the specification files in `docs/spec/part2/` (OpenAPI);
  `node scripts/part2-coverage.mjs` reports any drift.
- Where the standard and the submission validator disagree, do not pick a side silently — expose it as a **policy**.

## Adding a dependency

Runtime dependencies must use a permissive license (MIT, Apache-2.0, BSD, ISC). GPL, LGPL and AGPL are not accepted —
people who use this program under Apache-2.0 could not meet their terms.

```bash
node scripts/make-third-party-notices.mjs      # exit code 1 if a copyleft license is found
```

## Before you push

- `bash scripts/ci.sh` passes.
- Commit messages are in **English** and say *why* before *what*.
- Security problems go through [SECURITY.md](SECURITY.md) first, not a public pull request.

## Releasing a version

When `PRODUCT_VERSION` goes up, the same release updates everything that describes the product — a release is not
done while any of these still shows the old version or misses what changed:

1. **Version strings** — `packages/aas-core/src/version.ts`, install guides (`docs/install.md` · `docs/설치.md`), the
   library URL in both READMEs, `docs/edge/examples/registration.json`; regenerate the sample bundle
   (`AAS_UPDATE_SAMPLES=1 npx vitest run apps/api/test/integration-bundle-build.test.ts`).
2. **What changed** — the "What's new" table in `README.md` / `README.ko.md` and the guide that covers the feature
   (usage, integration, edge contract), in English and Korean.
3. **Release** — tag `vX.Y.Z`, the seven library tarballs (`node scripts/pack-libraries.mjs --verify`) and
   `SHA256SUMS`. The remote collector is released from its own repository (waceinc/vexplor-edge, its own version and
   checklist); when it needs this release's libraries, release this one first. The site bundle pins `EDGE_VERSION` in
   `scripts/make-release.sh`.
4. **Website** — the product page on wace.me (Korean, English, Japanese) and the project page on the `gh-pages` branch
   (waceinc.github.io/vexplor-aas): version label, "What's new", release-notes link, and screenshots when the screens
   changed. Whoever bumps the version writes the What's new text, checked against the code. A daily check compares the latest release with the README and the website and reports a
   mismatch.

Contributions are distributed under this repository's [Apache License 2.0](LICENSE).
