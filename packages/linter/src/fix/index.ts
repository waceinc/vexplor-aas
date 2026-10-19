/**
 * Quick Fix — corrects findings the linter marked fixable, one finding at a time.
 *
 * This is not a multi-file batch-fix pipeline (decided 2026-08-21). It is designed around the authoring UI picking
 * one finding and passing it to applyFixes. Therefore
 *  - the input Environment is never mutated (cloneEnvironment, then modify)
 *  - fixes that change an id also update the references to it (replaceIdEverywhere)
 *  - the original IRI is kept in the migration ledger so the change can be reverted
 *  - when something cannot be fixed, it is not silently passed over; the reason is recorded (skipped)
 *
 * For list-type constraints, fixing one finding reveals the next, so lint → fix repeats until it converges.
 */
import { firstKeyValue, iec61360Of, XS_TO_DATA_TYPE } from '../util.js';
import { lint, type LintOptions } from '../engine.js';
import { DEFAULT_POLICY, type LinterPolicy } from '../policy.js';
import { ALL_RULES } from '../rules/index.js';
import type { Finding, LintMetamodelInput, LintResult, PackageContext, Rule } from '../types.js';
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
  fill,
  tr,
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
 * Record in the migration ledger. A new IRI that is already recorded is not overwritten —
 * even if an element is moved twice, the **very first original** must remain so it can be reverted.
 */
function record(ledger: RelocationLedger, newIri: string, oldIri: string): void {
  if (newIri === oldIri) return;
  if (ledger[newIri] === undefined) ledger[newIri] = oldIri;
}

// ── KOSMO-AAS-1 · thumbnail ──────────────────────────────────────────────────

const fixThumbnail: Fixer = ({ environment, finding, package: pkg }) => {
  const shell = shellAt(environment, finding.pointer);
  if (!shell) return skipped(tr('대상 AssetAdministrationShell을 찾을 수 없습니다.'));
  if (!pkg) {
    return skipped(
      tr('패키지 정보가 없어 썸네일 파트를 찾을 수 없습니다. AASX를 읽을 때의 opc 정보를 함께 넘기십시오.'),
    );
  }

  const part = findThumbnailPart(pkg.parts);
  if (!part) {
    return skipped(tr('패키지에 이미지 파트가 없습니다. 썸네일 파일을 먼저 추가해야 합니다.'));
  }

  const before = shell.assetInformation.defaultThumbnail;
  if (before?.path === part) return skipped(tr('이미 해당 파트를 가리키고 있습니다.'));

  const after = { path: part, contentType: imageContentType(part) };
  shell.assetInformation.defaultThumbnail = after;
  return applied(fill(tr('defaultThumbnail을 패키지 파트 {0}로 지정했습니다.'), { 0: part }), before, after);
};

// ── KOSMO-AAS-3 / KOSMO-SM-2 · administration matches the id suffix ──────────

/**
 * There are two directions, and the choice of direction is the risk level.
 *  - administration missing   : derive administration from the id (no effect on references, safe)
 *  - suffix mismatch          : fix the id and update every reference in the Environment along with it
 */
const fixVersionConsistency: Fixer = ({ environment, finding, ledger }) => {
  const item =
    shellAt(environment, finding.pointer) ?? submodelAt(environment, finding.pointer);
  if (!item) return skipped(tr('대상 Identifiable을 찾을 수 없습니다.'));

  if (finding.pointer.endsWith('/administration')) {
    const derived = versionFromId(item.id);
    if (!derived) {
      return skipped(
        fill(tr('id의 끝 두 세그먼트가 버전 형식이 아니어서 administration을 유추할 수 없습니다: {0}. version·revision을 직접 입력하십시오.'), { 0: item.id }),
      );
    }
    const before = item.administration;
    item.administration = { ...before, ...derived };
    return applied(
      fill(tr('id 접미에서 administration을 만들었습니다: version={0}, revision={1}'), { 0: derived.version, 1: derived.revision }),
      before,
      item.administration,
    );
  }

  const admin = item.administration;
  if (!admin?.version || !admin.revision) {
    return skipped(tr('administration이 없어 기대 id를 만들 수 없습니다.'));
  }

  const oldId = item.id;
  const newId = withVersionSuffix(oldId, admin.version, admin.revision);
  if (newId === oldId) return skipped(tr('이미 administration과 일치합니다.'));
  if (idExists(environment, newId, item)) {
    return skipped(fill(tr('같은 id를 쓰는 다른 요소가 있습니다: {0}'), { 0: newId }));
  }

  item.id = newId;
  const refs = replaceIdEverywhere(environment, oldId, newId);
  record(ledger, newId, oldId);
  return applied(fill(tr('id를 administration에 맞추고 참조 {0}건을 함께 갱신했습니다.'), { 0: refs }), oldId, newId);
};

// ── KOSMO-AAS-5 · globalAssetId ──────────────────────────────────────────────

const fixGlobalAssetId: Fixer = ({ environment, finding, policy }) => {
  const shell = shellAt(environment, finding.pointer);
  if (!shell) return skipped(tr('대상 AssetAdministrationShell을 찾을 수 없습니다.'));
  if (!shell.idShort) return skipped(tr('AAS에 idShort가 없어 asset IRI를 만들 수 없습니다.'));

  const { version, revision } = versionOf(shell);
  const value = `${policy.iriBase}/asset/${shell.idShort}/${version}/${revision}`;
  const before = shell.assetInformation.globalAssetId;
  if (before === value) return skipped(tr('이미 같은 값입니다.'));

  shell.assetInformation.globalAssetId = value;
  return applied(fill(tr('globalAssetId를 {0}로 지정했습니다.'), { 0: value }), before, value);
};

// ── KOSMO-AAS-6 / KOSMO-SM-4 · Type · Template ───────────────────────────────

const fixAssetKind: Fixer = ({ environment, finding }) => {
  const shell = shellAt(environment, finding.pointer);
  if (!shell) return skipped(tr('대상 AssetAdministrationShell을 찾을 수 없습니다.'));
  const before = shell.assetInformation.assetKind;
  if (before === 'Type') return skipped(tr('이미 Type입니다.'));
  shell.assetInformation.assetKind = 'Type';
  return applied(tr('assetKind를 Type으로 바꿨습니다.'), before, 'Type');
};

const fixModellingKind: Fixer = ({ environment, finding }) => {
  const sm = submodelAt(environment, finding.pointer);
  if (!sm) return skipped(tr('대상 Submodel을 찾을 수 없습니다.'));
  const before = sm.kind;
  if (before === 'Template') return skipped(tr('이미 Template입니다.'));
  sm.kind = 'Template';
  return applied(tr('kind를 Template으로 바꿨습니다.'), before, 'Template');
};

// ── KOSMO-SM-3 · Submodel semanticId ─────────────────────────────────────────

/**
 * Points semanticId back to the Submodel's own id (golden-file approach).
 * The original IRI must always be kept in the ledger — this fix moves official IDTA IRIs onto the KOSMO whitelist,
 * so if the interpretation of the regulation is overturned, this is where reverting starts.
 */
const fixSubmodelSemanticId: Fixer = ({ environment, finding, ledger }) => {
  const sm = submodelAt(environment, finding.pointer);
  if (!sm) return skipped(tr('대상 Submodel을 찾을 수 없습니다.'));

  if (finding.pointer.endsWith('/semanticId/keys/0/type')) {
    const key = sm.semanticId?.keys?.[0];
    if (!key) return skipped(tr('semanticId 키가 없습니다.'));
    const before = key.type;
    if (before === 'GlobalReference') return skipped(tr('이미 GlobalReference입니다.'));
    key.type = 'GlobalReference';
    return applied(
      tr('semanticId 키 타입을 GlobalReference로 되돌렸습니다(basyx가 서브모델을 버리지 않게).'),
      before,
      'GlobalReference',
    );
  }

  const before = firstKeyValue(sm.semanticId);
  if (before === sm.id) return skipped(tr('이미 자신의 id를 가리키고 있습니다.'));

  sm.semanticId = {
    type: 'ExternalReference',
    keys: [{ type: 'GlobalReference', value: sm.id }],
  };
  if (before !== undefined) record(ledger, sm.id, before);

  return applied(
    before === undefined
      ? fill(tr('semanticId를 자신의 id({0})로 지정했습니다.'), { 0: sm.id })
      : tr('semanticId를 자신의 id로 옮기고 원본 IRI를 이관 대장에 기록했습니다.'),
    before,
    sm.id,
  );
};

// ── KOSMO-CD-2 · ConceptDescription id ───────────────────────────────────────

const fixConceptDescriptionId: Fixer = ({ environment, finding, policy, ledger }) => {
  const cd = conceptDescriptionAt(environment, finding.pointer);
  if (!cd) return skipped(tr('대상 ConceptDescription을 찾을 수 없습니다.'));
  if (!cd.idShort) {
    return skipped(tr('CD에 idShort가 없어 새 id를 만들 수 없습니다. KOSMO-CD-1을 먼저 고치십시오.'));
  }

  const { version, revision } = versionOf(cd);
  const oldId = cd.id;
  const newId = `${policy.iriBase}/cd/${cd.idShort}/${version}/${revision}`;
  if (newId === oldId) return skipped(tr('이미 규약에 맞는 id입니다.'));
  if (idExists(environment, newId, cd)) {
    return skipped(
      fill(tr('같은 idShort의 CD가 이미 {0}를 쓰고 있습니다. 중복 CD를 하나로 합친 뒤 다시 시도하십시오.'), { 0: newId }),
    );
  }

  cd.id = newId;
  const refs = replaceIdEverywhere(environment, oldId, newId);
  record(ledger, newId, oldId);
  return applied(
    fill(tr('CD id를 자체 IRI 규약으로 옮기고 참조 {0}건을 갱신했습니다. 원본은 이관 대장에 남겼습니다.'), { 0: refs }),
    oldId,
    newId,
  );
};

// ── KOSMO-CD-4 · dataType ────────────────────────────────────────────────────

const fixConceptDataType: Fixer = ({ environment, finding }) => {
  const cd = conceptDescriptionAt(environment, finding.pointer);
  if (!cd) return skipped(tr('대상 ConceptDescription을 찾을 수 없습니다.'));

  if (finding.pointer.endsWith('/embeddedDataSpecifications')) {
    if (!cd.idShort) return skipped(tr('CD에 idShort가 없어 데이터 명세를 만들 수 없습니다.'));
    if (iec61360Of(cd)) return skipped(tr('이미 IEC 61360 명세가 있습니다.'));
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
    return applied(tr('IEC 61360 데이터 명세를 STRING으로 만들었습니다.'), undefined, content);
  }

  const content = iec61360Of(cd);
  if (!content) return skipped(tr('IEC 61360 명세가 없습니다.'));
  const before = content.dataType;
  if (before === 'STRING') return skipped(tr('이미 STRING입니다.'));
  content.dataType = 'STRING';
  return applied(
    before === undefined
      ? tr('dataType을 STRING으로 지정했습니다.')
      : fill(tr('허용 목록 밖 dataType({0})을 STRING으로 정규화했습니다.'), { 0: before }),
    before,
    'STRING',
  );
};

// ── KOSMO-SME-3 · semanticId to CD mapping ───────────────────────────────────

/** Singular form of a list name — same naming as the golden file (Markings → Marking · Documents → Document) */
function singularOf(name: string): string {
  if (/ies$/.test(name)) return name.replace(/ies$/, 'y');
  if (/s$/.test(name) && name.length > 3) return name.slice(0, -1);
  return `${name}Entry`;
}

const fixConceptMapping: Fixer = ({ environment, finding, policy }) => {
  const nodePointer = parentPointer(finding.pointer);
  const node = asElement(resolvePointer(environment, nodePointer)?.value);
  if (!node) return skipped(tr('대상 SubmodelElement를 찾을 수 없습니다.'));

  const existing = firstKeyValue(node.semanticId);
  let targetId = existing;
  let assigned = false;
  /** Name to use when creating a new CD — list children have no idShort, so borrow it from the parent list */
  let cdName = node.idShort;
  let borrowed = false;
  // Important: list children have no idShort (typically after the AASd-120 fix). Previously skipped as "no idShort, cannot create",
  //    so the button said "N items" but opening it showed "needs human judgment" (user, 2026-09-11). Borrow from the parent list:
  //    the name is the singular of the parent name (Markings → Marking — golden-file naming); if there is no semanticId at all,
  //    look first at the parent's semanticIdListElement (the semanticId for all children)
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
      if (!cdName) return skipped(tr('idShort가 없고 부모 리스트에서도 이름을 빌릴 수 없어 CD id를 만들 수 없습니다.'));
      // With a borrowed name, if a CD with the same name already exists (golden file's Marking — standard dictionary IRDI), point to it.
      // Elements with their own name still get a fresh convention IRI as before — never attach arbitrarily to a dictionary entry that merely shares the name
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
      return skipped(tr('idShort가 없어 ConceptDescription을 만들 수 없습니다.'));
    }
    cds.push(makeConceptDescription(targetId, cdName, inferDataType(node)));
  }

  if (!assigned && already) return skipped(tr('이미 대응하는 ConceptDescription이 있습니다.'));

  // Do not stitch sentence fragments together — English word order differs, so translate whole sentences
  const sentence = !already
    ? assigned
      ? tr('semanticId를 지정하고 ConceptDescription을 생성했습니다: {0}. 정의는 idShort를 그대로 둔 자리표시자이므로 개발계획서 원문으로 대체하십시오.')
      : tr('ConceptDescription을 생성했습니다: {0}. 정의는 idShort를 그대로 둔 자리표시자이므로 개발계획서 원문으로 대체하십시오.')
    : tr('semanticId를 지정했습니다: {0}. 정의는 idShort를 그대로 둔 자리표시자이므로 개발계획서 원문으로 대체하십시오.');
  return applied(
    fill(sentence, { 0: targetId }),
    existing,
    targetId,
  );
};

// ── AASc-3a-009 · MEASURE without a unit ─────────────────────────────────────

/** MEASURE family → COUNT family, which needs no unit */
const MEASURE_TO_COUNT = {
  REAL_MEASURE: 'REAL_COUNT',
  INTEGER_MEASURE: 'INTEGER_COUNT',
  RATIONAL_MEASURE: 'RATIONAL',
} as const satisfies Record<string, NonNullable<ReturnType<typeof iec61360Of>>['dataType']>;

/**
 * Important: **never invent a unit.** We do not know whether "12.5" is kW or A,
 *    and a value with the wrong unit is more dangerous than one with none.
 *
 * The spec offers two paths, and only one is ours to take.
 *   ① Write the unit — only a human can do this
 *   ② Downgrade dataType to the COUNT family, which needs no unit ← this one
 *
 * So we downgrade, but **state clearly that it must be reverted if it is a measured value** (same stance as the
 * KOSMO-SME-3 placeholder). CURRENCY is left alone — a unit is intrinsic to currency, so there is nothing to downgrade to.
 */
const fixMeasureUnit: Fixer = ({ environment, finding }) => {
  const cd = conceptDescriptionAt(environment, finding.pointer);
  if (!cd) return skipped(tr('대상 ConceptDescription을 찾을 수 없습니다.'));
  const content = iec61360Of(cd);
  if (!content) return skipped(tr('IEC 61360 명세가 없습니다.'));
  if (content.unit || content.unitId) return skipped(tr('이미 단위가 있습니다.'));

  const before = content.dataType;
  const after =
    before === undefined
      ? undefined
      : MEASURE_TO_COUNT[before as keyof typeof MEASURE_TO_COUNT];
  if (!after) {
    return skipped(
      before === undefined
        ? tr('알 수 없는 dataType은 단위를 빼고 표현할 수 없습니다 — 단위를 직접 넣으십시오.')
        : fill(tr('{0} dataType은 단위를 빼고 표현할 수 없습니다 — 단위를 직접 넣으십시오.'), { 0: before }),
    );
  }
  content.dataType = after;
  return applied(
    fill(tr('단위를 모르므로 dataType을 {0} → {1}로 낮췄습니다. 주의 — 실제로 단위가 있는 측정값이라면 unit을 넣고 {0}로 되돌리십시오.'), { 0: before, 1: after }),
    before,
    after,
  );
};

// ── KOSMO-SME-5 · valueType and dataType consistency ─────────────────────────

/**
 * The fix direction is **opposite** depending on where the CD comes from.
 *  - external standard dictionary (IRDI) CD : respect the original and align our Property.valueType
 *  - our own CD                             : align the CD's dataType to the Property
 */
const fixValueTypeMatch: Fixer = ({ environment, finding, policy }) => {
  const node = asElement(resolvePointer(environment, parentPointer(finding.pointer))?.value);
  if (!node || node.modelType !== 'Property') return skipped(tr('대상 Property를 찾을 수 없습니다.'));
  const prop = node as Property;

  const semantic = firstKeyValue(prop.semanticId);
  if (semantic === undefined) return skipped(tr('semanticId가 없습니다. KOSMO-SME-3을 먼저 고치십시오.'));

  const cd = (environment.conceptDescriptions ?? []).find((c) => c.id === semantic);
  if (!cd) return skipped(tr('대응하는 ConceptDescription이 없습니다. KOSMO-SME-3을 먼저 고치십시오.'));

  const content = iec61360Of(cd);
  const external = policy.irdiPrefixes.some((p) => semantic.startsWith(p));

  if (external) {
    const dataType = content?.dataType;
    if (!dataType) return skipped(tr('외부 CD에 dataType이 없어 맞출 기준이 없습니다.'));
    const valueType = valueTypeFor(dataType);
    if (!valueType) {
      return skipped(fill(tr('dataType {0}에 대응하는 valueType이 없습니다. 사람이 판단해야 합니다.'), { 0: dataType }));
    }
    const before = prop.valueType;
    if (before === valueType) return skipped(tr('이미 일치합니다.'));
    prop.valueType = valueType;
    return applied(
      fill(tr('외부 표준 사전 CD는 그대로 두고 Property의 valueType을 {0}로 맞췄습니다.'), { 0: valueType }),
      before,
      valueType,
    );
  }

  if (!content) return skipped(tr('자체 CD에 IEC 61360 명세가 없습니다. KOSMO-CD-4를 먼저 고치십시오.'));
  const candidates = XS_TO_DATA_TYPE[prop.valueType];
  if (!candidates) {
    return skipped(fill(tr('valueType {0}에 대응하는 dataType 매핑이 없습니다.'), { 0: prop.valueType }));
  }
  const dataType = pickDataType(candidates, content);
  if (!dataType) return skipped(tr('KOSMO 허용 목록 안에서 고를 dataType이 없습니다.'));
  const before = content.dataType;
  if (before === dataType) return skipped(tr('이미 일치합니다.'));
  content.dataType = dataType;
  return applied(fill(tr('자체 CD이므로 CD의 dataType을 {0}로 맞췄습니다.'), { 0: dataType }), before, dataType);
};

// ── AASd-120 · idShort of SML children ───────────────────────────────────────

/**
 * Removes the idShort of direct children of a SubmodelElementList.
 *
 * This fix deletes information, so it needs care, but the case that **deleting is right** is clear:
 * the spec forbids it (AASd-120), standard tools reject it (aas-test-engines · basyx),
 * and KOSMO rules are unaffected (they do not check it). The removed value is kept in applied.before.
 */
const fixSmlChildIdShort: Fixer = ({ environment, finding }) => {
  const node = asElement(resolvePointer(environment, parentPointer(finding.pointer))?.value);
  if (!node) return skipped(tr('대상 SubmodelElement를 찾을 수 없습니다.'));
  const before = node.idShort;
  if (before === undefined) return skipped(tr('이미 idShort가 없습니다.'));

  delete node.idShort;
  return applied(
    tr('리스트 자식의 idShort를 지웠습니다(AASd-120). 리스트 자식은 인덱스로 가리킵니다.'),
    before,
    undefined,
  );
};

/**
 * Removes a category that is not an allowed value.
 *
 * It is **not replaced** with another value. Whether it is CONSTANT, PARAMETER or VARIABLE is a semantic judgment,
 * and leaving it empty is perfectly fine under the spec. The removed value is kept in applied.before.
 */
const fixDataElementCategory: Fixer = ({ environment, finding }) => {
  const node = asElement(resolvePointer(environment, parentPointer(finding.pointer))?.value);
  if (!node) return skipped(tr('대상 SubmodelElement를 찾을 수 없습니다.'));
  const before = node.category;
  if (before === undefined) return skipped(tr('이미 category가 없습니다.'));

  delete node.category;
  return applied(
    tr('category를 비웠습니다(AASd-090). 어느 값이 맞는지는 의미 판단이라 사람이 정해야 합니다.'),
    before,
    undefined,
  );
};

// ── PKG-FILE-URI · PKG-LANG-DUP ──────────────────────────────────────────────

const fixFileUri: Fixer = ({ environment, finding }) => {
  const node = asElement(resolvePointer(environment, parentPointer(finding.pointer))?.value);
  if (!node || node.modelType !== 'File') return skipped(tr('대상 File을 찾을 수 없습니다.'));
  const file = node as { value?: string };
  const before = file.value;
  if (before === undefined || before === '') return skipped(tr('값이 비어 있어 URI를 만들 수 없습니다.'));
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(before)) return skipped(tr('이미 URI 스킴이 있습니다.'));

  const path = before.replace(/\\/g, '/').replace(/^\.\/+/, '');
  const after = path.startsWith('/') ? `file://${path}` : `file:///${path}`;
  file.value = after;
  return applied(tr('File.value를 file:// URI 형식으로 바꿨습니다.'), before, after);
};

/**
 * Empty arrays are **removed together with their key.**
 * There is no other reading — the official schema does not allow empty arrays, and removing them does not change meaning.
 */
const fixEmptyArray: Fixer = ({ environment, finding }) => {
  const target = resolvePointer(environment, finding.pointer);
  if (!target) return skipped(tr('대상 자리를 찾을 수 없습니다.'));
  if (!Array.isArray(target.value)) return skipped(tr('배열이 아닙니다.'));
  if (target.value.length > 0) return skipped(tr('이미 항목이 들어 있습니다.'));

  if (Array.isArray(target.container)) {
    // Removing an entry from an array nested in an array would shift the rest — no such structure exists in the metamodel
    return skipped(tr('배열 안의 빈 배열은 손대지 않습니다.'));
  }
  delete (target.container as Record<string, unknown>)[target.key];
  return applied(fill(tr('빈 배열 {0}을(를) 지웠습니다.'), { 0: finding.pointer }), '[]', undefined);
};

const fixDuplicateLanguage: Fixer = ({ environment, finding }) => {
  const target = resolvePointer(environment, finding.pointer);
  const list = target?.value;
  if (!Array.isArray(list)) return skipped(tr('대상 다국어 필드를 찾을 수 없습니다.'));

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
  if (dropped.length === 0) return skipped(tr('중복 언어 태그가 없습니다.'));

  list.length = 0;
  list.push(...kept);
  return applied(
    // Text is left untouched. Inventing a translation without evidence of what the language-tag typo should be
    // would directly violate KTL §7 (keep the template original).
    fill(tr('중복 언어 태그 {0}건을 제거했습니다(먼저 나온 항목을 남깁니다).'), { 0: dropped.length }),
    dropped,
    kept,
  );
};

// ── Registry ─────────────────────────────────────────────────────────────────

/**
 * Rule ID → fix function.
 * Limited to covering the 8 measured defect types. Rules not listed here are for a human to judge,
 * and applyFixes records that in skipped.
 */
// ── AASd-109 · valueTypeListElement of Property/Range lists ──────────────────

/**
 * If the children's valueType converges on one value, write it on the list. If not, it is for a human.
 * Important: the rule advertised itself as fixable but had no fixer, so it was skipped with "this rule has no automatic fixer" (2026-09-11).
 *    Other findings under the same rule id (type mismatch · semanticId mismatch) need judgment and are left untouched
 */
const fixListValueType: Fixer = ({ environment, finding }) => {
  if (!finding.pointer.endsWith('/valueTypeListElement')) {
    return skipped(tr('리스트 안의 타입·semanticId 불일치는 어느 쪽이 맞는지 사람이 정해야 합니다.'));
  }
  const list = resolvePointer(environment, parentPointer(finding.pointer))?.value as
    | { value?: { valueType?: string }[]; valueTypeListElement?: string }
    | undefined;
  if (!list) return skipped(tr('대상 리스트를 찾을 수 없습니다.'));
  const types = [...new Set((list.value ?? []).map((child) => child.valueType).filter((t): t is string => !!t))];
  if (types.length !== 1) {
    return skipped(fill(tr('자식들의 valueType이 하나로 모이지 않습니다({0}) — 리스트 안의 값 타입을 먼저 통일하십시오.'), { 0: types.join(', ') || tr('없음') }));
  }
  list.valueTypeListElement = types[0];
  return applied(fill(tr('valueTypeListElement를 자식들의 valueType({0})으로 지정했습니다.'), { 0: types[0] }), undefined, types[0]);
};

export const FIXERS: Readonly<Record<string, Fixer>> = {
  'AASd-107/108/109/114': fixListValueType,
  'KOSMO-AAS-1': fixThumbnail,
  // Same treatment — point to the part if it exists; writeAasx creates the part, relationships and Content_Types
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
  /** Rules used to check convergence. Default ALL_RULES */
  rules?: readonly Rule[];
  policy?: Partial<LinterPolicy>;
  /** Needed for L1 package checks and the thumbnail fix */
  package?: PackageContext;
  /** Metamodel version of the file — the re-lint between rounds must judge by the same version as the first lint */
  metamodel?: LintMetamodelInput;
  /** Maximum number of lint → fix rounds. Default 5 */
  maxRounds?: number;
  /** Also fix warning- and info-level findings. Default false (errors only) */
  includeWarnings?: boolean;
  /** Restrict fix targets by rule ID prefix */
  only?: string[];
  exclude?: string[];
  /** Replace or extend fix functions (the hook where the authoring UI plugs in custom per-rule fixes) */
  fixers?: Readonly<Record<string, Fixer>>;
  /**
   * Fix only the (rule, location) pairs in this list — apply only what was checked in the preview (user, 2026-09-11).
   * Important: the same key filters across multiple rounds: round-2 items that only appear after round-1 fixes were also
   *    produced by the preview with the same key (rule + location), so they still match
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
 * Fixes a list of findings.
 *
 * The input Environment is not mutated. Each fix can reveal a violation that was hidden behind it, so
 * lint → fix repeats until nothing changes (or until maxRounds).
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
    ...(options.metamodel ? { metamodel: options.metamodel } : {}),
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
        note(finding, tr('이 규칙에는 자동 교정기가 없습니다. 사람이 판단해야 합니다.'));
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
        // If one fix throws, the rest continue — the authoring UI's editing session must not die as a whole
        outcome = skipped(fill(tr('교정 중 오류: {0}'), { 0: error instanceof Error ? error.message : String(error) }));
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
  /** Lint result before fixing */
  before: LintResult;
  /** Lint result after fixing — check here whether it converged */
  after: LintResult;
}

/** Lint → fix → re-lint in one call. Entry point for the authoring UI's "fix this file" */
export function lintAndFix(
  environment: Environment,
  options: ApplyFixOptions = {},
): LintAndFixResult {
  const policy: LinterPolicy = { ...DEFAULT_POLICY, ...options.policy };
  const rules = options.rules ?? ALL_RULES;
  const lintOptions: LintOptions = {
    policy,
    ...(options.package ? { package: options.package } : {}),
    ...(options.metamodel ? { metamodel: options.metamodel } : {}),
  };

  const before = lint(environment, rules, lintOptions);
  const result = applyFixes(environment, before.findings, options);
  const after = lint(result.environment, rules, lintOptions);
  return { ...result, before, after };
}


// ── Reverting via the migration ledger ───────────────────────────────────────

/**
 * Reverts to the original IRIs in the migration ledger — the path to use when the regulation's interpretation is overturned
 * (if KOSMO starts accepting IDTA IRIs). The input Environment is not mutated.
 *
 * What the ledger means differs per fixer (04 spec §5 ①):
 *  - KOSMO-SM-3: the submodel's semanticId was pointed at **its own id** → ledger key = submodel id. Reverting restores only semanticId
 *  - KOSMO-CD-2: the CD id itself was moved → ledger key = new CD id. Reverting restores the id and every reference
 * Important: changing the id without distinguishing the two would turn the submodel id into the IDTA IRI — so the submodel side is checked first
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
      if (refs === 0 && !(env.conceptDescriptions ?? []).some((cd) => cd.id === original)) continue; // already gone
      reverted.push({ iri, original, how: 'id' });
    }
    delete remaining[iri];
  }
  return { environment: env, reverted, remaining };
}
