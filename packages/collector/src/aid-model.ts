/**
 * AID 태그가 **얹힐 자리**를 모델에 세운다 — 수집 연결의 나머지 절반.
 *
 * 왜 필요한가: AID를 만들면 수집은 된다. 그런데 값이 표준 API(`?live=true`)나
 * OPC UA 노출(M6·M7)로 나가려면 **모델 안에 같은 idShort의 요소가 있어야 한다**.
 * 지금까지는 없으면 `nameMisses`로 경고만 하고 끝이었다 — 사용자가 트리에서 손으로
 * Property를 하나씩 만들어야 했다. 태그가 수십 개면 그게 곧 포기다.
 *
 * 🔴 자리는 **KTL 규칙**을 따른다: `OperationalData[SM] > 대분류[SMC] > 소분류[SMC] > [Prop]`
 *    (docs/rules/01_KTL_모델링_규칙.md §2-2). 골든 파일도 정확히 이 모양이다 —
 *    `ProcessMonitoring > FormingParameter > CurrentLineSpeed`. 평평하게 만들면 규칙을 깬다.
 * 🔴 semanticId는 **ModelReference + ConceptDescription 키**다. 골든 파일 실측이 그렇고,
 *    키 타입이 틀리면 basyx가 서브모델을 통째로 드롭한다(CLAUDE.md 6가지 §3).
 *    AID 용어 쪽(ExternalReference/GlobalReference)과 **다르다** — 헷갈리지 말 것.
 * 🔴 **이미 있는 것은 건드리지 않는다.** 값이 들어 있을 수 있고, 사람이 손댄 것일 수 있다.
 */
import type { AidTagInput } from './aid-build.js';

const IEC61360 =
  'https://admin-shell.io/DataSpecificationTemplates/DataSpecificationIec61360/3/0';

/** AID의 WoT 타입 → AAS xs 자료형 */
export function runtimeValueType(type: string | undefined): string {
  switch (type) {
    case 'integer':
      return 'xs:int';
    case 'boolean':
      return 'xs:boolean';
    case 'string':
      return 'xs:string';
    // 🔴 기본은 xs:double이다. AID 폼의 기본 타입이 float이고,
    //    수집되는 것 대부분이 측정값이라 문자열로 떨어뜨리면 나중에 다 고쳐야 한다
    default:
      return 'xs:double';
  }
}

/**
 * xs 자료형 → IEC61360 dataType (KOSMO-SME-5).
 * 🔴 STRING으로 통일하면 숫자 항목이 전부 위반이 된다 — 만든 순간 린터에 걸린다(실측).
 *    허용표는 `@aas/linter`의 XS_TO_DATA_TYPE이고, 그중 첫 값을 쓴다.
 */
const IEC_DATA_TYPE: Record<string, string> = {
  'xs:double': 'REAL_MEASURE',
  'xs:int': 'INTEGER_COUNT',
  'xs:boolean': 'BOOLEAN',
  'xs:string': 'STRING',
};

/**
 * 🔴 `*_MEASURE`는 **단위가 있어야 한다**(AASc-3a-009). 「12.5」가 kW인지 A인지 모르면
 *    남이 쓸 수 없는 값이라 규격이 강제한다.
 *
 *    단위를 모르는데 MEASURE라고 적으면 **만든 순간 위반 3건이 뜬다**(실측).
 *    그렇다고 단위를 지어내면 더 나쁘다 — 틀린 단위가 붙은 값은 안 붙은 값보다 위험하다.
 *    규격이 주는 길은 하나다: **단위를 모르면 COUNT로 낮춘다.** 린터의 교정 안내와 같다.
 */
function measureOrCount(dataType: string, hasUnit: boolean): string {
  if (hasUnit) return dataType;
  if (dataType === 'REAL_MEASURE') return 'REAL_COUNT';
  if (dataType === 'INTEGER_MEASURE') return 'INTEGER_COUNT';
  return dataType;
}

/**
 * KOSMO-SME-4는 **값이 비어 있으면 위반**으로 본다(OperationalData는 면제 대상이 아니다).
 *
 * 🔴 이것은 값을 지어내는 것이 아니다. 산출물은 Type/Template이고 이 칸은 **예시 데이터** 자리다 —
 *    골든 파일도 `CurrentLineSpeed = 18.5`처럼 예시를 담고 있다. 수집이 붙으면
 *    `?live=true`와 OPC UA 노출에서 실제 값이 이 자리를 덮는다(파일은 그대로 — A안).
 */
const EXAMPLE_VALUE: Record<string, string> = {
  'xs:double': '0.0',
  'xs:int': '0',
  'xs:boolean': 'false',
  'xs:string': 'N/A',
};

const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;

export interface RuntimeGroupInput {
  iriBase: string;
  /** 대분류 SMC — 예: ProcessMonitoring */
  group: string;
  /** 소분류 SMC — 예: CollectedValues */
  subgroup: string;
  tags: readonly AidTagInput[];
  /**
   * 🔴 **파일 전체에서 이미 쓰이는 이름.** 이걸 안 넘기면 다른 서브모델(예: DigitalNameplate)에
   *    있는 이름을 여기서 또 만들고, 그러면 수집값이 어느 쪽에 얹힐지 몰라 **둘 다 못 얹는다**
   *    (`overlayEnvironment`가 ambiguous로 판정). 실측으로 걸린 자리다.
   */
  takenNames?: readonly string[];
}

export class RuntimeBuildError extends Error {}

/** 자체 IRI CD를 가리키는 semanticId — 골든 파일과 같은 형태 */
function conceptRef(iriBase: string, idShort: string): Record<string, unknown> {
  return {
    type: 'ModelReference',
    keys: [{ type: 'ConceptDescription', value: `${iriBase}/cd/${idShort}/1/0` }],
  };
}

/**
 * 장비특화 항목의 CD. `isCaseOf`를 넣지 않는다 —
 * 표준 사전에 대응이 없어서 만드는 것이므로 가리킬 원본이 없다(골든 파일도 없다).
 */
export function runtimeConcept(
  iriBase: string,
  idShort: string,
  unit?: string,
  valueType?: string,
): Record<string, unknown> {
  return {
    modelType: 'ConceptDescription',
    id: `${iriBase}/cd/${idShort}/1/0`,
    idShort,
    embeddedDataSpecifications: [
      {
        dataSpecification: {
          type: 'ExternalReference',
          keys: [{ type: 'GlobalReference', value: IEC61360 }],
        },
        dataSpecificationContent: {
          modelType: 'DataSpecificationIec61360',
          preferredName: [
            { language: 'ko', text: idShort },
            { language: 'en', text: idShort },
          ],
          dataType: measureOrCount(
            IEC_DATA_TYPE[valueType ?? 'xs:string'] ?? 'STRING',
            unit !== undefined && unit !== '',
          ),
          ...(unit === undefined || unit === '' ? {} : { unit }),
          definition: [
            { language: 'ko', text: `수집 항목 ${idShort}` },
            { language: 'en', text: idShort },
          ],
        },
      },
    ],
  };
}

/** 태그 하나 → Property 하나 */
export function runtimeProperty(iriBase: string, tag: AidTagInput): Record<string, unknown> {
  const valueType = runtimeValueType(tag.type);
  return {
    modelType: 'Property',
    idShort: tag.name,
    semanticId: conceptRef(iriBase, tag.name),
    valueType,
    // 🔴 예시 데이터 자리 — 비우면 KOSMO-SME-4 위반이다. 위 EXAMPLE_VALUE 설명 참고
    value: EXAMPLE_VALUE[valueType] ?? 'N/A',
  };
}

function smc(iriBase: string, idShort: string, value: unknown[]): Record<string, unknown> {
  return {
    modelType: 'SubmodelElementCollection',
    idShort,
    semanticId: conceptRef(iriBase, idShort),
    value,
  };
}

export function checkRuntimeInput(input: RuntimeGroupInput): void {
  for (const [label, name] of [
    ['대분류', input.group],
    ['소분류', input.subgroup],
  ] as const) {
    if (!NAME_PATTERN.test(name)) {
      throw new RuntimeBuildError(
        `${label} 이름은 영문으로 시작하고 영문·숫자·밑줄만 씁니다: ${name}`,
      );
    }
  }
  for (const tag of input.tags) {
    if (!NAME_PATTERN.test(tag.name)) {
      throw new RuntimeBuildError(`태그 이름이 요소 이름으로 쓸 수 없습니다: ${tag.name}`);
    }
  }
}

export interface MergeResult {
  /** 바뀐 서브모델 (사본) */
  submodel: Record<string, unknown>;
  /** 새로 만든 Property 이름 */
  added: string[];
  /** 이 서브모델에 이미 있어서 건드리지 않은 이름 */
  kept: string[];
  /** 🔴 **다른 서브모델**에 이미 있어서 만들지 않은 이름 — 만들면 값이 어디에도 안 얹힌다 */
  conflicts: string[];
  /** 함께 만들어야 할 CD */
  conceptDescriptions: Record<string, unknown>[];
}

/**
 * 자식 목록. 🔴 Submodel은 `submodelElements`, 그 아래는 `value`다 —
 * 한쪽만 보면 "이미 있는지" 판정이 통째로 어긋난다(실측: 있는 것을 또 만들고 원본을 덮었다).
 */
function children(node: unknown): Record<string, unknown>[] {
  const record = node as { value?: unknown; submodelElements?: unknown } | undefined;
  const list = record?.submodelElements ?? record?.value;
  return Array.isArray(list) ? (list as Record<string, unknown>[]) : [];
}

/** 이 서브모델 어디엔가 이 idShort가 이미 있는가 — 깊이 상관없이 */
function hasName(node: unknown, name: string): boolean {
  for (const child of children(node)) {
    if (child['idShort'] === name) return true;
    if (hasName(child, name)) return true;
  }
  return false;
}

/**
 * OperationalData에 수집 항목을 합친다.
 *
 * 🔴 **이미 있는 이름은 그대로 둔다.** 값이 들어 있을 수 있고, 사람이 다른 자리에 이미
 *    만들어 뒀을 수도 있다 — 그 경우 이름만 맞으면 수집값은 어차피 그 자리에 얹힌다.
 *    덮어쓰면 그 사람이 한 일이 사라진다.
 */
export function mergeRuntimeGroup(
  submodel: Record<string, unknown>,
  input: RuntimeGroupInput,
): MergeResult {
  checkRuntimeInput(input);
  const copy = JSON.parse(JSON.stringify(submodel)) as Record<string, unknown>;

  const added: string[] = [];
  const kept: string[] = [];
  const conflicts: string[] = [];
  const taken = new Set(input.takenNames ?? []);
  const fresh = input.tags.filter((tag) => {
    if (hasName(copy, tag.name)) {
      kept.push(tag.name);
      return false;
    }
    if (taken.has(tag.name)) {
      // 다른 서브모델에 있다 — 여기 또 만들면 이름이 겹쳐 값이 **어느 쪽에도** 안 얹힌다
      conflicts.push(tag.name);
      return false;
    }
    added.push(tag.name);
    return true;
  });

  if (fresh.length === 0) {
    return { submodel: copy, added, kept, conflicts, conceptDescriptions: [] };
  }

  const properties = fresh.map((tag) => runtimeProperty(input.iriBase, tag));

  // 대분류 → 소분류 순으로 있으면 쓰고 없으면 만든다
  const roots = children(copy);
  let group = roots.find((node) => node['idShort'] === input.group);
  if (!group) {
    group = smc(input.iriBase, input.group, []);
    // 🔴 빈 배열은 V3.0 스키마가 거부한다. 반드시 뒤에서 채운다
    copy['submodelElements'] = [...roots, group];
  }
  const groupChildren = children(group);
  let subgroup = groupChildren.find((node) => node['idShort'] === input.subgroup);
  if (!subgroup) {
    subgroup = smc(input.iriBase, input.subgroup, properties);
    group['value'] = [...groupChildren, subgroup];
  } else {
    subgroup['value'] = [...children(subgroup), ...properties];
  }

  // CD는 겹치지 않게 — 이미 만든 것과 방금 만든 것 둘 다 본다
  const concepts: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const name of [input.group, input.subgroup, ...fresh.map((tag) => tag.name)]) {
    if (seen.has(name)) continue;
    seen.add(name);
    const tag = fresh.find((item) => item.name === name);
    // 대분류·소분류는 담는 요소라 자료형이 없다 — STRING으로 둔다(SME-5는 Property만 본다)
    concepts.push(
      runtimeConcept(input.iriBase, name, tag?.unit, tag ? runtimeValueType(tag.type) : undefined),
    );
  }

  return { submodel: copy, added, kept, conflicts, conceptDescriptions: concepts };
}
