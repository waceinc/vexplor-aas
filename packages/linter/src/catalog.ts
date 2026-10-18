/**
 * Rule and convention catalog — **data that answers "on what basis do we call this a pass".**
 *
 * Why it is needed: reviewers and clients ask for the basis of judgments. If it is only written in documents,
 * it can drift from the rules that actually run — so it is **extracted directly from the running code** and shown.
 *
 * Important: do not blur who makes the judgment. Our linter **filters before submission**;
 *    the pass/fail judgment is made by the KOSMO Validator and `aas-test-engines`. That fact is included too.
 */
import { FIXERS } from './fix/index.js';
import { DEFAULT_POLICY, type LinterPolicy } from './policy.js';
import { policySources } from './policy-file.js';
import { ALL_RULES } from './rules/index.js';
import type { Layer } from './types.js';
import { fill, tr } from '@aas/core';

export interface RuleInfo {
  id: string;
  layer: Layer;
  title: string;
  /** Source document */
  source: string;
  /** Whether "Fix" can handle it automatically */
  fixable: boolean;
}

export interface LayerInfo {
  layer: Layer;
  title: string;
  meaning: string;
  count: number;
}

/** Regulation conflict — surfaced as a policy instead of silently picking one side */
export interface ConflictInfo {
  key: keyof LinterPolicy;
  title: string;
  /** What conflicts with what */
  conflict: string;
  choices: { value: string; meaning: string }[];
  current: string;
}

export interface RuleCatalog {
  rules: RuleInfo[];
  /** Whether each convention value is a default or comes from the policy file */
  sources: { key: string; from: string }[];
  layers: LayerInfo[];
  conflicts: ConflictInfo[];
  /** Conventions used when naming ids */
  conventions: { key: string; title: string; value: string; source: string }[];
  /** Who makes the pass/fail judgment */
  verdict: { who: string; role: string }[];
}

/** Layer descriptions — language differs per request, so built at call time (not fixed when the module loads) */
const layerMeaning = (): Record<Layer, { title: string; meaning: string }> => ({
  L1: {
    title: tr('L1 — 패키지·직렬화'),
    meaning: tr('AASX 파일 자체가 규격대로 만들어졌는가 (공식 JSON 스키마·OPC 패키징)'),
  },
  L2: {
    title: tr('L2 — 메타모델 제약(AASd·AASc)'),
    meaning: tr('AAS V3.0 규격이 정한 제약. 표준 도구(aas-test-engines·BaSyx)가 강제한다'),
  },
  L3: {
    title: tr('L3 — KOSMO 사업 규칙'),
    meaning: tr('KOSMO가 요구하는 것. 실측(설비 20종 × Validator 4회)으로 확정했다'),
  },
});

/**
 * Internal document names cited as rule sources — the rules keep the file names as-is (i18n-ignore) and translate
 * them **only when displayed**. Renaming the files would break the path to the source, so the original values
 * are left untouched.
 */
const SOURCE_DOCUMENTS = [
  '02_Validator_대응규칙.md', // i18n-ignore — source document file name (translated with tr below)
  '04_린터_규칙_명세.md', // i18n-ignore — source document file name (translated with tr below)
  'AAS 참조모델 제약조건 spec_260812.pdf', // i18n-ignore — source document file name (translated with tr below)
] as const;

function sourceText(source: string): string {
  let text = source;
  for (const document of SOURCE_DOCUMENTS) text = text.split(document).join(tr(document));
  return text;
}

export function ruleCatalog(policy: Partial<LinterPolicy> = {}): RuleCatalog {
  const merged = { ...DEFAULT_POLICY, ...policy };
  const rules: RuleInfo[] = ALL_RULES.map((rule) => ({
    id: rule.id,
    layer: rule.layer,
    title: rule.title,
    source: sourceText(rule.source),
    fixable: rule.id in FIXERS,
  }));

  const meanings = layerMeaning();
  const layers: LayerInfo[] = (['L1', 'L2', 'L3'] as Layer[]).map((layer) => ({
    layer,
    ...meanings[layer],
    count: rules.filter((rule) => rule.layer === layer).length,
  }));

  const conflicts: ConflictInfo[] = [
    {
      key: 'iriConflict',
      title: tr('① IDTA 공식 IRI'),
      conflict: tr('KTL §4는 IDTA 공식 IRI 보존을 요구하고, KOSMO는 admin-shell.io IRI를 거부한다'),
      choices: [
        { value: 'kosmo-first', meaning: tr('허용 목록 밖 IRI는 위반 (KOSMO 우선)') },
        { value: 'idta-preserve', meaning: tr('IDTA 공식 IRI는 통과, 경고로만 표시') },
      ],
      current: merged.iriConflict,
    },
    {
      key: 'cdDefinition',
      title: tr('② 개념정의의 영문 definition'),
      conflict: tr('KTL §8은 정의가 없으면 공란 유지, KOSMO-CD-3은 영문 definition 필수'),
      choices: [
        { value: 'require-en', meaning: tr('영문 정의가 없으면 위반') },
        { value: 'allow-empty', meaning: tr('공란 허용, 참고로만 남긴다') },
      ],
      current: merged.cdDefinition,
    },
    {
      key: 'langTagTypo',
      title: tr('③ 언어태그 오타'),
      conflict: tr('KTL §7은 IDTA 템플릿 오류도 원본 유지, 그러나 오타는 AASd 위반을 부른다'),
      choices: [
        { value: 'fix-when-evidence', meaning: tr('중복 언어태그를 위반으로 보고 교정한다') },
        { value: 'preserve', meaning: tr('경고로만 표시한다') },
      ],
      current: merged.langTagTypo,
    },
    {
      key: 'smlChildIdShort',
      title: tr('④ 리스트 자식의 idShort (AASd-120)'),
      conflict:
        tr('KOSMO Validator는 검사하지 않지만, aas-test-engines는 오류로 떨어뜨리고 basyx는 그 가지를 잃는다'),
      choices: [
        { value: 'warn', meaning: tr('경고 — 상호운용이 깨진다고 알린다') },
        { value: 'forbid', meaning: tr('위반 — 표준 도구 통과가 목표인 배포') },
        { value: 'allow', meaning: tr('참고 — 알고도 두겠다는 선택') },
      ],
      current: merged.smlChildIdShort,
    },
    {
      key: 'standardTemplateSemantics',
      title: tr('⑤ 표준 템플릿의 용어 (AID 등)'),
      conflict:
        tr('IDTA 공식 템플릿에는 ConceptDescription이 딸려 오지 않아 KOSMO-SME-3이 요소 수만큼 걸린다. 「고치기」로 없앨 수 있지만 표준 용어가 자체 IRI로 덮인다'),
      choices: [
        { value: 'kosmo-first', meaning: tr('위반으로 본다 (KOSMO 우선)') },
        { value: 'preserve', meaning: tr('표준 용어를 지키고 참고로만 남긴다 (KTL §7·상호운용)') },
      ],
      current: merged.standardTemplateSemantics,
    },
  ];

  const conventions = [
    {
      key: 'iriBase',
      title: tr('자체 IRI 뿌리'),
      value: merged.iriBase,
      source: tr('KOSMO 허용 접두 (02_Validator_대응규칙 §110)'),
    },
    {
      key: 'irdiPrefixes',
      title: tr('표준 사전 IRDI 접두'),
      value: merged.irdiPrefixes.join(' · ') + '  (eCl@ss · IEC CDD)',
      source: tr('KOSMO가 인정하는 표준 사전'),
    },
    {
      key: 'requiredSubmodels',
      title: tr('필수 서브모델'),
      value: merged.requiredSubmodels.join(' · '),
      source: 'KOSMO-AAS-4',
    },
    {
      key: 'submodelCountRange',
      title: tr('서브모델 개수'),
      value: fill(tr('{0}종 이상 {1}종 이하'), { 0: merged.submodelCountRange[0], 1: merged.submodelCountRange[1] }),
      source: 'KOSMO-AAS-4', // The count range is also within the single rule AAS-4 — AAS-7 was a nonexistent number (corrected 2026-09-04)
    },
    {
      key: 'aasId',
      title: tr('AAS id 짓는 법'),
      value: `${merged.iriBase}/aas/{${tr('장비명')}}/{version}/{revision}`,
      source: tr('03_AASX_생성규약'),
    },
    {
      key: 'submodelId',
      title: tr('서브모델 id 짓는 법'),
      value: `${merged.iriBase}/sm/{${tr('장비명')}}/{${tr('서브모델명')}}/{version}/{revision}`,
      source: tr('KOSMO-SM-2 (id 접미와 administration 일치)'),
    },
    {
      key: 'assetKind',
      title: tr('자산 종류'),
      value: tr('Type (형식) — 본 사업 산출물은 개별 장비가 아니라 형식이다'),
      source: 'KOSMO-AAS-6',
    },
    {
      key: 'valueSync',
      title: tr('값 동기화'),
      value: tr('A안 — 파일(AASX)이 원본. 수집값은 시계열에만 쌓이고 모델로 되쓰지 않는다'),
      source: 'docs/PROGRESS.md §2-2',
    },
  ];

  const verdict = [
    {
      who: 'KOSMO Validator',
      role: tr('공식 판정 주체. 오류 0건이 기준이다'),
    },
    {
      who: 'aas-test-engines',
      role: tr('합격 판정 주체(표준). KOSMO와 판정이 다를 수 있다 — AASd-120이 그 예다'),
    },
    {
      who: tr('이 도구의 린터'),
      role: tr('미리 걸러 주는 사전 점검. 위 둘을 대신하지 않는다'),
    },
    {
      who: 'AASX Package Explorer',
      role: tr('뷰어 전용. V2 스키마 오탐이 있어 검증에 쓰지 않는다'),
    },
    {
      who: 'BaSyx',
      role: tr('적재·상호운용 시연 도구. 검증 도구가 아니다'),
    },
  ];

  return { rules, layers, conflicts, conventions, verdict, sources: policySources(policy) };
}
