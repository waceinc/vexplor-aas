/**
 * AID 서브모델 만들기 — 화면에서 「수집 연결」을 만드는 자리.
 *
 * 왜 필요한가: 수집이 되려면 파일 안에 AID(IDTA-02017)가 있어야 하는데, 그 구조가
 * 4~5단 중첩이라 「요소 추가」로 사람이 쌓는 것은 사실상 불가능하다. 지금까지는
 * 시연 스크립트로만 만들 수 있었다 — 실제 설비를 붙일 길이 없었다는 뜻이다.
 *
 * 🔴 semanticId는 **IDTA 공식 템플릿(IDTA-02017-1-0)에서 그대로** 가져온다.
 *    손으로 지으면 표준 용어가 빠져 KOSMO-SME-3이 요소 수만큼 뜬다(실측).
 * 🔴 이렇게 만든 AID는 `parseAid()`가 반드시 도로 읽을 수 있어야 한다 —
 *    만들기와 읽기가 어긋나면 "만들었는데 수집이 안 된다"가 된다. 시험이 왕복을 고정한다.
 */
import type { SubmodelElement } from '@aas/core';

/** IDTA-02017-1-0 템플릿의 표준 semanticId */
const TERM = {
  interface: 'https://admin-shell.io/idta/AssetInterfacesDescription/1/0/Interface',
  endpointMetadata: 'https://admin-shell.io/idta/AssetInterfacesDescription/1/0/EndpointMetadata',
  base: 'https://www.w3.org/2019/wot/td#baseURI',
  contentType: 'https://www.w3.org/2019/wot/hypermedia#forContentType',
  interactionMetadata:
    'https://admin-shell.io/idta/AssetInterfacesDescription/1/0/InteractionMetadata',
  properties: 'https://www.w3.org/2019/wot/td#PropertyAffordance',
  propertyDefinition:
    'https://admin-shell.io/idta/AssetInterfaceDescription/1/0/PropertyDefinition',
  key: 'https://admin-shell.io/idta/AssetInterfacesDescription/1/0/key',
  type: 'https://www.w3.org/1999/02/22-rdf-syntax-ns#type',
  title: 'https://www.w3.org/2019/wot/td#title',
  observable: 'https://www.w3.org/2019/wot/td#isObservable',
  unit: 'https://schema.org/unitCode',
  forms: 'https://www.w3.org/2019/wot/td#hasForm',
  href: 'https://www.w3.org/2019/wot/hypermedia#hasTarget',
} as const;

export interface AidTagInput {
  /**
   * 항목 이름 — 요소의 idShort가 된다.
   * 🔴 모델의 요소 idShort와 **같아야** 수집값이 표준 API(`live=true`)로 나간다.
   */
  name: string;
  /** 읽을 주소. OPC UA면 NodeId (예: ns=1;s=Machine.MotorSpeed) */
  href: string;
  /** 자산 쪽 식별자 (예: PLC 주소 D100). 몰라도 된다 */
  key?: string;
  /** float · integer · string · boolean */
  type?: string;
  /** UCUM 단위 (rpm · Cel · ea …) */
  unit?: string;
}

export interface AidBuildInput {
  /** 장비명 — AAS의 idShort. 서브모델 id에 들어간다 */
  assetName: string;
  /** KOSMO 자체 IRI 뿌리 */
  iriBase: string;
  /** 접속 주소 (opc.tcp://호스트:포트/...) */
  endpoint: string;
  tags: readonly AidTagInput[];
  /** 인터페이스 표시 이름. 기본은 "{장비명} 제어반 (OPC UA)" */
  title?: string;
}

export class AidBuildError extends Error {}

const ref = (value: string) => ({
  type: 'ExternalReference',
  keys: [{ type: 'GlobalReference', value }],
});

/**
 * 🔴 kosmo-first 짝 — semanticId는 자체 IRI(cd/{idShort}), IDTA 원본은 supplemental로 보존.
 * 전에는 IDTA IRI를 semanticId로 직접 썼는데, 그러면 도구가 만든 AID가 도구 규칙
 * (KOSMO-SME-3: 자체 CD 필요)에 태어나자마자 13건 걸렸다(실측). 계층(hierarchy.ts)과
 * 같은 패턴으로 맞춘다 — 「고치기」가 이관하면 IDTA 표시가 사라지는 문제도 함께 없어진다.
 */
const pair = (iriBase: string, idShort: string, idtaTerm: string) => ({
  semanticId: ref(`${iriBase}/cd/${idShort}/1/0`),
  supplementalSemanticIds: [ref(idtaTerm)],
});
const smc = (iriBase: string, idShort: string, idtaTerm: string, value: unknown[]) => ({
  modelType: 'SubmodelElementCollection',
  idShort,
  ...pair(iriBase, idShort, idtaTerm),
  value,
});
const prop = (iriBase: string, idShort: string, idtaTerm: string, value: string) => ({
  modelType: 'Property',
  idShort,
  ...pair(iriBase, idShort, idtaTerm),
  valueType: 'xs:string',
  value,
});

const NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;
const TYPES = new Set(['float', 'integer', 'string', 'boolean']);

/** 들어온 값을 먼저 본다 — 틀린 AID를 만들어 놓고 수집이 안 되는 것보다 여기서 멈추는 게 낫다 */
export function checkAidInput(input: AidBuildInput): void {
  if (!/^opc\.tcp:\/\/.+/.test(input.endpoint)) {
    throw new AidBuildError(
      `접속 주소는 opc.tcp:// 로 시작해야 합니다: ${input.endpoint}`,
    );
  }
  if (input.tags.length === 0) throw new AidBuildError('태그가 하나도 없습니다.');
  const seen = new Set<string>();
  for (const tag of input.tags) {
    if (!NAME_PATTERN.test(tag.name)) {
      throw new AidBuildError(
        `태그 이름은 영문으로 시작하고 영문·숫자·밑줄만 씁니다: ${tag.name}`,
      );
    }
    if (seen.has(tag.name)) throw new AidBuildError(`태그 이름이 겹칩니다: ${tag.name}`);
    seen.add(tag.name);
    // 🔴 href가 아예 없으면(API를 직접 부른 호출) 500이 났다 — 빈 주소와 같이 400으로 알린다(2026-09-30)
    if (typeof tag.href !== 'string' || tag.href.trim() === '') {
      throw new AidBuildError(`${tag.name}의 읽을 주소(NodeId)가 비었습니다.`);
    }
    if (tag.type !== undefined && !TYPES.has(tag.type)) {
      throw new AidBuildError(
        `${tag.name}의 타입이 이상합니다: ${tag.type} — 쓸 수 있는 것: ${[...TYPES].join(' · ')}`,
      );
    }
  }
}

/**
 * AID 서브모델을 만든다.
 * 🔴 서브모델의 semanticId는 자기 id를 쓴다 — KOSMO가 admin-shell.io IRI를 거부한다(규정 충돌 ①).
 */
export function buildAidSubmodel(input: AidBuildInput): Record<string, unknown> {
  const base = input.iriBase;
  checkAidInput(input);
  const id = `${input.iriBase}/sm/${input.assetName}/AssetInterfacesDescription/1/0`;

  return {
    modelType: 'Submodel',
    id,
    idShort: 'AssetInterfacesDescription',
    kind: 'Template',
    administration: { version: '1', revision: '0' },
    semanticId: ref(id),
    submodelElements: [
      smc(base, 'InterfaceTemplateForOPCUA', TERM.interface, [
        prop(base, 'title', TERM.title, input.title ?? `${input.assetName} 제어반 (OPC UA)`),
        smc(base, 'EndpointMetadata', TERM.endpointMetadata, [
          prop(base, 'base', TERM.base, input.endpoint),
          prop(base, 'contentType', TERM.contentType, 'application/json'),
        ]),
        smc(base, 'InteractionMetadata', TERM.interactionMetadata, [
          smc(
            base,
            'properties',
            TERM.properties,
            input.tags.map((tag) =>
              smc(base, tag.name, TERM.propertyDefinition, [
                ...(tag.key ? [prop(base, 'key', TERM.key, tag.key)] : []),
                prop(base, 'type', TERM.type, tag.type ?? 'string'),
                prop(base, 'title', TERM.title, tag.name),
                prop(base, 'observable', TERM.observable, 'true'),
                ...(tag.unit ? [prop(base, 'unit', TERM.unit, tag.unit)] : []),
                smc(base, 'forms', TERM.forms, [prop(base, 'href', TERM.href, tag.href)]),
              ]),
            ),
          ),
        ]),
      ]) as unknown as SubmodelElement,
    ],
  };
}

/**
 * AID가 쓰는 자체 용어의 ConceptDescription — 골든 파일과 같은 모양
 * (IEC 61360 명세 + isCaseOf로 IDTA 원본을 가리킨다). 이것이 함께 들어가야
 * KOSMO-SME-3(자체 IRI면 CD 필요)을 태어날 때부터 통과한다.
 */
const IEC61360 =
  'https://admin-shell.io/DataSpecificationTemplates/DataSpecificationIec61360/3/0';

function aidConcept(iriBase: string, idShort: string, idtaTerm: string): Record<string, unknown> {
  return {
    modelType: 'ConceptDescription',
    id: `${iriBase}/cd/${idShort}/1/0`,
    idShort,
    embeddedDataSpecifications: [
      {
        dataSpecification: { type: 'ExternalReference', keys: [{ type: 'GlobalReference', value: IEC61360 }] },
        dataSpecificationContent: {
          modelType: 'DataSpecificationIec61360',
          preferredName: [{ language: 'en', text: idShort }],
          dataType: 'STRING',
          definition: [{ language: 'en', text: idShort }],
        },
      },
    ],
    isCaseOf: [{ type: 'ExternalReference', keys: [{ type: 'GlobalReference', value: idtaTerm }] }],
  };
}

/** 이 AID가 쓰는 용어 전부의 CD — 태그 이름(장비마다 다름)까지 포함 */
export function aidConceptDescriptions(input: AidBuildInput): Record<string, unknown>[] {
  const fixed: [string, string][] = [
    ['InterfaceTemplateForOPCUA', TERM.interface],
    ['EndpointMetadata', TERM.endpointMetadata],
    ['InteractionMetadata', TERM.interactionMetadata],
    ['properties', TERM.properties],
    ['forms', TERM.forms],
    ['base', TERM.base],
    ['contentType', TERM.contentType],
    ['title', TERM.title],
    ['type', TERM.type],
    ['observable', TERM.observable],
    ['href', TERM.href],
    ['key', TERM.key],
    ['unit', TERM.unit],
  ];
  const out = fixed.map(([idShort, term]) => aidConcept(input.iriBase, idShort, term));
  for (const tag of input.tags) {
    out.push(aidConcept(input.iriBase, tag.name, TERM.propertyDefinition));
  }
  return out;
}
