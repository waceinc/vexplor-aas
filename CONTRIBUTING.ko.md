[English](CONTRIBUTING.md) · **한국어**

# 기여 안내

고쳐 주시려는 마음에 감사드립니다. 지켜 주실 약속은 많지 않습니다.

## 시작하기

Node.js 24 LTS를 권장합니다(22 이상이면 동작 — 24.22.1 · 22.23.4 이상, `.nvmrc`는 24).

```bash
npm ci
npx tsc -b              # 빌드
npx vitest run          # 시험
bash scripts/ci.sh      # CI와 같은 10단계 — 올리기 전에 한 번
```

`npx tsc -b`와 `npx vitest run`을 **동시에 돌리지 마십시오.** 둘이 같은 파일을 잡고 서로를 막습니다.

화면을 보며 고칠 때는 창 두 개로 띄웁니다.

```bash
npm run dev:api     # API 8080
npm run dev:web     # 화면 5173
```

## 약속 일곱 가지

### 1. 시험이 결함을 **실제로 잡는지** 확인합니다

결함을 고쳤다면, 고치기 전 코드에서 그 시험이 **떨어지는지** 한 번 봐 주십시오.
고쳐도 안 고쳐도 통과하는 시험은 없는 것만 못합니다 — 결함을 막고 있다고 착각하게 하기 때문입니다.

### 2. 저장소 구현 셋은 **같은 시험**을 통과합니다

`packages/store`에는 메모리 · 폴더 · PostgreSQL 구현이 있고, 셋 다
`packages/store/test/conformance.ts`를 통과해야 합니다. 저장소에 동작을 더하면 여기에 시험을 더해 주십시오.
DB 표를 바꾸면 `schema.ts`의 `SCHEMA_SQL`(최신 완성형)과 `MIGRATIONS`(옛 DB를 올리는 문장)를 **함께** 고칩니다.

### 3. 규칙을 고치면 문서를 다시 만듭니다

```bash
npx tsc -b && node scripts/make-rule-list.mjs      # docs/rules.md(영어) · docs/규칙_목록.md(한국어)
```

`docs/rules.md` · `docs/규칙_목록.md` · `THIRD-PARTY-NOTICES.md`는 코드에서 생성하는 파일입니다. 손으로 고치지 마십시오.
CI가 코드와 어긋났는지 확인합니다.

### 4. 시험 파일에 **실제 설비 자료를 넣지 않습니다**

`tests/fixtures/`의 AASX에는 꾸민 이름만 사용합니다. 실제 제조사 · 모델 · 연락처가 들어가면 안 됩니다.

```bash
python scripts/scan-fixture-names.py tests/fixtures     # 찾으면 종료코드 1
```

### 5. 주석에는 **왜**를 영어로 적습니다

코드가 무엇을 하는지는 코드가 말합니다. 주석에는 왜 그렇게 했는지, 무엇을 하면 안 되는지를 적어 주십시오.
주석은 영어로 적습니다(2026-10-14부터). `Important:` 표시는 "여기를 건드리면 조용히 깨진다"는 뜻입니다.

주석에 가끔 `PROGRESS §4`나 `docs/rules/…` 같은 말이 나옵니다. 공개하지 않은 내부 개발 기록을
가리키는 것이고, 찾을 수 없는 것이 정상입니다. 뜻은 그 주석 안에 다 적혀 있습니다.

### 6. 사람이 읽는 문장은 모두 번역기를 거칩니다 — 화면도 서버도

이 프로그램은 한국어와 영어 두 언어로 나옵니다. 한국어 문장이 그대로 사전의 키라서, 번역이 빠지면 빈칸이 아니라 한국어 원문이 보입니다.

```tsx
<button title={tr('이 파일 열기')}>{tr('열기')}</button>          // 글자 하나
fill(tr('파일 {0}건을 지웠습니다.'), { 0: count })                 // 숫자·이름이 끼는 문장
<T k={'<b>{0}건</b>이 남았습니다'} v={[count]} />                  // 굵은 글씨가 끼는 문장
```

- 화면 영어는 `apps/web/src/en.ts`, 서버 영어(지적 문구 · 결과서 · API 오류)는 `packages/aas-core/src/i18n/en/*.ts`에 넣습니다. 서버 코드는 `@aas/core`의 `tr()` / `fill()`을 쓰고, 언어는 요청마다(`Accept-Language`, `?lang=`) 정해집니다
- **문장을 토막 내 연결하지 마십시오** — 영어 어순이 무너집니다
- 글자가 아니라 값(글꼴 이름 · 제출 구조가 정한 폴더 이름)이면 그 줄 위에 `// i18n-ignore — 까닭`을 적습니다
- 빠뜨리면 CI가 멈춥니다

```bash
node scripts/i18n-scan.mjs --check          # 화면
node scripts/i18n-server-scan.mjs --check   # 서버
```

### 7. 간격은 토큰으로만 적습니다

margin · padding · gap · 위치에 픽셀 숫자를 쓰지 않습니다. 이름 붙은 토큰(`--space-pane` · `--space-stack` · `--pad-card` …)이나
표준 단계의 `--spacing` 배수를 쓰고, 줄 간격은 `--leading-tight|normal|relaxed`만 사용합니다.

```bash
node scripts/spacing-scan.mjs --check
```

## 표준을 다룰 때

- 메모리 안 모델은 **V3.0 · V3.1 · V3.2** 를 모두 담습니다(3.2 까지의 상위 집합). 버전 차이는 표 하나
  `packages/aas-core/src/metamodel/features.ts` 에 있고 읽기 · 쓰기 · 검사가 모두 이 표를 씁니다 — 베껴 쓰지 마십시오
- 패키지는 들어온 버전을 기억합니다. **서버 밖으로 나가는 파일**(내려받기 · Part 2 AASX 직렬화 · 레퍼런스 번들)은
  `writeAasxWithReport` 로 그 버전이나 고른 버전으로 쓰고, **내부 왕복**(검사용 재포장 · 같은지 비교)은 버전 없는 `writeAasx`
  를 그대로 씁니다 — 내부 왕복은 칸 하나도 잃으면 안 됩니다
- Part 2 REST API는 `docs/spec/part2/`의 규격 원문(OpenAPI)이 기준입니다.
  `node scripts/part2-coverage.mjs`가 어긋남을 잡습니다
- 표준과 제출처 검증기가 어긋나는 곳은 한쪽을 고르지 말고 **정책**으로 드러내 주십시오

## 의존성을 더할 때

실행할 때 필요한 의존성은 허용형 라이선스(MIT · Apache-2.0 · BSD · ISC)만 받습니다.
GPL · LGPL · AGPL은 받지 않습니다 — 이 프로그램을 Apache-2.0으로 가져다 쓰는 사람이 조건을 지킬 수 없게 됩니다.

```bash
node scripts/make-third-party-notices.mjs      # 카피레프트가 있으면 종료코드 1
```

## 올리기 전에

- `bash scripts/ci.sh`가 통과합니다
- 커밋 글은 **영어**로 적고, 무엇을 바꿨는지보다 **왜**를 먼저 적습니다
- 보안 문제라면 공개 PR이 아니라 [SECURITY.ko.md](SECURITY.ko.md)에 적힌 방법으로 먼저 알려 주십시오

## 버전을 올릴 때

`PRODUCT_VERSION` 이 오르면 같은 릴리스에서 제품을 설명하는 곳을 모두 고칩니다. 아래 항목 가운데 하나라도 옛 버전이 남아 있거나
바뀐 내용이 빠져 있으면 릴리스가 끝난 것이 아닙니다.

1. **버전 표기** — `packages/aas-core/src/version.ts`, 설치 안내(`docs/install.md` · `docs/설치.md`), 두 README 의 라이브러리
   주소, `docs/edge/examples/registration.json` 과 waceinc/vexplor-edge 의 같은 파일 `docs/examples/registration.json`
   (규격 정본 — 그쪽 상호 시험이 두 파일을 바이트로 대조합니다). 견본 묶음을 다시 만듭니다
   (`AAS_UPDATE_SAMPLES=1 npx vitest run apps/api/test/integration-bundle-build.test.ts`).
2. **바뀐 내용** — `README.md` / `README.ko.md` 의 「새로 생긴 것」 표와 그 기능을 다루는 안내(사용법 · 연동 · 엣지 계약), 영어와 한국어 모두.
3. **릴리스** — 태그 `vX.Y.Z`, 라이브러리 패키지 7개(`node scripts/pack-libraries.mjs --verify`), `SHA256SUMS`. 원격 수집기는
   자기 저장소(waceinc/vexplor-edge, 자기 버전 · 자기 점검표)에서 나옵니다. 수집기가 이번 버전 라이브러리를 쓰면 이 릴리스를 먼저 냅니다.
   현장 설치 묶음은 `scripts/make-release.sh` 의 `EDGE_VERSION` 으로 수집기 버전을 고정합니다.
   **병합된 것에만 태그를 붙입니다.** 릴리스 PR 을 병합한 뒤 상태를 다시 읽어(`gh pr view <n> --json state` 가 `MERGED`)
   `main` 의 트리가 패키지를 만든 트리와 같은지(`git rev-parse origin/main^{tree}` 와 릴리스 브랜치 비교) 확인합니다. 병합 명령은
   조용히 실패할 수 있고, 엉뚱한 커밋에 붙은 태그와 다른 커밋에서 만든 패키지는 자기 소스와 맞지 않는 릴리스가 됩니다.
4. **홈페이지** — wace.me 제품 페이지(한국어 · 영어 · 일본어)와 `gh-pages` 의 공식 프로젝트 페이지(waceinc.github.io/vexplor-aas)의
   버전 표기 · 새 기능 · 릴리스 노트 링크 · 화면이 바뀌었으면 캡처. 새 기능 문장은 버전을 올리는 사람이 코드로 확인해 직접 씁니다. 매일 점검이 최신
   릴리스와 README · 홈페이지 버전을 대조해 다르면 알립니다.
   검색 엔진과 AI 답변이 읽는 곳이 wace.me 에 두 군데 더 있습니다 — 제품 페이지 구조화 데이터의 `softwareVersion` 과 `/opensource` 프로젝트 카드의 버전.
   둘 다 `wace-home/scripts/oss_seo.py` 의 `VERSIONS` 에서 만들어집니다(명령 4개는 사이트 저장소 README). 배포 전에 두 번 실행해
   두 번째 실행에서 바뀌는 것이 없는지 보고, 배포 뒤 바뀐 주소를 IndexNow 로 알립니다.

기여하신 코드는 이 저장소의 [Apache License 2.0](LICENSE)으로 배포됩니다.
