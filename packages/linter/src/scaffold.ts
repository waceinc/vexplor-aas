/**
 * 새 설비 뼈대 만들기.
 *
 * 빈 AAS부터 시작하게 하지 않는 이유가 있다. KOSMO 규칙은 **서브모델 4종을 요구하고
 * 총 개수를 6~8종으로 묶는다**(KOSMO-AAS-4·7). 빈 파일에서 출발하면 그걸 사람이 기억해
 * 하나씩 붙여야 하고, 그건 지금도 되는 일이라 새로 만들 이유가 없다.
 * 그래서 **처음부터 규칙을 지키는 뼈대**를 준다 — 만들자마자 위반 0건이어야 한다.
 *
 * 🔴 규약(iriBase·필수 목록)은 여기서 지어내지 않고 **정책에서 받는다.**
 *    규칙이 두 군데 있으면 반드시 갈라진다.
 */
import type { Environment } from '@aas/core';
import {
  buildEntryNode,
  hierarchyConceptDescriptions,
  HIERARCHY_SUBMODEL_ID_SHORT,
  IDTA_HIERARCHY,
} from './hierarchy.js';
import { DEFAULT_POLICY, type LinterPolicy } from './policy.js';

/**
 * 임시 대표 사진(96×96 PNG, 220바이트).
 *
 * KOSMO-AAS-1이 `defaultThumbnail`을 **요구한다.** 없으면 새로 만든 파일이 태어나자마자
 * 위반 1건으로 시작하는데, 그건 "규칙대로 만든 뼈대"라고 할 수 없다.
 * 🔴 그래서 자리를 채워 두되 **테두리만 있는 빈 그림**이다 — 실제 장비 사진으로 바꿔야 한다.
 *    화면이 그 사실을 알려 준다.
 */
const PLACEHOLDER_THUMBNAIL_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAGAAAABgCAIAAABt+uBvAAAAo0lEQVR42u3doQ0AIAwAwe6Dw3YTJAOwv8Qhq8CQS36CW+BjzKWiQADoElDrqRMgQIAAAQIECBAgQIAAAQIECBAgQFwAAQIECBAgQIAECBAgQIAAAQIECBAgQIAAAQIECBAUQIAAAQIECBAgAQIECBAgQIAAAQIECBAgQIAAAQIECBAgQIAAAQIESIAAAQIECBAgQIAAAQIECBCgP4Dk7QPoQRuIbN3SR9KX9wAAAABJRU5ErkJggg==';

/**
 * base64 → 바이트.
 * 🔴 `atob`(브라우저)도 `Buffer`(Node)도 쓰지 않는다 — 이 패키지는 **양쪽에서 그대로 돌아야** 하고,
 *    전역에 기대는 순간 한쪽이 깨진다(M3 저작 UI가 린터를 브라우저에서 돌린다).
 */
const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function decodeBase64(text: string): Uint8Array {
  const clean = text.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let bits = 0;
  let held = 0;
  let at = 0;
  for (const character of clean) {
    const index = BASE64_ALPHABET.indexOf(character);
    if (index < 0) continue; // 줄바꿈 등은 건너뛴다
    held = (held << 6) | index;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (held >> bits) & 0xff;
    }
  }
  return out.subarray(0, at);
}

export const PLACEHOLDER_THUMBNAIL_PART = '/thumbnail.png';

export function placeholderThumbnail(): { part: string; contentType: string; data: Uint8Array } {
  return {
    part: PLACEHOLDER_THUMBNAIL_PART,
    contentType: 'image/png',
    data: decodeBase64(PLACEHOLDER_THUMBNAIL_BASE64),
  };
}

/**
 * 무엇의 AAS인가.
 *
 * 표준에서 AAS의 대상(Asset)은 설비만이 아니다 — **공정·라인·공장도 정식 대상**이다
 * (RAMI 4.0 계층: 설비 → Station → Work Center → 공장).
 *
 * 공정 단위의 목적은 **실제 공정 구성을 그대로 담는 것**이다(Validator 제출용이 아니다 —
 * 2026-08-25 사용자 확정). 그래서 공정에는 설비용 필수 4종을 **자동으로 넣지 않는다** —
 * 트리가 「공정 → 장비」로 시작해야 하는데 명판·기술사양이 먼저 보이면 공정이 아니라
 * 또 하나의 장비처럼 읽힌다(2026-08-26 사용자 확정). 계층(HierarchicalStructures)만 넣고,
 * 필요한 서브모델은 「서브모델 추가」로 그때 더한다.
 *
 * 🔴 구분은 표준 필드 **AssetInformation.assetType**으로 남긴다(V3.0 정식 필드).
 *    이 표시가 있어야 린터가 "필수 4종·6~8종" 같은 설비 규칙을 공정에 들이대지 않는다 —
 *    표시 없이 서브모델만 빼면 태어나자마자 KOSMO-AAS-4 위반으로 시작한다.
 */
// 'composite'가 표준 이름이다 — 계층은 재귀라 층 이름(공정·회사·라인)은 사용자가 짓는다.
// 'process'·'company'는 이미 만들어진 파일·API 호환으로 남긴다(같은 구조다).
export type AssetUnit = 'equipment' | 'composite' | 'process' | 'company';

export interface ScaffoldOptions {
  /** 장비명 — AAS의 idShort이자 모든 id의 가운데 마디가 된다 */
  assetName: string;
  /** 설비 한 대 / 여러 설비로 이루어진 공정 / 여러 공정으로 이루어진 회사·공장. 기본은 설비 */
  unit?: AssetUnit;
  /** 설비 고유 서브모델(안전·공정 등). 필수 4종에 더해 넣는다 */
  extraSubmodels?: readonly string[];
  version?: string;
  revision?: string;
  policy?: Partial<LinterPolicy>;
}

/**
 * 필수 4종에 더해 기본으로 넣는 것.
 * 골든 파일(설비 20종)이 공통으로 갖고 있고, 총 개수 하한(6종)을 채우는 데도 필요하다.
 */
export const DEFAULT_EXTRA_SUBMODELS = ['HierarchicalStructures', 'MaintenanceInstructions'];

/** 장비명으로 쓸 수 있는가 — id에 그대로 들어가므로 영문·숫자만 받는다 */
export function isValidAssetName(name: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_]*$/.test(name);
}

export function scaffoldEnvironment(options: ScaffoldOptions): Environment {
  const policy = { ...DEFAULT_POLICY, ...options.policy };
  const name = options.assetName;
  if (!isValidAssetName(name)) {
    throw new Error(`장비명은 영문으로 시작하고 영문·숫자·밑줄만 씁니다: ${name}`);
  }

  const version = options.version ?? '1';
  const revision = options.revision ?? '0';
  const base = policy.iriBase;
  const aasId = `${base}/aas/${name}/${version}/${revision}`;
  const assetId = `${base}/asset/${name}/${version}/${revision}`;

  const unit = options.unit ?? 'equipment';
  const organizational = unit !== 'equipment';
  const wanted = organizational
    ? // 공정·회사는 계층이 본체이자 전부다. 필수 4종은 설비의 것이라 자동으로 넣지 않는다
      [HIERARCHY_SUBMODEL_ID_SHORT, ...(options.extraSubmodels ?? [])]
    : [...policy.requiredSubmodels, ...(options.extraSubmodels ?? DEFAULT_EXTRA_SUBMODELS)];
  // 같은 이름이 두 번 들어오면 개수만 늘고 규칙을 깬다
  const names = [...new Set(wanted)];

  const submodels = names.map((idShort) => {
    const id = `${base}/sm/${name}/${idShort}/${version}/${revision}`;
    // 🔴 공정의 계층 서브모델만 내용을 채워 둔다. 진입점이 없으면 자식을 매달 자리가 없어
    //    사용자가 손으로 Entity를 만들어야 하는데, 그러라고 만든 기능이 아니다.
    //    설비 쪽은 손대지 않는다 — 지금 동작을 바꿀 이유가 없다.
    const seeded =
      organizational && idShort === HIERARCHY_SUBMODEL_ID_SHORT
        ? {
            submodelElements: [
              buildEntryNode(name, assetId, base),
              {
                idShort: 'ArcheType',
                modelType: 'Property',
                valueType: 'xs:string',
                value: 'Full',
                semanticId: {
                  type: 'ExternalReference',
                  keys: [{ type: 'GlobalReference', value: `${base}/cd/ArcheType/1/0` }],
                },
                supplementalSemanticIds: [
                  {
                    type: 'ExternalReference',
                    keys: [{ type: 'GlobalReference', value: IDTA_HIERARCHY.archeType }],
                  },
                ],
              },
            ],
          }
        : {};
    return {
      ...seeded,
      modelType: 'Submodel',
      id,
      idShort,
      // 산출물은 형식(Type) 단위다 — 서브모델은 Template이어야 한다(KOSMO-SM-4)
      kind: 'Template',
      administration: { version, revision },
      // 자체 IRI를 쓸 때는 semanticId가 자기 id를 가리킨다(KOSMO-SM-3)
      semanticId: { type: 'ExternalReference', keys: [{ type: 'GlobalReference', value: id }] },
      // 🔴 `submodelElements: []`를 쓰지 않는다. V3.0 스키마는 **빈 배열을 허용하지 않는다**
      //    (aas-test-engines 1.0.3: "Empty array not allowed"). 비었으면 키 자체가 없어야 한다.
      //    KOSMO 린터는 이걸 보지 않아서, 표준 검증기를 돌려 보고서야 드러났다.
    };
  });

  return {
    assetAdministrationShells: [
      {
        modelType: 'AssetAdministrationShell',
        id: aasId,
        idShort: name,
        administration: { version, revision },
        assetInformation: {
          assetKind: 'Type',
          // 공정·회사 표시 — 린터가 설비 규칙(필수 4종·6~8종)을 들이대지 않는 근거가 된다
          ...(unit === 'composite' ? { assetType: compositeAssetType(base) } : {}),
          ...(unit === 'process' ? { assetType: processAssetType(base) } : {}),
          ...(unit === 'company' ? { assetType: companyAssetType(base) } : {}),
          globalAssetId: assetId,
          // KOSMO-AAS-1이 요구한다. 임시 그림이며 실제 사진으로 바꿔야 한다
          defaultThumbnail: { path: PLACEHOLDER_THUMBNAIL_PART, contentType: 'image/png' },
        },
        submodels: submodels.map((submodel) => ({
          type: 'ModelReference',
          keys: [{ type: 'Submodel', value: submodel.id }],
        })),
      },
    ],
    submodels,
    // 🔴 공정만 ConceptDescription을 함께 넣는다. 계층 요소가 자체 IRI를 쓰기 때문이다
    //    (KOSMO-SME-3). 설비 뼈대는 요소가 없어 semanticId도 없으므로 넣을 것이 없다 —
    //    conceptDescriptions를 빈 배열로 두지 않는 이유는 submodelElements와 같다
    ...(organizational ? { conceptDescriptions: hierarchyConceptDescriptions(base) } : {}),
  } as unknown as Environment;
}

/**
 * 공정·회사 파일임을 나타내는 AssetInformation.assetType 값.
 * 🔴 한 곳에서만 만든다 — 린터(KOSMO-AAS-4 예외)와 뼈대가 서로 다른 문자열을 쓰면
 *    구분이 조용히 깨진다. 계층은 재귀라(RAMI 4.0: 기업→공장→스테이션→설비)
 *    회사도 공정과 같은 구조에 이름표만 다르다.
 */
export function processAssetType(iriBase: string): string {
  return `${iriBase}/type/Process`;
}

export function companyAssetType(iriBase: string): string {
  return `${iriBase}/type/Company`;
}

/** 묶음 단위(공정·회사·라인 공통) — 층 이름을 고정하지 않는다 */
export function compositeAssetType(iriBase: string): string {
  return `${iriBase}/type/Composite`;
}

/** 묶음 단위(공정·회사·라인)인가 — 설비 규칙(필수 4종·6~8종)을 들이대지 않을 대상 */
export function isOrganizationalAssetType(assetType: string | undefined, iriBase: string): boolean {
  return (
    assetType === compositeAssetType(iriBase) ||
    assetType === processAssetType(iriBase) ||
    assetType === companyAssetType(iriBase)
  );
}
