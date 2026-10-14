/**
 * Creates the **slots in the model that AID tags map onto** — the other half of a collection connection.
 *
 * Why: once an AID exists, collection works. But for values to be served via the standard API (`?live=true`)
 * or OPC UA exposure (M6 · M7), **the model must contain an element with the same idShort**.
 * Until now, if missing, we only warned via `nameMisses` — the user had to create each
 * Property by hand in the tree. With dozens of tags, that means giving up.
 *
 * Important: placement follows the **KTL rule**: `OperationalData[SM] > major group[SMC] > minor group[SMC] > [Prop]`
 *    (docs/rules/01_KTL_모델링_규칙.md §2-2). The golden file has exactly this shape —
 *    `ProcessMonitoring > FormingParameter > CurrentLineSpeed`. A flat structure breaks the rule.
 * Important: the semanticId is a **ModelReference + ConceptDescription key**. That is what the golden file shows,
 *    and with the wrong key type basyx drops the whole submodel (CLAUDE.md six items §3).
 *    This **differs** from the AID terms (ExternalReference/GlobalReference) — do not confuse them.
 * Important: **existing elements are never touched.** They may hold values or may have been edited by a person.
 */
import { fill, tr } from '@aas/core';
import type { AidTagInput } from './aid-build.js';

const IEC61360 =
  'https://admin-shell.io/DataSpecificationTemplates/DataSpecificationIec61360/3/0';

/** AID WoT type → AAS xs data type */
export function runtimeValueType(type: string | undefined): string {
  switch (type) {
    case 'integer':
      return 'xs:int';
    case 'boolean':
      return 'xs:boolean';
    case 'string':
      return 'xs:string';
    // Important: the default is xs:double. The AID form's default type is float, and
    //    most collected values are measurements, so falling back to string would mean fixing everything later
    default:
      return 'xs:double';
  }
}

/**
 * xs data type → IEC61360 dataType (KOSMO-SME-5).
 * Important: using STRING for everything makes every numeric item a violation — the linter flags it on creation (observed).
 *    The allowed table is XS_TO_DATA_TYPE in `@aas/linter`; we use its first value.
 */
const IEC_DATA_TYPE: Record<string, string> = {
  'xs:double': 'REAL_MEASURE',
  'xs:int': 'INTEGER_COUNT',
  'xs:boolean': 'BOOLEAN',
  'xs:string': 'STRING',
};

/**
 * Important: `*_MEASURE` **requires a unit** (AASc-3a-009). If you cannot tell whether "12.5" is kW or A,
 *    nobody else can use the value, so the spec enforces it.
 *
 *    Declaring MEASURE without a known unit produces **3 violations on creation** (observed).
 *    Inventing a unit is worse — a value with a wrong unit is more dangerous than one with none.
 *    The spec offers one path: **if the unit is unknown, downgrade to COUNT.** Same as the linter's fix guidance.
 */
function measureOrCount(dataType: string, hasUnit: boolean): string {
  if (hasUnit) return dataType;
  if (dataType === 'REAL_MEASURE') return 'REAL_COUNT';
  if (dataType === 'INTEGER_MEASURE') return 'INTEGER_COUNT';
  return dataType;
}

/**
 * KOSMO-SME-4 treats **an empty value as a violation** (OperationalData is not exempt).
 *
 * Important: this is not fabricating values. The output is a Type/Template and this field holds **example data** —
 *    the golden file also contains examples such as `CurrentLineSpeed = 18.5`. Once collection is attached,
 *    real values replace it in `?live=true` and OPC UA exposure (the file itself is unchanged — Option A).
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
  /** Major-group SMC — e.g. ProcessMonitoring */
  group: string;
  /** Minor-group SMC — e.g. CollectedValues */
  subgroup: string;
  tags: readonly AidTagInput[];
  /**
   * Important: **names already used anywhere in the file.** Without this, a name that exists in another submodel
   *    (e.g. DigitalNameplate) gets created again here, and since it is unclear where collected values belong,
   *    **neither gets them** (`overlayEnvironment` judges it ambiguous). This was hit in practice.
   */
  takenNames?: readonly string[];
}

export class RuntimeBuildError extends Error {}

/** semanticId pointing to our own-IRI CD — same form as the golden file */
function conceptRef(iriBase: string, idShort: string): Record<string, unknown> {
  return {
    type: 'ModelReference',
    keys: [{ type: 'ConceptDescription', value: `${iriBase}/cd/${idShort}/1/0` }],
  };
}

/**
 * CD for an equipment-specific item. No `isCaseOf` —
 * it exists because the standard dictionary has no counterpart, so there is no original to point to (the golden file has none either).
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
            // i18n-ignore — ko slot of an AAS multi-language value (the en slot is separately right below)
            { language: 'ko', text: `수집 항목 ${idShort}` },
            { language: 'en', text: idShort },
          ],
        },
      },
    ],
  };
}

/** One tag → one Property */
export function runtimeProperty(iriBase: string, tag: AidTagInput): Record<string, unknown> {
  const valueType = runtimeValueType(tag.type);
  return {
    modelType: 'Property',
    idShort: tag.name,
    semanticId: conceptRef(iriBase, tag.name),
    valueType,
    // Important: example-data slot — leaving it empty violates KOSMO-SME-4. See the EXAMPLE_VALUE note above
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
    [tr('대분류'), input.group],
    [tr('소분류'), input.subgroup],
  ] as const) {
    if (!NAME_PATTERN.test(name)) {
      throw new RuntimeBuildError(
        fill(tr('{0} 이름은 영문으로 시작하고 영문·숫자·밑줄만 씁니다: {1}'), { 0: label, 1: name }),
      );
    }
  }
  for (const tag of input.tags) {
    if (!NAME_PATTERN.test(tag.name)) {
      throw new RuntimeBuildError(fill(tr('태그 이름이 요소 이름으로 쓸 수 없습니다: {0}'), { 0: tag.name }));
    }
  }
}

export interface MergeResult {
  /** Updated submodel (copy) */
  submodel: Record<string, unknown>;
  /** Names of newly created Properties */
  added: string[];
  /** Names left untouched because they already exist in this submodel */
  kept: string[];
  /** Important: names not created because they already exist in **another submodel** — creating them would leave the value nowhere */
  conflicts: string[];
  /** CDs that must be created alongside */
  conceptDescriptions: Record<string, unknown>[];
}

/**
 * Child list. Important: a Submodel uses `submodelElements`, everything below uses `value` —
 * checking only one breaks the "already exists" check entirely (observed: an existing item was recreated and the original overwritten).
 */
function children(node: unknown): Record<string, unknown>[] {
  const record = node as { value?: unknown; submodelElements?: unknown } | undefined;
  const list = record?.submodelElements ?? record?.value;
  return Array.isArray(list) ? (list as Record<string, unknown>[]) : [];
}

/** Whether this idShort already exists anywhere in this submodel — at any depth */
function hasName(node: unknown, name: string): boolean {
  for (const child of children(node)) {
    if (child['idShort'] === name) return true;
    if (hasName(child, name)) return true;
  }
  return false;
}

/**
 * Merges collection items into OperationalData.
 *
 * Important: **existing names are left as they are.** They may hold values, or a person may already have created
 *    them elsewhere — in that case, as long as the name matches, collected values land there anyway.
 *    Overwriting would erase that person's work.
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
      // Exists in another submodel — creating it here too would collide and the value would land **in neither**
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

  // Major group → minor group: reuse if present, otherwise create
  const roots = children(copy);
  let group = roots.find((node) => node['idShort'] === input.group);
  if (!group) {
    group = smc(input.iriBase, input.group, []);
    // Important: the V3.0 schema rejects empty arrays. It is always filled below
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

  // No duplicate CDs — check both previously created and just-created ones
  const concepts: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  for (const name of [input.group, input.subgroup, ...fresh.map((tag) => tag.name)]) {
    if (seen.has(name)) continue;
    seen.add(name);
    const tag = fresh.find((item) => item.name === name);
    // Major/minor groups are containers with no data type — left as STRING (SME-5 only checks Properties)
    concepts.push(
      runtimeConcept(input.iriBase, name, tag?.unit, tag ? runtimeValueType(tag.type) : undefined),
    );
  }

  return { submodel: copy, added, kept, conflicts, conceptDescriptions: concepts };
}
