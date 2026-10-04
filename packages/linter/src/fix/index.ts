/**
 * Quick Fix — 린터가 fixable로 표시한 지적을 한 건 단위로 교정한다.
 *
 * 여러 파일 일괄 교정 파이프라인이 아니다(2026-08-21 결정). 저작 UI가 지적 하나를 집어
 * applyFixes에 넘기는 것을 기본 사용법으로 보고 설계했다. 그래서
 *  - 입력 Environment는 절대 바꾸지 않는다 (cloneEnvironment 후 수정)
 *  - id를 바꾸는 교정은 참조를 함께 갱신한다 (replaceIdEverywhere)
 *  - 원래 IRI는 이관 대장(ledger)에 남겨 되돌릴 수 있게 한다
 *  - 고칠 수 없으면 조용히 넘어가지 않고 이유를 남긴다 (skipped)
 *
 * 리스트 계열 제약은 한 건을 고치면 다음 건이 드러나므로 lint → fix를 수렴할 때까지 반복한다.
 */
import { firstKeyValue, iec61360Of, XS_TO_DATA_TYPE } from '../util.js';
import { lint, type LintOptions } from '../engine.js';
import { DEFAULT_POLICY, type LinterPolicy } from '../policy.js';
import { ALL_RULES } from '../rules/index.js';
import type { Finding, LintResult, PackageContext, Rule } from '../types.js';
import type {
  AppliedFix,
  FixSelector,
  FixInput,
  FixOutcome,
  Fixer,
  FixResult,
  RelocationLedger,
  SkippedFix,
} from './types.js';
import {
  asElement,
  cloneEnvironment,
  conceptDescriptionAt,
  findThumbnailPart,
  idExists,
  imageContentType,
  inferDataType,
  makeConceptDescription,
  makeIec61360,
  pickDataType,
  replaceIdEverywhere,
  shellAt,
  submodelAt,
  valueTypeFor,
  versionFromId,
  versionOf,
  withVersionSuffix,
} from './helpers.js';
import {
  IEC61360_TEMPLATE_IRI,
  parentPointer,
  resolvePointer,
  type Environment,
  type LangString,
  type Property,
} from '@aas/core';

export * from './types.js';
export * from './helpers.js';

const applied = (description: string, before?: unknown, after?: unknown): FixOutcome => ({
  status: 'applied',
  description,
  ...(before === undefined ? {} : { before }),
  ...(after === undefined ? {} : { after }),
});

const skipped = (reason: string): FixOutcome => ({ status: 'skipped', reason });

/**
 * 이관 대장 기록. 이미 기록된 새 IRI는 덮어쓰지 않는다 —
 * 한 요소가 두 번 옮겨져도 **최초 원본**이 남아야 되돌릴 수 있다.
 */
function record(ledger: RelocationLedger, newIri: string, oldIri: string): void {
  if (newIri === oldIri) return;
  if (ledger[newIri] === undefined) ledger[newIri] = oldIri;
}

// ── KOSMO-AAS-1 · 썸네일 ─────────────────────────────────────────────────────

const fixThumbnail: Fixer = ({ environment, finding, package: pkg }) => {
  const shell = shellAt(environment, finding.pointer);
  if (!shell) return skipped('대상 AssetAdministrationShell을 찾을 수 없습니다.');
  if (!pkg) {
    return skipped(
      '패키지 정보가 없어 썸네일 파트를 찾을 수 없습니다. AASX를 읽을 때의 opc 정보를 함께 넘기십시오.',
    );
  }

  const part = findThumbnailPart(pkg.parts);
  if (!part) {
    return skipped('패키지에 이미지 파트가 없습니다. 썸네일 파일을 먼저 추가해야 합니다.');
  }

  const before = shell.assetInformation.defaultThumbnail;
  if (before?.path === part) return skipped('이미 해당 파트를 가리키고 있습니다.');

  const after = { path: part, contentType: imageContentType(part) };
  shell.assetInformation.defaultThumbnail = after;
  return applied(`defaultThumbnail을 패키지 파트 ${part}로 지정했습니다.`, before, after);
};

// ── KOSMO-AAS-3 / KOSMO-SM-2 · administration과 id 접미 일치 ─────────────────

/**
 * 두 방향이 있고 방향 선택이 곧 위험도다.
 *  - administration이 없을 때 : id에서 뽑아 administration을 만든다 (참조 무영향, 안전)
 *  - 접미가 어긋날 때        : id를 고치고 Environment 전체의 참조를 함께 갱신한다
 */
const fixVersionConsistency: Fixer = ({ environment, finding, ledger }) => {
  const item =
    shellAt(environment, finding.pointer) ?? submodelAt(environment, finding.pointer);
  if (!item) return skipped('대상 Identifiable을 찾을 수 없습니다.');

  if (finding.pointer.endsWith('/administration')) {
    const derived = versionFromId(item.id);
    if (!derived) {
      return skipped(
        `id의 끝 두 세그먼트가 버전 형식이 아니어서 administration을 유추할 수 없습니다: ${item.id}. ` +
          'version·revision을 직접 입력하십시오.',
      );
    }
    const before = item.administration;
    item.administration = { ...before, ...derived };
    return applied(
      `id 접미에서 administration을 만들었습니다: version=${derived.version}, revision=${derived.revision}`,
      before,
      item.administration,
    );
  }

  const admin = item.administration;
  if (!admin?.version || !admin.revision) {
    return skipped('administration이 없어 기대 id를 만들 수 없습니다.');
  }

  const oldId = item.id;
  const newId = withVersionSuffix(oldId, admin.version, admin.revision);
  if (newId === oldId) return skipped('이미 administration과 일치합니다.');
  if (idExists(environment, newId, item)) {
    return skipped(`같은 id를 쓰는 다른 요소가 있습니다: ${newId}`);
  }

  item.id = newId;
  const refs = replaceIdEverywhere(environment, oldId, newId);
  record(ledger, newId, oldId);
  return applied(`id를 administration에 맞추고 참조 ${refs}건을 함께 갱신했습니다.`, oldId, newId);
};

// ── KOSMO-AAS-5 · globalAssetId ──────────────────────────────────────────────

const fixGlobalAssetId: Fixer = ({ environment, finding, policy }) => {
  const shell = shellAt(environment, finding.pointer);
  if (!shell) return skipped('대상 AssetAdministrationShell을 찾을 수 없습니다.');
  if (!shell.idShort) return skipped('AAS에 idShort가 없어 asset IRI를 만들 수 없습니다.');

  const { version, revision } = versionOf(shell);
  const value = `${policy.iriBase}/asset/${shell.idShort}/${version}/${revision}`;
  const before = shell.assetInformation.globalAssetId;
  if (before === value) return skipped('이미 같은 값입니다.');

  shell.assetInformation.globalAssetId = value;
  return applied(`globalAssetId를 ${value}로 지정했습니다.`, before, value);
};

// ── KOSMO-AAS-6 / KOSMO-SM-4 · Type · Template ───────────────────────────────

const fixAssetKind: Fixer = ({ environment, finding }) => {
  const shell = shellAt(environment, finding.pointer);
  if (!shell) return skipped('대상 AssetAdministrationShell을 찾을 수 없습니다.');
  const before = shell.assetInformation.assetKind;
  if (before === 'Type') return skipped('이미 Type입니다.');
  shell.assetInformation.assetKind = 'Type';
  return applied('assetKind를 Type으로 바꿨습니다.', before, 'Type');
};

const fixModellingKind: Fixer = ({ environment, finding }) => {
  const sm = submodelAt(environment, finding.pointer);
  if (!sm) return skipped('대상 Submodel을 찾을 수 없습니다.');
  const before = sm.kind;
  if (before === 'Template') return skipped('이미 Template입니다.');
  sm.kind = 'Template';
  return applied('kind를 Template으로 바꿨습니다.', before, 'Template');
};

// ── KOSMO-SM-3 · Submodel semanticId ─────────────────────────────────────────

/**
 * semanticId를 자신의 Submodel id로 돌린다(골든 파일 방식).
 * 원본 IRI는 반드시 대장에 남긴다 — IDTA 공식 IRI를 KOSMO 화이트리스트로 옮기는 교정이라
 * 규정 해석이 뒤집히면 여기서부터 되돌려야 한다.
 */
const fixSubmodelSemanticId: Fixer = ({ environment, finding, ledger }) => {
  const sm = submodelAt(environment, finding.pointer);
  if (!sm) return skipped('대상 Submodel을 찾을 수 없습니다.');

  if (finding.pointer.endsWith('/semanticId/keys/0/type')) {
    const key = sm.semanticId?.keys?.[0];
    if (!key) return skipped('semanticId 키가 없습니다.');
    const before = key.type;
    if (before === 'GlobalReference') return skipped('이미 GlobalReference입니다.');
    key.type = 'GlobalReference';
    return applied(
      'semanticId 키 타입을 GlobalReference로 되돌렸습니다(basyx 서브모델 드롭 방지).',
      before,
      'GlobalReference',
    );
  }

  const before = firstKeyValue(sm.semanticId);
  if (before === sm.id) return skipped('이미 자신의 id를 가리키고 있습니다.');

  sm.semanticId = {
    type: 'ExternalReference',
    keys: [{ type: 'GlobalReference', value: sm.id }],
  };
  if (before !== undefined) record(ledger, sm.id, before);

  return applied(
    before === undefined
      ? `semanticId를 자신의 id(${sm.id})로 지정했습니다.`
      : `semanticId를 자신의 id로 옮기고 원본 IRI를 이관 대장에 기록했습니다.`,
    before,
    sm.id,
  );
};

// ── KOSMO-CD-2 · ConceptDescription id ───────────────────────────────────────

const fixConceptDescriptionId: Fixer = ({ environment, finding, policy, ledger }) => {
  const cd = conceptDescriptionAt(environment, finding.pointer);
  if (!cd) return skipped('대상 ConceptDescription을 찾을 수 없습니다.');
  if (!cd.idShort) {
    return skipped('CD에 idShort가 없어 새 id를 만들 수 없습니다. KOSMO-CD-1을 먼저 고치십시오.');
  }

  const { version, revision } = versionOf(cd);
  const oldId = cd.id;
  const newId = `${policy.iriBase}/cd/${cd.idShort}/${version}/${revision}`;
  if (newId === oldId) return skipped('이미 규약에 맞는 id입니다.');
  if (idExists(environment, newId, cd)) {
    return skipped(
      `같은 idShort의 CD가 이미 ${newId}를 쓰고 있습니다. 중복 CD를 하나로 합친 뒤 다시 시도하십시오.`,
    );
  }

  cd.id = newId;
  const refs = replaceIdEverywhere(environment, oldId, newId);
  record(ledger, newId, oldId);
  return applied(
    `CD id를 자체 IRI 규약으로 옮기고 참조 ${refs}건을 갱신했습니다. 원본은 이관 대장에 남겼습니다.`,
    oldId,
    newId,
  );
};

// ── KOSMO-CD-4 · dataType ────────────────────────────────────────────────────

const fixConceptDataType: Fixer = ({ environment, finding }) => {
  const cd = conceptDescriptionAt(environment, finding.pointer);
  if (!cd) return skipped('대상 ConceptDescription을 찾을 수 없습니다.');

  if (finding.pointer.endsWith('/embeddedDataSpecifications')) {
    if (!cd.idShort) return skipped('CD에 idShort가 없어 데이터 명세를 만들 수 없습니다.');
    if (iec61360Of(cd)) return skipped('이미 IEC 61360 명세가 있습니다.');
    const content = makeIec61360(cd.idShort, 'STRING');
    cd.embeddedDataSpecifications = [
      ...(cd.embeddedDataSpecifications ?? []),
      {
        dataSpecification: {
          type: 'ExternalReference',
          keys: [{ type: 'GlobalReference', value: IEC61360_TEMPLATE_IRI }],
        },
        dataSpecificationContent: content,
      },
    ];
    return applied('IEC 61360 데이터 명세를 STRING으로 만들었습니다.', undefined, content);
  }

  const content = iec61360Of(cd);
  if (!content) return skipped('IEC 61360 명세가 없습니다.');
  const before = content.dataType;
  if (before === 'STRING') return skipped('이미 STRING입니다.');
  content.dataType = 'STRING';
  return applied(
    before === undefined
      ? 'dataType을 STRING으로 지정했습니다.'
      : `허용 목록 밖 dataType(${before})을 STRING으로 정규화했습니다.`,
    before,
    'STRING',
  );
};

// ── KOSMO-SME-3 · semanticId와 CD 매핑 ───────────────────────────────────────

/** 리스트 이름의 단수형 — 골든 파일의 명명(Markings → Marking · Documents → Document)과 같다 */
function singularOf(name: string): string {
  if (/ies$/.test(name)) return name.replace(/ies$/, 'y');
  if (/s$/.test(name) && name.length > 3) return name.slice(0, -1);
  return `${name}Entry`;
}

const fixConceptMapping: Fixer = ({ environment, finding, policy }) => {
  const nodePointer = parentPointer(finding.pointer);
  const node = asElement(resolvePointer(environment, nodePointer)?.value);
  if (!node) return skipped('대상 SubmodelElement를 찾을 수 없습니다.');

  const existing = firstKeyValue(node.semanticId);
  let targetId = existing;
  let assigned = false;
  /** CD를 새로 만들 때 쓸 이름 — 리스트 자식은 idShort가 없어 부모 리스트에서 빌린다 */
  let cdName = node.idShort;
  let borrowed = false;
  // 🔴 리스트 자식은 idShort가 없다(AASd-120 교정 뒤가 보통). 전에는 "idShort가 없어 못 만든다"로 건너뛰어
  //    단추는 「N건」인데 들어가면 "사람이 판단"이 됐다(사용자 2026-09-11). 부모 리스트에서 빌린다:
  //    이름은 부모 이름의 단수형(Markings → Marking — 골든 파일의 명명), semanticId가 아예 없으면
  //    부모의 semanticIdListElement(자식 전체의 semanticId)부터 본다
  const list = cdName
    ? undefined
    : (asElement(resolvePointer(environment, parentPointer(parentPointer(nodePointer)))?.value) as
        | (NonNullable<ReturnType<typeof asElement>> & { semanticIdListElement?: Parameters<typeof firstKeyValue>[0] })
        | undefined);
  if (!cdName && list?.idShort) {
    cdName = singularOf(list.idShort);
    borrowed = true;
  }

  if (targetId === undefined) {
    const declared = firstKeyValue(list?.semanticIdListElement);
    if (declared !== undefined) targetId = declared;
    else {
      if (!cdName) return skipped('idShort가 없고 부모 리스트에서도 이름을 빌릴 수 없어 CD id를 만들 수 없습니다.');
      // 빌린 이름이면 같은 이름의 CD가 이미 있을 때(골든 파일의 Marking — 표준 사전 IRDI) 그것을 가리킨다.
      // 제 이름이 있는 요소는 예전대로 규약 IRI로 새로 짓는다 — 이름만 같은 사전 항목에 멋대로 붙이지 않는다
      const known = borrowed ? (environment.conceptDescriptions ?? []).find((cd) => cd.idShort === cdName) : undefined;
      targetId = known ? known.id : `${policy.iriBase}/cd/${cdName}/1/0`;
    }
    node.semanticId = {
      type: 'ExternalReference',
      keys: [{ type: 'GlobalReference', value: targetId }],
    };
    assigned = true;
  }

  const cds = (environment.conceptDescriptions ??= []);
  const already = cds.some((cd) => cd.id === targetId);
  if (!already) {
    if (!cdName) {
      return skipped('idShort가 없어 ConceptDescription을 만들 수 없습니다.');
    }
    cds.push(makeConceptDescription(targetId, cdName, inferDataType(node)));
  }

  if (!assigned && already) return skipped('이미 대응하는 ConceptDescription이 있습니다.');

  const what = [
    assigned ? 'semanticId를 지정' : null,
    already ? null : 'ConceptDescription을 생성',
  ]
    .filter(Boolean)
    .join('하고 ');
  return applied(
    `${what}했습니다: ${targetId}. 정의는 idShort를 그대로 둔 자리표시자이므로 개발계획서 원문으로 대체하십시오.`,
    existing,
    targetId,
  );
};

// ── AASc-3a-009 · MEASURE인데 단위가 없다 ────────────────────────────────────

/** MEASURE 계열 → 단위가 필요 없는 COUNT 계열 */
const MEASURE_TO_COUNT = {
  REAL_MEASURE: 'REAL_COUNT',
  INTEGER_MEASURE: 'INTEGER_COUNT',
  RATIONAL_MEASURE: 'RATIONAL',
} as const satisfies Record<string, NonNullable<ReturnType<typeof iec61360Of>>['dataType']>;

/**
 * 🔴 **단위를 지어내지 않는다.** 「12.5」가 kW인지 A인지 우리는 모르고,
 *    틀린 단위가 붙은 값은 안 붙은 값보다 위험하다.
 *
 * 규격이 주는 길은 둘이고 우리가 고를 수 있는 것은 하나다.
 *   ① 단위를 적는다 — 사람만 할 수 있다
 *   ② dataType을 단위가 필요 없는 COUNT 계열로 낮춘다 ← 이쪽
 *
 * 그래서 낮추되 **실측값이면 되돌리라고 분명히 말한다**(KOSMO-SME-3의 자리표시자와 같은 태도).
 * CURRENCY는 손대지 않는다 — 통화는 단위가 본질이라 낮출 자리가 없다.
 */
const fixMeasureUnit: Fixer = ({ environment, finding }) => {
  const cd = conceptDescriptionAt(environment, finding.pointer);
  if (!cd) return skipped('대상 ConceptDescription을 찾을 수 없습니다.');
  const content = iec61360Of(cd);
  if (!content) return skipped('IEC 61360 명세가 없습니다.');
  if (content.unit || content.unitId) return skipped('이미 단위가 있습니다.');

  const before = content.dataType;
  const after =
    before === undefined
      ? undefined
      : MEASURE_TO_COUNT[before as keyof typeof MEASURE_TO_COUNT];
  if (!after) {
    return skipped(
      `${before ?? '알 수 없는'} dataType은 단위를 빼고 표현할 수 없습니다 — 단위를 직접 넣으십시오.`,
    );
  }
  content.dataType = after;
  return applied(
    `단위를 모르므로 dataType을 ${before} → ${after}로 낮췄습니다. ` +
      `🔴 실제로 단위가 있는 측정값이라면 unit을 넣고 ${before}로 되돌리십시오.`,
    before,
    after,
  );
};

// ── KOSMO-SME-5 · valueType과 dataType 정합 ──────────────────────────────────

/**
 * 교정 방향이 CD의 출처에 따라 **반대**다.
 *  - 외부 표준 사전(IRDI) CD : 원본을 존중하고 우리 쪽 Property.valueType을 맞춘다
 *  - 자체 CD                : CD의 dataType을 Property에 맞춘다
 */
const fixValueTypeMatch: Fixer = ({ environment, finding, policy }) => {
  const node = asElement(resolvePointer(environment, parentPointer(finding.pointer))?.value);
  if (!node || node.modelType !== 'Property') return skipped('대상 Property를 찾을 수 없습니다.');
  const prop = node as Property;

  const semantic = firstKeyValue(prop.semanticId);
  if (semantic === undefined) return skipped('semanticId가 없습니다. KOSMO-SME-3을 먼저 고치십시오.');

  const cd = (environment.conceptDescriptions ?? []).find((c) => c.id === semantic);
  if (!cd) return skipped('대응하는 ConceptDescription이 없습니다. KOSMO-SME-3을 먼저 고치십시오.');

  const content = iec61360Of(cd);
  const external = policy.irdiPrefixes.some((p) => semantic.startsWith(p));

  if (external) {
    const dataType = content?.dataType;
    if (!dataType) return skipped('외부 CD에 dataType이 없어 맞출 기준이 없습니다.');
    const valueType = valueTypeFor(dataType);
    if (!valueType) {
      return skipped(`dataType ${dataType}에 대응하는 valueType이 없습니다. 사람이 판단해야 합니다.`);
    }
    const before = prop.valueType;
    if (before === valueType) return skipped('이미 일치합니다.');
    prop.valueType = valueType;
    return applied(
      `외부 표준 사전 CD를 존중해 Property의 valueType을 ${valueType}로 맞췄습니다.`,
      before,
      valueType,
    );
  }

  if (!content) return skipped('자체 CD에 IEC 61360 명세가 없습니다. KOSMO-CD-4를 먼저 고치십시오.');
  const candidates = XS_TO_DATA_TYPE[prop.valueType];
  if (!candidates) {
    return skipped(`valueType ${prop.valueType}에 대응하는 dataType 매핑이 없습니다.`);
  }
  const dataType = pickDataType(candidates, content);
  if (!dataType) return skipped('KOSMO 허용 목록 안에서 고를 dataType이 없습니다.');
  const before = content.dataType;
  if (before === dataType) return skipped('이미 일치합니다.');
  content.dataType = dataType;
  return applied(`자체 CD이므로 CD의 dataType을 ${dataType}로 맞췄습니다.`, before, dataType);
};

// ── AASd-120 · SML 자식 idShort ──────────────────────────────────────────────

/**
 * SubmodelElementList 직계 자식의 idShort를 지운다.
 *
 * 정보를 지우는 교정이라 조심스럽지만, **지우는 쪽이 옳다**는 근거가 분명하다.
 * 규격이 금지하고(AASd-120), 표준 도구가 거부하며(aas-test-engines·basyx),
 * KOSMO 규칙에는 영향이 없다(검사하지 않는다). 지운 값은 applied.before에 남는다.
 */
const fixSmlChildIdShort: Fixer = ({ environment, finding }) => {
  const node = asElement(resolvePointer(environment, parentPointer(finding.pointer))?.value);
  if (!node) return skipped('대상 SubmodelElement를 찾을 수 없습니다.');
  const before = node.idShort;
  if (before === undefined) return skipped('이미 idShort가 없습니다.');

  delete node.idShort;
  return applied(
    `리스트 자식의 idShort를 지웠습니다(AASd-120). 리스트 자식은 인덱스로 가리킵니다.`,
    before,
    undefined,
  );
};

/**
 * 허용값이 아닌 category를 지운다.
 *
 * 다른 값으로 **바꾸지 않는다.** CONSTANT·PARAMETER·VARIABLE 중 무엇인지는 의미 판단이고,
 * 규격상 비워 두는 것은 아무 문제가 없다. 지운 값은 applied.before에 남는다.
 */
const fixDataElementCategory: Fixer = ({ environment, finding }) => {
  const node = asElement(resolvePointer(environment, parentPointer(finding.pointer))?.value);
  if (!node) return skipped('대상 SubmodelElement를 찾을 수 없습니다.');
  const before = node.category;
  if (before === undefined) return skipped('이미 category가 없습니다.');

  delete node.category;
  return applied(
    'category를 비웠습니다(AASd-090). 어느 값이 맞는지는 의미 판단이라 사람이 정해야 합니다.',
    before,
    undefined,
  );
};

// ── PKG-FILE-URI · PKG-LANG-DUP ──────────────────────────────────────────────

const fixFileUri: Fixer = ({ environment, finding }) => {
  const node = asElement(resolvePointer(environment, parentPointer(finding.pointer))?.value);
  if (!node || node.modelType !== 'File') return skipped('대상 File을 찾을 수 없습니다.');
  const file = node as { value?: string };
  const before = file.value;
  if (before === undefined || before === '') return skipped('값이 비어 있어 URI를 만들 수 없습니다.');
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(before)) return skipped('이미 URI 스킴이 있습니다.');

  const path = before.replace(/\\/g, '/').replace(/^\.\/+/, '');
  const after = path.startsWith('/') ? `file://${path}` : `file:///${path}`;
  file.value = after;
  return applied('File.value를 file:// URI 형식으로 바꿨습니다.', before, after);
};

/**
 * 빈 배열은 **키째로 지운다.**
 * 다른 해석이 없다 — 공식 스키마가 빈 배열을 허용하지 않고, 지워도 의미가 바뀌지 않는다.
 */
const fixEmptyArray: Fixer = ({ environment, finding }) => {
  const target = resolvePointer(environment, finding.pointer);
  if (!target) return skipped('대상 자리를 찾을 수 없습니다.');
  if (!Array.isArray(target.value)) return skipped('배열이 아닙니다.');
  if (target.value.length > 0) return skipped('이미 항목이 들어 있습니다.');

  if (Array.isArray(target.container)) {
    // 배열 안의 배열은 자리를 지우면 뒤가 밀린다 — 그런 구조는 메타모델에 없다
    return skipped('배열 안의 빈 배열은 손대지 않습니다.');
  }
  delete (target.container as Record<string, unknown>)[target.key];
  return applied(`빈 배열 ${finding.pointer}을(를) 지웠습니다.`, '[]', undefined);
};

const fixDuplicateLanguage: Fixer = ({ environment, finding }) => {
  const target = resolvePointer(environment, finding.pointer);
  const list = target?.value;
  if (!Array.isArray(list)) return skipped('대상 다국어 필드를 찾을 수 없습니다.');

  const seen = new Set<string>();
  const kept: LangString[] = [];
  const dropped: LangString[] = [];
  for (const item of list as LangString[]) {
    if (seen.has(item.language)) {
      dropped.push(item);
      continue;
    }
    seen.add(item.language);
    kept.push(item);
  }
  if (dropped.length === 0) return skipped('중복 언어 태그가 없습니다.');

  list.length = 0;
  list.push(...kept);
  return applied(
    // 텍스트는 손대지 않는다. 언어 태그 오타의 근거가 없는 상태에서 번역을 창작하면
    // KTL §7(템플릿 원본 유지)을 정면으로 어기게 된다.
    `중복 언어 태그 ${dropped.length}건을 제거했습니다(먼저 나온 항목을 남깁니다).`,
    dropped,
    kept,
  );
};

// ── 등록부 ───────────────────────────────────────────────────────────────────

/**
 * 규칙 ID → 교정 함수.
 * 실측 결함 8종을 커버하는 범위로 한정한다. 여기 없는 규칙은 사람이 판단할 몫이며,
 * applyFixes가 그 사실을 skipped에 남긴다.
 */
// ── AASd-109 · Property/Range 리스트의 valueTypeListElement ──────────────────

/**
 * 자식들의 valueType이 하나로 모이면 그것을 리스트에 적는다. 안 모이면 사람 몫.
 * 🔴 규칙이 fixable로 광고하는데 교정기가 없어 "이 규칙에는 자동 교정기가 없습니다"로 건너뛰던 자리(2026-09-11).
 *    같은 규칙 id의 다른 지적(타입 불일치·semanticId 불일치)은 판단이 필요해 손대지 않는다
 */
const fixListValueType: Fixer = ({ environment, finding }) => {
  if (!finding.pointer.endsWith('/valueTypeListElement')) {
    return skipped('리스트 안의 타입·semanticId 불일치는 어느 쪽이 맞는지 사람이 정해야 합니다.');
  }
  const list = resolvePointer(environment, parentPointer(finding.pointer))?.value as
    | { value?: { valueType?: string }[]; valueTypeListElement?: string }
    | undefined;
  if (!list) return skipped('대상 리스트를 찾을 수 없습니다.');
  const types = [...new Set((list.value ?? []).map((child) => child.valueType).filter((t): t is string => !!t))];
  if (types.length !== 1) {
    return skipped(`자식들의 valueType이 하나로 모이지 않습니다(${types.join(', ') || '없음'}) — 리스트 안의 값 타입을 먼저 통일하십시오.`);
  }
  list.valueTypeListElement = types[0];
  return applied(`valueTypeListElement를 자식들의 valueType(${types[0]})으로 지정했습니다.`, undefined, types[0]);
};

export const FIXERS: Readonly<Record<string, Fixer>> = {
  'AASd-107/108/109/114': fixListValueType,
  'KOSMO-AAS-1': fixThumbnail,
  // 같은 처치 — 파트가 있으면 가리키고, 파트·관계·Content_Types는 writeAasx가 만든다
  'PKG-THUMB-PART': fixThumbnail,
  'KOSMO-AAS-3': fixVersionConsistency,
  'KOSMO-AAS-5': fixGlobalAssetId,
  'KOSMO-AAS-6': fixAssetKind,
  'KOSMO-SM-2': fixVersionConsistency,
  'KOSMO-SM-3': fixSubmodelSemanticId,
  'KOSMO-SM-4': fixModellingKind,
  'KOSMO-SME-3': fixConceptMapping,
  'KOSMO-SME-5': fixValueTypeMatch,
  'KOSMO-CD-2': fixConceptDescriptionId,
  'KOSMO-CD-4': fixConceptDataType,
  'AASc-3a-009': fixMeasureUnit,
  'AASd-090': fixDataElementCategory,
  'AASd-120': fixSmlChildIdShort,
  'PKG-FILE-URI': fixFileUri,
  'PKG-EMPTY-ARRAY': fixEmptyArray,
  'PKG-LANG-DUP': fixDuplicateLanguage,
};

export interface ApplyFixOptions {
  /** 수렴 확인에 쓸 규칙 목록. 기본 ALL_RULES */
  rules?: readonly Rule[];
  policy?: Partial<LinterPolicy>;
  /** L1 패키지 검사·썸네일 교정에 필요하다 */
  package?: PackageContext;
  /** lint → fix 최대 반복 횟수. 기본 5 */
  maxRounds?: number;
  /** warning·info 등급 지적도 교정한다. 기본 false (error만) */
  includeWarnings?: boolean;
  /** 규칙 ID 접두로 교정 대상을 제한한다 */
  only?: string[];
  exclude?: string[];
  /** 교정 함수 교체·확장 (저작 UI에서 규칙별 사용자 정의 교정을 끼울 자리) */
  fixers?: Readonly<Record<string, Fixer>>;
  /**
   * 이 목록에 있는 (규칙, 위치)만 교정한다 — 미리보기에서 체크한 것만 반영(사용자 2026-09-11).
   * 🔴 여러 바퀴를 돌아도 같은 열쇠로 거른다: 1바퀴에서 고쳐야 드러나는 2바퀴 항목도 미리보기가
   *    같은 열쇠(규칙+위치)로 냈으므로 그대로 맞는다
   */
  select?: readonly FixSelector[];
}

function selectable(finding: Finding, options: ApplyFixOptions): boolean {
  if (!finding.fixable) return false;
  if (!options.includeWarnings && finding.severity !== 'error') return false;
  if (options.only && !options.only.some((p) => finding.ruleId.startsWith(p))) return false;
  if (options.exclude?.some((p) => finding.ruleId.startsWith(p))) return false;
  if (options.select && !options.select.some((s) => s.ruleId === finding.ruleId && s.pointer === finding.pointer)) return false;
  return true;
}

/**
 * 지적 목록을 교정한다.
 *
 * 입력 Environment는 변경하지 않는다. 한 번 고치면 가려져 있던 다음 위반이 드러나므로
 * 변화가 없을 때까지(또는 maxRounds까지) lint → fix를 반복한다.
 */
export function applyFixes(
  environment: Environment,
  findings: readonly Finding[],
  options: ApplyFixOptions = {},
): FixResult {
  const policy: LinterPolicy = { ...DEFAULT_POLICY, ...options.policy };
  const rules = options.rules ?? ALL_RULES;
  const fixers = options.fixers ?? FIXERS;
  const maxRounds = options.maxRounds ?? 5;

  const env = cloneEnvironment(environment);
  const applied: AppliedFix[] = [];
  const skippedList: SkippedFix[] = [];
  const skippedSeen = new Set<string>();
  const ledger: RelocationLedger = {};

  const note = (finding: Finding, reason: string): void => {
    const dedupe = `${finding.ruleId}|${finding.pointer}|${reason}`;
    if (skippedSeen.has(dedupe)) return;
    skippedSeen.add(dedupe);
    skippedList.push({ ruleId: finding.ruleId, pointer: finding.pointer, reason });
  };

  const lintOptions: LintOptions = {
    policy,
    ...(options.package ? { package: options.package } : {}),
  };

  let current = [...findings];
  let rounds = 0;

  while (rounds < maxRounds) {
    rounds += 1;
    let changed = 0;

    for (const finding of current) {
      if (!selectable(finding, options)) continue;

      const fixer = fixers[finding.ruleId];
      if (!fixer) {
        note(finding, '이 규칙에는 자동 교정기가 없습니다. 사람이 판단해야 합니다.');
        continue;
      }

      const input: FixInput = {
        environment: env,
        finding,
        policy,
        ledger,
        ...(options.package ? { package: options.package } : {}),
      };

      let outcome: FixOutcome;
      try {
        outcome = fixer(input);
      } catch (error) {
        // 교정 하나가 터져도 나머지는 진행한다 — 저작 UI에서 편집 세션이 통째로 죽으면 안 된다
        outcome = skipped(`교정 중 오류: ${error instanceof Error ? error.message : String(error)}`);
      }

      if (outcome.status === 'applied') {
        applied.push({
          ruleId: finding.ruleId,
          pointer: finding.pointer,
          key: finding.key,
          elementType: finding.elementType,
          description: outcome.description,
          ...(outcome.before === undefined ? {} : { before: outcome.before }),
          ...(outcome.after === undefined ? {} : { after: outcome.after }),
        });
        changed += 1;
      } else {
        note(finding, outcome.reason);
      }
    }

    if (changed === 0) break;
    current = lint(env, rules, lintOptions).findings;
  }

  return { environment: env, applied, skipped: skippedList, relocations: ledger, rounds };
}

export interface LintAndFixResult extends FixResult {
  /** 교정 전 린트 결과 */
  before: LintResult;
  /** 교정 후 린트 결과 — 수렴했는지 여기서 확인한다 */
  after: LintResult;
}

/** 린트 → 교정 → 재린트를 한 번에. 저작 UI의 "이 파일 고쳐줘" 진입점 */
export function lintAndFix(
  environment: Environment,
  options: ApplyFixOptions = {},
): LintAndFixResult {
  const policy: LinterPolicy = { ...DEFAULT_POLICY, ...options.policy };
  const rules = options.rules ?? ALL_RULES;
  const lintOptions: LintOptions = {
    policy,
    ...(options.package ? { package: options.package } : {}),
  };

  const before = lint(environment, rules, lintOptions);
  const result = applyFixes(environment, before.findings, options);
  const after = lint(result.environment, rules, lintOptions);
  return { ...result, before, after };
}


// ── 이관 대장 되돌리기 ────────────────────────────────────────────────────────

/**
 * 이관 대장의 원본 IRI로 되돌린다 — 규정 해석이 뒤집혔을 때(KOSMO가 IDTA IRI를 받기 시작하면) 쓰는 길.
 * 입력 Environment는 변경하지 않는다.
 *
 * 대장의 뜻은 교정기마다 다르다(04 명세 §5 ①):
 *  - KOSMO-SM-3: 서브모델 semanticId를 **자기 id**로 돌렸다 → 대장 키 = 서브모델 id. 되돌리기는 semanticId만 원본으로
 *  - KOSMO-CD-2: CD id 자체를 옮겼다 → 대장 키 = 새 CD id. 되돌리기는 id와 모든 참조를 원본으로
 * 🔴 둘을 구별하지 않고 id를 바꾸면 서브모델 id가 IDTA IRI로 바뀌어 버린다 — 그래서 먼저 서브모델 쪽을 본다
 */
export function revertRelocations(
  environment: Environment,
  ledger: RelocationLedger,
  only?: readonly string[],
): { environment: Environment; reverted: { iri: string; original: string; how: 'semanticId' | 'id' }[]; remaining: RelocationLedger } {
  const env = cloneEnvironment(environment);
  const remaining: RelocationLedger = { ...ledger };
  const reverted: { iri: string; original: string; how: 'semanticId' | 'id' }[] = [];
  const targets = only ?? Object.keys(ledger);
  for (const iri of targets) {
    const original = ledger[iri];
    if (original === undefined) continue;
    const sm = (env.submodels ?? []).find((s) => s.id === iri);
    if (sm && firstKeyValue(sm.semanticId) === iri) {
      sm.semanticId = { type: 'ExternalReference', keys: [{ type: 'GlobalReference', value: original }] };
      reverted.push({ iri, original, how: 'semanticId' });
    } else {
      const refs = replaceIdEverywhere(env, iri, original);
      if (refs === 0 && !(env.conceptDescriptions ?? []).some((cd) => cd.id === original)) continue; // 이미 없는 것
      reverted.push({ iri, original, how: 'id' });
    }
    delete remaining[iri];
  }
  return { environment: env, reverted, remaining };
}
