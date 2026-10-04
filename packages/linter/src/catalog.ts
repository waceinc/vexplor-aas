/**
 * 규칙·규약 카탈로그 — **"무슨 근거로 통과라고 하는가"에 답하는 자료.**
 *
 * 왜 필요한가: 검수자·발주처가 판정 근거를 묻는다. 문서에만 적혀 있으면
 * 실제로 도는 규칙과 어긋날 수 있다 — **도는 코드에서 직접 뽑아** 보여 준다.
 *
 * 🔴 판정 주체를 흐리지 않는다. 우리 린터는 **제출 전에 걸러 주는 것**이고,
 *    합격 판정은 KOSMO Validator와 `aas-test-engines`가 한다. 그 사실을 함께 싣는다.
 */
import { FIXERS } from './fix/index.js';
import { DEFAULT_POLICY, type LinterPolicy } from './policy.js';
import { policySources } from './policy-file.js';
import { ALL_RULES } from './rules/index.js';
import type { Layer } from './types.js';

export interface RuleInfo {
  id: string;
  layer: Layer;
  title: string;
  /** 근거 문서 */
  source: string;
  /** 「고치기」가 자동으로 처리할 수 있는가 */
  fixable: boolean;
}

export interface LayerInfo {
  layer: Layer;
  title: string;
  meaning: string;
  count: number;
}

/** 규정 충돌 — 한쪽을 조용히 고르지 않고 정책으로 드러낸다 */
export interface ConflictInfo {
  key: keyof LinterPolicy;
  title: string;
  /** 무엇과 무엇이 부딪히는가 */
  conflict: string;
  choices: { value: string; meaning: string }[];
  current: string;
}

export interface RuleCatalog {
  rules: RuleInfo[];
  /** 각 규약 값이 기본값인지 정책 파일에서 온 것인지 */
  sources: { key: string; from: string }[];
  layers: LayerInfo[];
  conflicts: ConflictInfo[];
  /** id를 지을 때 쓰는 규약 */
  conventions: { key: string; title: string; value: string; source: string }[];
  /** 합격 판정을 누가 하는지 */
  verdict: { who: string; role: string }[];
}

const LAYER_MEANING: Record<Layer, { title: string; meaning: string }> = {
  L1: {
    title: 'L1 — 패키지·직렬화',
    meaning: 'AASX 파일 자체가 규격대로 만들어졌는가 (공식 JSON 스키마·OPC 패키징)',
  },
  L2: {
    title: 'L2 — 메타모델 제약(AASd·AASc)',
    meaning: 'AAS V3.0 규격이 정한 제약. 표준 도구(aas-test-engines·BaSyx)가 강제한다',
  },
  L3: {
    title: 'L3 — KOSMO 사업 규칙',
    meaning: '제출처(KOSMO)가 요구하는 것. 실측(설비 20종 × Validator 4회)으로 확정했다',
  },
};

export function ruleCatalog(policy: Partial<LinterPolicy> = {}): RuleCatalog {
  const merged = { ...DEFAULT_POLICY, ...policy };
  const rules: RuleInfo[] = ALL_RULES.map((rule) => ({
    id: rule.id,
    layer: rule.layer,
    title: rule.title,
    source: rule.source,
    fixable: rule.id in FIXERS,
  }));

  const layers: LayerInfo[] = (['L1', 'L2', 'L3'] as Layer[]).map((layer) => ({
    layer,
    ...LAYER_MEANING[layer],
    count: rules.filter((rule) => rule.layer === layer).length,
  }));

  const conflicts: ConflictInfo[] = [
    {
      key: 'iriConflict',
      title: '① IDTA 공식 IRI',
      conflict: 'KTL §4는 IDTA 공식 IRI 보존을 요구하고, KOSMO는 admin-shell.io IRI를 거부한다',
      choices: [
        { value: 'kosmo-first', meaning: '허용 목록 밖 IRI는 위반 (KOSMO 제출 우선)' },
        { value: 'idta-preserve', meaning: 'IDTA 공식 IRI는 통과, 경고로만 표시' },
      ],
      current: merged.iriConflict,
    },
    {
      key: 'cdDefinition',
      title: '② 개념정의의 영문 definition',
      conflict: 'KTL §8은 정의가 없으면 공란 유지, KOSMO-CD-3은 영문 definition 필수',
      choices: [
        { value: 'require-en', meaning: '영문 정의가 없으면 위반' },
        { value: 'allow-empty', meaning: '공란 허용, 참고로만 남긴다' },
      ],
      current: merged.cdDefinition,
    },
    {
      key: 'langTagTypo',
      title: '③ 언어태그 오타',
      conflict: 'KTL §7은 IDTA 템플릿 오류도 원본 유지, 그러나 오타는 AASd 위반을 부른다',
      choices: [
        { value: 'fix-when-evidence', meaning: '중복 언어태그를 위반으로 보고 교정한다' },
        { value: 'preserve', meaning: '경고로만 표시한다' },
      ],
      current: merged.langTagTypo,
    },
    {
      key: 'smlChildIdShort',
      title: '④ 리스트 자식의 idShort (AASd-120)',
      conflict:
        'KOSMO Validator는 검사하지 않지만, aas-test-engines는 오류로 떨어뜨리고 basyx는 그 가지를 잃는다',
      choices: [
        { value: 'warn', meaning: '경고 — 제출은 막지 않되 상호운용이 깨진다고 알린다' },
        { value: 'forbid', meaning: '위반 — 표준 도구 통과가 목표인 배포' },
        { value: 'allow', meaning: '참고 — 알고도 두겠다는 선택' },
      ],
      current: merged.smlChildIdShort,
    },
    {
      key: 'standardTemplateSemantics',
      title: '⑤ 표준 템플릿의 용어 (AID 등)',
      conflict:
        'IDTA 공식 템플릿에는 ConceptDescription이 딸려 오지 않아 KOSMO-SME-3이 요소 수만큼 걸린다. 「고치기」로 없앨 수 있지만 표준 용어가 자체 IRI로 덮인다',
      choices: [
        { value: 'kosmo-first', meaning: '위반으로 본다 (KOSMO 제출 우선)' },
        { value: 'preserve', meaning: '표준 용어를 지키고 참고로만 남긴다 (KTL §7·상호운용)' },
      ],
      current: merged.standardTemplateSemantics,
    },
  ];

  const conventions = [
    {
      key: 'iriBase',
      title: '자체 IRI 뿌리',
      value: merged.iriBase,
      source: 'KOSMO 허용 접두 (02_Validator_대응규칙 §110)',
    },
    {
      key: 'irdiPrefixes',
      title: '표준 사전 IRDI 접두',
      value: merged.irdiPrefixes.join(' · ') + '  (eCl@ss · IEC CDD)',
      source: 'KOSMO가 인정하는 표준 사전',
    },
    {
      key: 'requiredSubmodels',
      title: '필수 서브모델',
      value: merged.requiredSubmodels.join(' · '),
      source: 'KOSMO-AAS-4',
    },
    {
      key: 'submodelCountRange',
      title: '서브모델 개수',
      value: `${merged.submodelCountRange[0]}종 이상 ${merged.submodelCountRange[1]}종 이하`,
      source: 'KOSMO-AAS-4', // 개수 범위도 AAS-4 한 규칙 안에 있다 — AAS-7은 존재하지 않는 번호였다(2026-09-04 정정)
    },
    {
      key: 'aasId',
      title: 'AAS id 짓는 법',
      value: `${merged.iriBase}/aas/{장비명}/{version}/{revision}`,
      source: '03_AASX_생성규약',
    },
    {
      key: 'submodelId',
      title: '서브모델 id 짓는 법',
      value: `${merged.iriBase}/sm/{장비명}/{서브모델명}/{version}/{revision}`,
      source: 'KOSMO-SM-2 (id 접미와 administration 일치)',
    },
    {
      key: 'assetKind',
      title: '자산 종류',
      value: 'Type (형식) — 본 사업 산출물은 개별 장비가 아니라 형식이다',
      source: 'KOSMO-AAS-6',
    },
    {
      key: 'valueSync',
      title: '값 동기화',
      value: 'A안 — 파일(AASX)이 원본. 수집값은 시계열에만 쌓이고 모델로 되쓰지 않는다',
      source: 'docs/PROGRESS.md §2-2',
    },
  ];

  const verdict = [
    {
      who: 'KOSMO Validator',
      role: '🔴 합격 판정 주체. 오류 0건이어야 제출할 수 있다',
    },
    {
      who: 'aas-test-engines',
      role: '🔴 합격 판정 주체(표준). KOSMO와 판정이 다를 수 있다 — AASd-120이 그 예다',
    },
    {
      who: '이 도구의 린터',
      role: '제출 전에 미리 걸러 주는 것. 위 둘을 대신하지 않는다',
    },
    {
      who: 'AASX Package Explorer',
      role: '뷰어 전용. V2 스키마 오탐이 있어 검증에 쓰지 않는다',
    },
    {
      who: 'BaSyx',
      role: '적재·상호운용 시연 도구. 검증 도구가 아니다',
    },
  ];

  return { rules, layers, conflicts, conventions, verdict, sources: policySources(policy) };
}
