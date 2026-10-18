/**
 * **Read-only overlay** of collected values.
 *
 * Why: BaSyx's DataBridge **writes values read from OPC UA into the Submodel** so that
 * other systems can see current values through the standard API (`GET …/$value`).
 * We use value sync **Option A** (the file is the source of truth) and store collected values only in the
 * time series — so until now, external systems reading our Part 2 API saw only an **AAS with empty values**.
 * This gap must be filled before we can claim to replace BaSyx.
 *
 * Important: even so, we do not write back into the model. Latest values are placed **only in the response** —
 *    the file stays unchanged and history stays intact. Matches BaSyx's outward behavior without breaking Option A.
 * Important: this function **does not modify its input.** It builds and returns a new object (this package's contract).
 * Important: off by default. Enabled **only when the request explicitly sets** `live=true` —
 *    silently mixing file values with field values would be worse.
 */
import type { Environment, Submodel, SubmodelElement } from '@aas/core';
import type { ValueSample } from './types.js';

export type OverlayOutcome = 'applied' | 'ambiguous' | 'unmatched';

export interface OverlayNote {
  propertyName: string;
  outcome: OverlayOutcome;
  /** Overlaid location (idShortPath). All of them if there are several */
  paths: string[];
  observedAt?: string;
  quality?: string;
}

export interface OverlayResult<T> {
  content: T;
  notes: OverlayNote[];
  /** Number of elements whose value was actually changed */
  applied: number;
}

/**
 * Keeps only the **most recent** sample per (interface, name) from the time series.
 * Important: a failed read (2.8.0 — `error`, no value) is skipped. Overlaying it would blank the element; the model view
 *    keeps the last value that was read, as it did before failures were stored.
 */
export function latestByProperty(samples: readonly ValueSample[]): Map<string, ValueSample> {
  const latest = new Map<string, ValueSample>();
  for (const sample of samples) {
    if (sample.error !== undefined) continue;
    const previous = latest.get(sample.propertyName);
    if (!previous || sample.observedAt > previous.observedAt) latest.set(sample.propertyName, sample);
  }
  return latest;
}

/** Whether the element kind can hold a value — container elements are not overlaid */
const VALUED = new Set(['Property', 'Range', 'Blob', 'File', 'MultiLanguageProperty']);

function childrenOf(node: SubmodelElement): SubmodelElement[] {
  const record = node as unknown as Record<string, unknown>;
  if (node.modelType === 'SubmodelElementCollection' || node.modelType === 'SubmodelElementList') {
    return Array.isArray(record['value']) ? (record['value'] as SubmodelElement[]) : [];
  }
  if (node.modelType === 'Entity') {
    return Array.isArray(record['statements']) ? (record['statements'] as SubmodelElement[]) : [];
  }
  return [];
}

/** Converts a collected value to the element's representation — a Property value is text (per spec) */
function textOf(sample: ValueSample): string {
  if (sample.valueText !== undefined) return sample.valueText;
  if (sample.valueNumber !== undefined) return String(sample.valueNumber);
  return '';
}

interface Found {
  node: Record<string, unknown>;
  path: string;
}

/** Finds by idShort. The AID property name is the element idShort (AID convention) */
function findByIdShort(elements: readonly SubmodelElement[], name: string, prefix: string): Found[] {
  const out: Found[] = [];
  elements.forEach((element, index) => {
    const idShort = element.idShort ?? `[${index}]`;
    const path = prefix === '' ? idShort : `${prefix}.${idShort}`;
    if (element.idShort === name && VALUED.has(element.modelType)) {
      out.push({ node: element as unknown as Record<string, unknown>, path });
    }
    out.push(...findByIdShort(childrenOf(element), name, path));
  });
  return out;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function applyTo(elements: readonly SubmodelElement[], latest: Map<string, ValueSample>): {
  notes: OverlayNote[];
  applied: number;
} {
  const notes: OverlayNote[] = [];
  let applied = 0;

  for (const [name, sample] of latest) {
    const found = findByIdShort(elements, name, '');
    if (found.length === 0) {
      notes.push({ propertyName: name, outcome: 'unmatched', paths: [] });
      continue;
    }
    if (found.length > 1) {
      // Important: do not overlay when names collide. Field values landing in the wrong element is the worst outcome
      notes.push({
        propertyName: name,
        outcome: 'ambiguous',
        paths: found.map((entry) => entry.path),
      });
      continue;
    }
    const target = found[0]!;
    target.node['value'] = textOf(sample);
    applied += 1;
    notes.push({
      propertyName: name,
      outcome: 'applied',
      paths: [target.path],
      observedAt: sample.observedAt,
      ...(sample.quality === undefined ? {} : { quality: sample.quality }),
    });
  }
  return { notes, applied };
}

/** Where a collected property lands in the model — the same element `overlayEnvironment` would write to */
export interface ValuedElementLocation {
  submodelId: string;
  /** Part 2 idShortPath (`Collection.Property`, list items as `List[0]`) */
  idShortPath: string;
  element: SubmodelElement;
  /** Key steps from the submodel down to the element: idShort, or the index for an item of a SubmodelElementList */
  steps: { modelType: string; value: string }[];
}

/**
 * Finds the element a collected property name resolves to, by the **same rule** as the overlay (idShort match among
 * valued elements, unique across the whole Environment). Used by the integration events to name the model element a
 * runtime event is about (`source.submodelId` / `idShortPath` / `semanticId`).
 * Important: 'ambiguous' and undefined are answers, not errors — a name that is not unique must not be pinned to one
 *    of its candidates, exactly as the overlay refuses to write it.
 */
export function findValuedElement(environment: Environment, name: string): ValuedElementLocation | 'ambiguous' | undefined {
  const found: ValuedElementLocation[] = [];
  type Step = ValuedElementLocation['steps'][number];
  const walk = (submodelId: string, elements: readonly SubmodelElement[], prefix: string, inList: boolean, steps: Step[]): void => {
    elements.forEach((element, index) => {
      const path = inList ? `${prefix}[${index}]` : prefix === '' ? (element.idShort ?? '') : `${prefix}.${element.idShort ?? ''}`;
      const chain = [...steps, { modelType: element.modelType, value: inList ? String(index) : (element.idShort ?? '') }];
      if (element.idShort === name && VALUED.has(element.modelType)) found.push({ submodelId, idShortPath: path, element, steps: chain });
      walk(submodelId, childrenOf(element), path, element.modelType === 'SubmodelElementList', chain);
    });
  };
  for (const submodel of environment.submodels ?? []) walk(submodel.id, submodel.submodelElements ?? [], '', false, []);
  if (found.length === 0) return undefined;
  return found.length === 1 ? found[0] : 'ambiguous';
}

/**
 * Collects names of elements that collected values **can be overlaid onto**.
 *
 * Important: the rule (`VALUED`) is kept **in the same place** as the overlay. Counting separately in another file
 *    lets the rules diverge — observed: tag descriptors (SMC) inside the AID were counted too and unrelated names were flagged as conflicts.
 *    The AID's `MotorSpeed` is a SubmodelElementCollection, so no value is overlaid on it and it is not a conflict.
 *
 * @param exceptSubmodelId Excludes this submodel (when duplicates within it are handled elsewhere)
 */
export function valuedNames(
  environment: Environment,
  exceptSubmodelId?: string,
): string[] {
  const names: string[] = [];
  const walk = (elements: readonly SubmodelElement[]): void => {
    for (const element of elements) {
      if (element.idShort !== undefined && VALUED.has(element.modelType)) names.push(element.idShort);
      walk(childrenOf(element));
    }
  };
  for (const submodel of environment.submodels ?? []) {
    if (exceptSubmodelId !== undefined && submodel.id === exceptSubmodelId) continue;
    walk(submodel.submodelElements ?? []);
  }
  return names;
}

/** Overlays onto a single submodel (returns a copy) */
export function overlaySubmodel(
  submodel: Submodel,
  samples: readonly ValueSample[],
): OverlayResult<Submodel> {
  const copy = clone(submodel);
  const { notes, applied } = applyTo(copy.submodelElements ?? [], latestByProperty(samples));
  return { content: copy, notes, applied };
}

/**
 * Overlays onto the whole Environment (returns a copy).
 *
 * Important: duplicate detection is **Environment-wide**. Counting per submodel makes the same name in
 *    different submodels each count as "unique within it", so **both get overwritten** — this was an observed bug.
 *    Concretely: the nameplate's `ManufacturerName` and a newly created collection item with the same name.
 *    The field value then **overwrites the nameplate**, turning the manufacturer name into a measurement.
 *    The rule "field values landing in the wrong element is the worst outcome" was leaking across submodel boundaries.
 */
export function overlayEnvironment(
  environment: Environment,
  samples: readonly ValueSample[],
): OverlayResult<Environment> {
  const copy = clone(environment);
  const latest = latestByProperty(samples);
  const notes: OverlayNote[] = [];
  let applied = 0;

  for (const [name, sample] of latest) {
    // Gather matches from every submodel. The path is prefixed with the submodel name so a person can locate it
    const found: Found[] = [];
    for (const submodel of copy.submodels ?? []) {
      const label = submodel.idShort ?? submodel.id;
      for (const entry of findByIdShort(submodel.submodelElements ?? [], name, '')) {
        found.push({ node: entry.node, path: `${label}.${entry.path}` });
      }
    }

    if (found.length === 0) {
      notes.push({ propertyName: name, outcome: 'unmatched', paths: [] });
      continue;
    }
    if (found.length > 1) {
      notes.push({
        propertyName: name,
        outcome: 'ambiguous',
        paths: found.map((entry) => entry.path),
      });
      continue;
    }
    const target = found[0]!;
    target.node['value'] = textOf(sample);
    applied += 1;
    notes.push({
      propertyName: name,
      outcome: 'applied',
      paths: [target.path],
      observedAt: sample.observedAt,
      ...(sample.quality === undefined ? {} : { quality: sample.quality }),
    });
  }

  return { content: copy, notes, applied };
}
