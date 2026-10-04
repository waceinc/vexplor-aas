/**
 * 린터가 실제로 검사하는 규칙을 문서로 뽑는다 — docs/규칙_목록.md
 *
 *     npx tsc -b && node scripts/make-rule-list.mjs
 *     node scripts/make-rule-list.mjs --check     # 문서가 코드와 어긋나면 종료코드 1
 *
 * 🔴 **손으로 쓰지 않는다.** 규칙을 고치고 문서를 안 고치면 문서가 거짓말을 한다.
 *    지금 도는 코드에서 뽑으면 어긋날 자리가 없다(화면의 「규칙」 칸과 같은 출처다).
 *
 * 규칙을 **어떻게 알아냈는지**의 실측 자료(검증기 제출 기록·대조 스크립트)는 공개 저장소에
 * 싣지 않는다. 남의 저작물과 사업 자료가 섞여 있기 때문이다. 여기 나오는 것은
 * 「무엇을 검사하는가」이고, 그것으로 이 도구의 판정을 따져 볼 수 있다.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const { ALL_RULES } = await import('../packages/linter/dist/index.js');

const LAYERS = {
  L1: { name: 'L1 패키지', about: 'AASX 파일(OPC 패키지)의 구조 — 파트·관계·Content_Types' },
  L2: { name: 'L2 제약조건', about: 'AAS V3.0 메타모델의 제약조건(AASd-*, AASc-*)' },
  L3: { name: 'L3 KOSMO', about: '국내 제출처 검증기(KOSMO Validator)가 요구하는 사업 규칙' },
};

/** 내부 문서 이름은 공개 저장소에 없다 — 뜻이 통하는 말로 바꾼다 */
const publicSource = (source) =>
  source
    .replace(/0[1-5]_[^\s]+\.md/g, '내부 실측 문서')
    .replace(/\s+/g, ' ')
    .trim();

const lines = [
  '# 검사 규칙 목록',
  '',
  `이 도구의 린터가 검사하는 규칙 **${ALL_RULES.length}종**입니다. 화면의 **설정 → 규칙과 규약 보기**와 같은 내용입니다.`,
  '',
  '> 이 파일은 `node scripts/make-rule-list.mjs`가 **지금 도는 코드에서** 만듭니다. 손으로 고치지 마십시오.',
  '',
  '## 읽는 법',
  '',
  '| 층 | 무엇을 보나 |',
  '|---|---|',
  ...Object.values(LAYERS).map((layer) => `| **${layer.name}** | ${layer.about} |`),
  '',
  '표준 검증(aas-core · 공식 JSON 스키마)을 전부 통과해도 제출처 검증기는 떨어뜨릴 수 있습니다.',
  '그 차이를 메우는 것이 L3이고, 이 도구를 만든 이유입니다.',
  '',
  '🔴 **최종 합격 판정은 제출처의 검증기가 합니다.** 이 목록은 제출 전에 걸러 주는 사전 점검입니다.',
  '',
  '### 규칙이 서로 부딪히는 자리',
  '',
  '표준 규격과 제출처 검증기가 어긋나는 곳이 있습니다(예: `AASd-120` — 표준은 리스트 자식의',
  'idShort를 금지하지만 제출처 검증기는 검사하지 않습니다). 이 도구는 한쪽을 조용히 고르지 않고',
  '**정책**으로 드러냅니다 — [사용법 §10](사용법.md).',
  '',
];

for (const [key, layer] of Object.entries(LAYERS)) {
  const rules = ALL_RULES.filter((rule) => rule.layer === key);
  lines.push(`## ${layer.name} — ${rules.length}종`, '', '| 규칙 | 내용 | 근거 |', '|---|---|---|');
  for (const rule of rules) {
    lines.push(`| \`${rule.id}\` | ${rule.title.replace(/\|/g, '\\|')} | ${publicSource(rule.source).replace(/\|/g, '\\|')} |`);
  }
  lines.push('');
}

const text = `${lines.join('\n')}`;
const target = 'docs/규칙_목록.md';

if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(target, 'utf8').replace(/\r\n/g, '\n');
  } catch {
    /* 없으면 어긋난 것이다 */
  }
  if (current !== text) {
    console.error(`🔴 ${target}가 코드와 다릅니다 — node scripts/make-rule-list.mjs 로 다시 만드십시오.`);
    process.exit(1);
  }
  console.log(`✅ ${target} — 코드와 같습니다 (규칙 ${ALL_RULES.length}종)`);
} else {
  writeFileSync(target, text);
  console.log(`${target}를 썼습니다 — 규칙 ${ALL_RULES.length}종`);
}
