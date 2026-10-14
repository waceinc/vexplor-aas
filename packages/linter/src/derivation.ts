/**
 * Type -> unit propagation - when a type (master) file is edited, push the change down to the unit files while
 * preserving values edited on site (2026-10-13).
 *
 * The concept comes from digital-twin production use (about 300 machines at Speefox) - equipment values are treated as
 * "master + diff"; when the master changes, it is compared against the master copy last propagated, only what changed is
 * pushed down, and anything touched on site is skipped (digital-twin_AAS_참조분석_2026-10-13.md §2-1).
 * No code was ported; it was rewritten as a three-way comparison.
 *
 * Three values are compared - base (the type at the last propagation), theirs (the current type), mine (the current unit).
 *   type changed (base != theirs) and unit still equals base -> apply
 *   type changed and unit also differs from base -> skip (value edited on site) - if it changed to the same value, already applied
 *   newly added in type and absent in unit -> insert (skip if the parent slot is missing)
 *   removed from type and unit still equals base -> remove; if edited, skip
 *
 * The comparison key is **submodel idShort + element path**. Ids are renamed when a unit is created (clone.ts), so ids do not match up.
 * What is compared is the value fields of leaf elements (value, min, max, contentType, valueType). Containers (collection, list,
 * Entity) are compared by position only. Reference values renamed during cloning (Asset address, etc.) differ from base in the
 * unit from the start and are skipped as "unit-specific values" - which is correct.
 */
import type { Environment } from '@aas/core';

type Node = Record<string, unknown>;

/** Deep copy - the model is JSON so this is enough (the linter is shared by browser and Node, so it does not rely on structuredClone) */
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Path -> comparison string. Containers produce only `{"modelType":…}` */
export type DerivationSnapshot = Record<string, Record<string, string>>;

export type ChangeKind = 'changed' | 'added' | 'removed';
export type ChangeAction = 'apply' | 'skip' | 'same';
export type SkipReason = 'edited-here' | 'parent-missing' | 'submodel-missing';

export interface DerivationChange {
  /** Unique key - `submodelIdShort/path` */
  key: string;
  submodel: string;
  path: string;
  kind: ChangeKind;
  action: ChangeAction;
  reason?: SkipReason;
  /** Human-readable value - absent means the slot does not exist */
  base?: string;
  theirs?: string;
  mine?: string;
}

const LEAF_FIELDS = ['value', 'min', 'max', 'contentType', 'valueType'] as const;

function childrenOf(node: Node): { field: string; items: Node[]; list: boolean } | undefined {
  const type = node['modelType'];
  if (type === 'SubmodelElementCollection' || type === 'SubmodelElementList') {
    const value = node['value'];
    return Array.isArray(value) ? { field: 'value', items: value as Node[], list: type === 'SubmodelElementList' } : { field: 'value', items: [], list: type === 'SubmodelElementList' };
  }
  if (type === 'Entity') {
    const statements = node['statements'];
    return { field: 'statements', items: Array.isArray(statements) ? (statements as Node[]) : [], list: false };
  }
  return undefined;
}

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value as Node).sort().map((key) => [key, sorted((value as Node)[key])]));
  }
  return value;
}

/** Comparison string for one element - value fields for leaves, kind only for containers */
export function comparable(element: Node): string {
  if (childrenOf(element)) return JSON.stringify({ modelType: element['modelType'] });
  const picked: Node = { modelType: element['modelType'] };
  for (const field of LEAF_FIELDS) if (element[field] !== undefined) picked[field] = element[field];
  return JSON.stringify(sorted(picked));
}

/** Human-readable value - used as-is in the table */
export function readable(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const parsed = JSON.parse(text) as Node;
  if (parsed['value'] === undefined && parsed['min'] === undefined && parsed['max'] === undefined) return `(${String(parsed['modelType'])})`;
  if (parsed['min'] !== undefined || parsed['max'] !== undefined) return `${String(parsed['min'] ?? '')}~${String(parsed['max'] ?? '')}`;
  const value = parsed['value'];
  if (Array.isArray(value)) return value.map((entry) => `${String((entry as Node)['language'])}: ${String((entry as Node)['text'])}`).join(' · ');
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function walk(items: Node[], prefix: string, list: boolean, visit: (path: string, element: Node) => void): void {
  items.forEach((element, index) => {
    const segment = list ? `[${index}]` : String(element['idShort'] ?? `[${index}]`);
    const path = list ? `${prefix}${segment}` : prefix ? `${prefix}.${segment}` : segment;
    visit(path, element);
    const children = childrenOf(element);
    if (children) walk(children.items, path, children.list, visit);
  });
}

/** Environment -> per submodel idShort, path -> comparison string */
export function snapshotOf(environment: Environment): DerivationSnapshot {
  const out: DerivationSnapshot = {};
  for (const submodel of (environment.submodels ?? []) as unknown as Node[]) {
    const name = String(submodel['idShort'] ?? submodel['id']);
    const entries: Record<string, string> = {};
    const elements = submodel['submodelElements'];
    if (Array.isArray(elements)) walk(elements as Node[], '', false, (path, element) => (entries[path] = comparable(element)));
    out[name] = entries;
  }
  return out;
}

const parentOf = (path: string): string => {
  const list = /\[\d+\]$/.exec(path);
  if (list) return path.slice(0, list.index);
  const dot = path.lastIndexOf('.');
  return dot < 0 ? '' : path.slice(0, dot);
};

/** Is everything under the path (including itself) equal to base - when removing, do not remove if edited values are mixed in */
function subtreeSame(base: Record<string, string>, mine: Record<string, string>, path: string): boolean {
  const under = (entries: Record<string, string>): string =>
    JSON.stringify(
      Object.keys(entries)
        .filter((key) => key === path || key.startsWith(`${path}.`) || key.startsWith(`${path}[`))
        .sort()
        .map((key) => [key, entries[key]]),
    );
  return under(base) === under(mine);
}

/**
 * Propagation plan. Pairs submodels by idShort - submodels that exist only in the unit (collection links, etc.) are ignored.
 * "Already equal" (same) entries are not included in the result either - only what a person needs to see.
 */
export function planDerivation(base: DerivationSnapshot, theirsEnv: Environment, mineEnv: Environment): DerivationChange[] {
  const theirs = snapshotOf(theirsEnv);
  const mine = snapshotOf(mineEnv);
  const changes: DerivationChange[] = [];
  for (const submodel of Object.keys(theirs)) {
    const t = theirs[submodel]!;
    const b = base[submodel] ?? {};
    const m = mine[submodel];
    const touched = new Set([...Object.keys(t), ...Object.keys(b)]);
    for (const path of [...touched].sort()) {
      const bv = b[path];
      const tv = t[path];
      if (bv === tv) continue; // The type is unchanged
      const key = `${submodel}/${path}`;
      const mv = m?.[path];
      const shown = { ...(bv !== undefined ? { base: readable(bv)! } : {}), ...(tv !== undefined ? { theirs: readable(tv)! } : {}), ...(mv !== undefined ? { mine: readable(mv)! } : {}) };
      if (!m) {
        changes.push({ key, submodel, path, kind: bv === undefined ? 'added' : tv === undefined ? 'removed' : 'changed', action: 'skip', reason: 'submodel-missing', ...shown });
        continue;
      }
      if (bv !== undefined && tv !== undefined) {
        if (mv === tv) continue; // Already the same value
        changes.push({ key, submodel, path, kind: 'changed', ...(mv === bv ? { action: 'apply' as const } : { action: 'skip' as const, reason: 'edited-here' as const }), ...shown });
      } else if (bv === undefined && tv !== undefined) {
        if (mv === tv) continue;
        if (mv !== undefined) {
          changes.push({ key, submodel, path, kind: 'added', action: 'skip', reason: 'edited-here', ...shown });
          continue;
        }
        const parent = parentOf(path);
        // If the parent is also being inserted this time, it comes along with the parent - do not insert it separately
        if (parent !== '' && b[parent] === undefined && t[parent] !== undefined) continue;
        if (parent !== '' && m[parent] === undefined) {
          changes.push({ key, submodel, path, kind: 'added', action: 'skip', reason: 'parent-missing', ...shown });
          continue;
        }
        changes.push({ key, submodel, path, kind: 'added', action: 'apply', ...shown });
      } else if (bv !== undefined && tv === undefined) {
        if (mv === undefined) continue;
        // If the parent is also removed, it goes along with the parent
        const parent = parentOf(path);
        if (parent !== '' && b[parent] !== undefined && t[parent] === undefined) continue;
        changes.push({ key, submodel, path, kind: 'removed', ...(subtreeSame(b, m, path) ? { action: 'apply' as const } : { action: 'skip' as const, reason: 'edited-here' as const }), ...shown });
      }
    }
  }
  return changes;
}

/** The element at the path, its parent list, and its position */
function locate(submodel: Node, path: string): { holder: Node[]; index: number; element?: Node } | undefined {
  let items = (submodel['submodelElements'] ?? (submodel['submodelElements'] = [])) as Node[];
  const segments = path.match(/[^.[\]]+|\[\d+\]/g) ?? [];
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i]!;
    const list = /^\[(\d+)\]$/.exec(segment);
    const index = list ? Number(list[1]) : items.findIndex((element) => element['idShort'] === segment);
    const last = i === segments.length - 1;
    if (last) return { holder: items, index: index < 0 ? items.length : index, ...(items[index] ? { element: items[index] } : {}) };
    const next = items[index];
    if (!next) return undefined;
    const children = childrenOf(next);
    if (!children) return undefined;
    items = (next[children.field] ?? (next[children.field] = [])) as Node[];
  }
  return undefined;
}

/**
 * Insert position - **right after** the nearest preceding sibling in the type that also exists in the unit. If none, at the start.
 * List children are named by their index, so they are inserted at that index.
 */
function insertionIndex(fromHolder: Node[], fromIndex: number, intoHolder: Node[], path: string): number {
  if (/\[\d+\]$/.test(path)) return Math.min(fromIndex, intoHolder.length);
  for (let i = fromIndex - 1; i >= 0; i -= 1) {
    const name = fromHolder[i]?.['idShort'];
    const at = intoHolder.findIndex((element) => element['idShort'] === name);
    if (at >= 0) return at + 1;
  }
  return 0;
}

function findSubmodel(environment: Environment, name: string): Node | undefined {
  return ((environment.submodels ?? []) as unknown as Node[]).find((sm) => String(sm['idShort'] ?? sm['id']) === name);
}

/**
 * A new environment with the selected "apply" changes applied to the unit. The original is left untouched.
 * Order: removals (from the back) -> updates -> inserts.
 */
export function applyDerivation(mineEnv: Environment, theirsEnv: Environment, changes: readonly DerivationChange[]): Environment {
  const next = clone(mineEnv);
  const chosen = changes.filter((change) => change.action === 'apply');
  const removals = chosen.filter((c) => c.kind === 'removed').sort((a, b) => b.path.localeCompare(a.path, undefined, { numeric: true }));
  for (const change of removals) {
    const submodel = findSubmodel(next, change.submodel);
    const spot = submodel ? locate(submodel, change.path) : undefined;
    if (spot?.element) spot.holder.splice(spot.index, 1);
  }
  for (const change of chosen.filter((c) => c.kind === 'changed')) {
    const target = findSubmodel(next, change.submodel);
    const source = findSubmodel(theirsEnv, change.submodel);
    const into = target ? locate(target, change.path)?.element : undefined;
    const from = source ? locate(source, change.path)?.element : undefined;
    if (!into || !from) continue;
    for (const field of LEAF_FIELDS) {
      if (from[field] === undefined) delete into[field];
      else into[field] = clone(from[field]);
    }
  }
  for (const change of chosen.filter((c) => c.kind === 'added').sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true }))) {
    const target = findSubmodel(next, change.submodel);
    const source = findSubmodel(theirsEnv, change.submodel);
    const origin = source ? locate(source, change.path) : undefined;
    const from = origin?.element;
    const spot = target ? locate(target, change.path) : undefined;
    if (!origin || !from || !spot || spot.element) continue;
    spot.holder.splice(insertionIndex(origin.holder, origin.index, spot.holder, change.path), 0, clone(from));
  }
  return next;
}

/**
 * The base after propagation - the current type becomes the reference. However, "apply" rows that were not selected keep the
 * old base - so they show up again as "to apply" next time (overwriting with the current type would make them look like
 * on-site edits and bury them for good).
 */
export function nextSnapshot(base: DerivationSnapshot, theirsEnv: Environment, changes: readonly DerivationChange[], appliedKeys: ReadonlySet<string>): DerivationSnapshot {
  const out = clone(snapshotOf(theirsEnv));
  for (const change of changes) {
    if (change.action !== 'apply' || appliedKeys.has(change.key)) continue;
    const entries = (out[change.submodel] ??= {});
    const old = base[change.submodel]?.[change.path];
    if (old === undefined) delete entries[change.path];
    else entries[change.path] = old;
  }
  return out;
}
