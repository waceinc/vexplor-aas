# 기여 안내

고쳐 주시려는 마음에 감사드립니다. 약속은 많지 않습니다.

## 시작하기

Node.js 22 이상이 필요합니다.

```bash
npm install
npx tsc -b              # 빌드
npx vitest run          # 시험
bash scripts/ci.sh      # CI와 같은 순서 — 올리기 전에 한 번
```

🔴 `npx tsc -b`와 `npx vitest run`을 **동시에 돌리지 마십시오.** 같은 파일을 잡아 서로 막힙니다.

화면을 보며 고칠 때는 창 두 개로 띄웁니다.

```bash
npm run dev:api     # API 8080
npm run dev:web     # 화면 5173
```

## 약속 다섯 가지

### 1. 시험이 결함을 **실제로 잡는지** 확인합니다

결함을 고쳤다면, 고치기 전 코드에서 그 시험이 **떨어지는지** 한 번 봐 주십시오.
고쳐도 안 고쳐도 통과하는 시험은 없는 것만 못합니다 — 지켜 주고 있다고 믿게 만들기 때문입니다.

### 2. 저장소 구현 셋은 **같은 시험**을 통과합니다

`packages/store`에는 메모리 · 폴더 · PostgreSQL 구현이 있고, 셋 다
`packages/store/test/conformance.ts`를 통과해야 합니다. 저장소에 동작을 더하면 여기에 시험을 더해 주십시오.
DB 표를 바꾸면 `schema.ts`의 `SCHEMA_SQL`(최신 완성형)과 `MIGRATIONS`(옛 DB를 올리는 문장)를 **함께** 고칩니다.

### 3. 규칙을 고치면 문서를 다시 만듭니다

```bash
npx tsc -b && node scripts/make-rule-list.mjs      # docs/규칙_목록.md
```

`docs/규칙_목록.md`와 `THIRD-PARTY-NOTICES.md`는 코드에서 뽑아내는 파일입니다. 손으로 고치지 마십시오.
CI가 코드와 어긋났는지 확인합니다.

### 4. 시험 파일에 **실제 설비 자료를 넣지 않습니다**

`tests/fixtures/`의 AASX에는 꾸민 이름만 씁니다. 실제 제조사 · 모델 · 연락처가 들어가면 안 됩니다.

```bash
python scripts/scan-fixture-names.py tests/fixtures     # 찾으면 종료코드 1
```

### 5. 주석에는 **왜**를 적습니다

코드가 무엇을 하는지는 코드가 말합니다. 주석에는 왜 그렇게 했는지, 무엇을 하면 안 되는지를 적어 주십시오.
이 저장소의 주석은 한국어입니다. 🔴 표시는 "여기를 건드리면 조용히 깨진다"는 뜻입니다.

주석에 가끔 `PROGRESS §4`나 `docs/rules/…` 같은 말이 나옵니다. 공개하지 않은 내부 개발 기록을
가리키는 것이고, 찾을 수 없는 것이 정상입니다. 뜻은 그 주석 안에 다 적혀 있습니다.

## 표준을 다루는 자리

- AAS 메타모델은 **V3.0에 고정**돼 있습니다. 3.1의 것을 섞지 말아 주십시오 — 무손실 왕복이 깨집니다
- Part 2 REST API는 `docs/spec/part2/`의 규격 원문(OpenAPI)이 기준입니다.
  `node scripts/part2-coverage.mjs`가 어긋남을 잡습니다
- 표준과 제출처 검증기가 부딪히는 자리는 한쪽을 고르지 말고 **정책**으로 드러내 주십시오

## 화면에 글자를 더할 때

화면(`apps/web`)의 한국어는 전부 번역기를 거칩니다. 한국어 문장 자체가 사전의 열쇠입니다.

```tsx
<button title={tr('이 파일 열기')}>{tr('열기')}</button>          // 글자 하나
fill(tr('파일 {0}건을 지웠습니다.'), { 0: count })                 // 숫자·이름이 끼는 문장
<T k={'<b>{0}건</b>이 남았습니다'} v={[count]} />                  // 굵은 글씨가 끼는 문장
```

- 영어 번역은 `apps/web/src/en.ts`에 넣습니다. **문장을 토막 내 이어 붙이지 마십시오** — 영어 어순이 무너집니다
- 글자가 아니라 값(파일 이름·글꼴 이름)이면 그 줄 위에 `// i18n-ignore`를 적습니다
- 빠뜨리면 CI가 멈춥니다

```bash
node scripts/i18n-scan.mjs --check     # 번역기를 안 거친 한국어 · 사전에 없는 열쇠 · {0}·<b> 표시가 다른 번역
```

서버가 만드는 글(린터의 지적 문구·규칙 설명·검증 결과서)은 아직 한국어뿐입니다.

## 의존성을 더할 때

실행에 딸려 가는 의존성은 허용형 라이선스(MIT · Apache-2.0 · BSD · ISC)만 받습니다.
GPL · LGPL · AGPL은 받지 않습니다 — 이 프로그램을 Apache-2.0으로 받아 쓰는 사람이 조건을 지킬 수 없게 됩니다.

```bash
node scripts/make-third-party-notices.mjs      # 카피레프트가 있으면 종료코드 1
```

## 올리기 전에

- `bash scripts/ci.sh`가 통과합니다
- 바꾼 이유를 커밋 글에 적었습니다 — 무엇을 바꿨는지보다 **왜**가 먼저입니다
- 보안 문제라면 공개 PR이 아니라 [SECURITY.md](SECURITY.md)의 길로 먼저 알려 주십시오

기여하신 코드는 이 저장소의 [Apache License 2.0](LICENSE)으로 배포됩니다.
