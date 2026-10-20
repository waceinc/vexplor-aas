/**
 * Hints that let a receiver pre-fill what a read-list tag means (docs/edge-contract.md §4.1): the `semanticId` of the
 * model element the tag's value belongs to, a `suggestedRole`, and `limits` taken from the same file (bounding
 * properties and Range elements).
 *
 * Important: advisory only. A receiver shows them as a starting point and a person confirms — nothing here decides how
 *    a value is used. They are left out of the list revision (read-list.ts), so a new hint never asks a site to
 *    approve its list again and an edge never restarts for one.
 * Important: the element is found with the collector's own lookup (`valuedElementIndex`, the rule of `findValuedElement`,
 *    the live overlay and runtime event sources), so a hint names exactly the element events name. A property that
 *    resolves to no element, or to more than one, gets no semanticId and the role `value` — never a guess among
 *    candidates.
 * Important: matching is by semanticId, exactly, never by idShort — an idShort is renameable and a different version
 *    suffix is a different concept. The tables below are data: add a semanticId (a KOSMO concept IRI or an eCLASS IRDI
 *    with its version) to the role or pair it means.
 * Important: a `Range` element (min · max) with the **same semanticId** as the value bounds it — the Range states the
 *    interval of that very concept, so no table is needed. Being in the same collection, or a name such as
 *    `…Range` / `…Limits`, pairs nothing: two Ranges next to two values cannot be told apart without a guess.
 */
import type { Environment, Reference } from '@aas/core';
import { valuedElementIndex } from '@aas/collector';
import { asArray, idShortOf, modelTypeOf, numberOf, topElements, walk, type Json } from '../integration/exports/elements.js';

import type { TagLimit, TagRole } from '../integration/bundle-types.js';

/** Concept descriptions of the KOSMO reference models: `https://www.smart-factory.kr/ids/cd/<Name>/1/0` */
const kosmo = (name: string): string => `https://www.smart-factory.kr/ids/cd/${name}/1/0`;

/** semanticId → role. A semanticId in none of these suggests `value` */
export const ROLE_HINTS: ReadonlyArray<{ role: Exclude<TagRole, 'value'>; semanticIds: readonly string[] }> = [
  // Running, stopped, alarm — the state a machine reports (not the operating mode AUTO / MANUAL)
  { role: 'run_state', semanticIds: ['MachineState', 'RobotState'].map(kosmo) },
  // Produced quantity that only grows (wraps or resets are the receiver's to detect)
  { role: 'counter', semanticIds: ['CycleCount', 'ProductionCount', 'CumulativeLength'].map(kosmo) },
  { role: 'alarm_source', semanticIds: ['AlarmActive', 'AlarmCode'].map(kosmo) },
  // Totals that only grow and drive maintenance or energy accounting
  { role: 'meter', semanticIds: ['CumulativeRunHours', 'CumulativeOperatingHours', 'CumulativeEnergy'].map(kosmo) },
  // Condition of the machine as text or a flag
  { role: 'condition', semanticIds: ['RollWearStatus', 'LubricationStatus', 'MaintenanceMode'].map(kosmo) },
  // Values a quality check judges
  { role: 'quality', semanticIds: ['MaterialYieldRate', 'RemainingBottomThickness', 'InterlockValue'].map(kosmo) },
];

/**
 * A measured value and the property of the same file that bounds it. One measured value may have several limits
 * (a performance limit and a safety limit) — all are listed with their source and the receiver picks.
 */
export const LIMIT_PAIRS: ReadonlyArray<{ measured: string; bound: TagLimit['bound']; limit: string }> = [
  { measured: kosmo('SettingForce'), bound: 'usl', limit: kosmo('MaxSettingForce') },
  { measured: kosmo('CurrentLineSpeed'), bound: 'usl', limit: kosmo('MaxFormingSpeed') },
  { measured: kosmo('CurrentLineSpeed'), bound: 'usl', limit: kosmo('MaxSafeLineSpeed') },
  { measured: kosmo('TCPSpeed'), bound: 'usl', limit: kosmo('MaxTCPSpeed') },
];

const ROLE_BY_SEMANTIC_ID: ReadonlyMap<string, Exclude<TagRole, 'value'>> = new Map(
  ROLE_HINTS.flatMap((hint) => hint.semanticIds.map((id) => [id, hint.role] as const)),
);

export interface TagHints {
  semanticId?: string;
  suggestedRole: TagRole;
  limits?: TagLimit[];
}

/** First key value of a semanticId — the form runtime events carry (integration/runtime/element-ref.ts) */
function firstKeyOf(element: { semanticId?: Reference }): string | undefined {
  const value = element.semanticId?.keys?.[0]?.value;
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** A Range bound as a number — undefined when absent, blank or not a finite number (never guessed) */
function boundOf(text: unknown): number | undefined {
  if (typeof text !== 'string' || text.trim() === '') return undefined;
  const value = Number(text);
  return Number.isFinite(value) ? value : undefined;
}

interface RangeFound {
  element: Json;
  min?: number;
  max?: number;
  source: string;
}

/**
 * min → lsl, max → usl. Either may be missing; an unreadable bound is left out and the other still counts.
 * Important: min above max gives nothing — one of the two is wrong and nothing says which.
 */
function rangeLimits(range: RangeFound, semanticId: string): TagLimit[] {
  if (range.min !== undefined && range.max !== undefined && range.min > range.max) return [];
  return [
    ...(range.min !== undefined ? [{ bound: 'lsl' as const, value: range.min, semanticId, source: range.source }] : []),
    ...(range.max !== undefined ? [{ bound: 'usl' as const, value: range.max, semanticId, source: range.source }] : []),
  ];
}

/**
 * Returns a lookup for the hints of one file. The limit values and the valued elements are indexed once, so a file
 * with many tags is walked once, not once per tag (the element index since 2.8.1 — before, each tag walked the file).
 */
export function tagHintsOf(environment: Environment): (propertyName: string) => TagHints {
  const limitsBySemanticId = new Map<string, { value: number; source: string }[]>();
  const wanted = new Set(LIMIT_PAIRS.map((pair) => pair.limit));
  const rangesBySemanticId = new Map<string, RangeFound[]>();
  for (const submodel of asArray(environment.submodels as unknown)) {
    for (const item of walk(topElements(submodel))) {
      const id = firstKeyOf(item.element as { semanticId?: Reference });
      if (id === undefined) continue;
      if (modelTypeOf(item.element) === 'Range') {
        const found = rangesBySemanticId.get(id) ?? [];
        const min = boundOf(item.element['min']);
        const max = boundOf(item.element['max']);
        found.push({ element: item.element, source: `${idShortOf(submodel) ?? ''}:${item.path}`, ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) });
        rangesBySemanticId.set(id, found);
        continue;
      }
      if (!wanted.has(id)) continue;
      const value = numberOf(item.element as Json);
      if (value === null) continue;
      const found = limitsBySemanticId.get(id) ?? [];
      found.push({ value, source: `${idShortOf(submodel) ?? ''}:${item.path}` });
      limitsBySemanticId.set(id, found);
    }
  }
  const elementOf = valuedElementIndex(environment);
  return (propertyName) => {
    const found = elementOf(propertyName);
    if (found === undefined || found === 'ambiguous') return { suggestedRole: 'value' };
    const semanticId = firstKeyOf(found.element as { semanticId?: Reference });
    if (semanticId === undefined) return { suggestedRole: 'value' };
    // Important: property pairs first, then Ranges — a file without a Range keeps exactly the limits it had. When both
    //    bound the value, both are listed with their source and a person picks (as for two property limits).
    const limits: TagLimit[] = [
      ...LIMIT_PAIRS.filter((pair) => pair.measured === semanticId).flatMap((pair) =>
        (limitsBySemanticId.get(pair.limit) ?? []).map((limit) => ({ bound: pair.bound, value: limit.value, semanticId: pair.limit, source: limit.source })),
      ),
      // A tag may name a Range itself (the overlay writes into Ranges too); that Range is not its own limit
      ...(rangesBySemanticId.get(semanticId) ?? []).filter((range) => range.element !== (found.element as unknown)).flatMap((range) => rangeLimits(range, semanticId)),
    ];
    return {
      semanticId,
      suggestedRole: ROLE_BY_SEMANTIC_ID.get(semanticId) ?? 'value',
      ...(limits.length > 0 ? { limits } : {}),
    };
  };
}
