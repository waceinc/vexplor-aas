/**
 * External references — validation, saving and the opt-in projection into `specificAssetIds` (design D1, D2, §4.5).
 *
 * The sidecar document (store, not AASX) is authoritative. AASX files leave the company, so ERP numbers stay out of
 * them unless a person publishes a ref. A published ref is written into the package's first AAS as
 * `{ name: "<system>:<type>", value: id }` through a normal `updateIdentifiable` under cause `external-refs` — history,
 * undo and a `model.shell.updated` event follow the same path as any edit. Cost centres and sensitive refs are never
 * published (validation refuses `publish` on them, the projection skips them anyway).
 */
import { currentChange, runWithChange, type AasStore, type ExternalRef, type ExternalRefsDoc, type ExternalRefSubject, type Versioned } from '@aas/store';
import { fill, tr, type ConfigError, type ParseResult } from '@aas/core';
import { ApiError } from '../http.js';
import { asArray, asRecord, assetInformationOf, shellsOf, type Json } from './exports/elements.js';
import { isPublicRef } from './exports/join.js';
import { integrationStore, type IntegrationAasStore } from './exports/store.js';

export const EXTERNAL_REFS_SCHEMA = 'vexplor.externalRefs/1';
const SUBJECT_KINDS = ['asset', 'bomChild', 'consumable', 'tool'] as const;
const REF_KEYS = ['system', 'type', 'id', 'publish', 'sensitive', 'externalSubjectId', 'syncedAt', 'source'] as const;
const MAX_TEXT = 200;
/**
 * Reference types with a fixed spelling. A type matching one of them in another case is stored in this spelling, so
 * `CostCenter` cannot slip past the cost-centre rules (review L7). Other types are free text and kept as given.
 */
export const KNOWN_REF_TYPES = ['equipment', 'plant', 'functionalLocation', 'workCenter', 'costCenter', 'material', 'equipmentCode'] as const;

export function canonicalRefType(type: string): string {
  return KNOWN_REF_TYPES.find((known) => known.toLowerCase() === type.toLowerCase()) ?? type;
}

export function emptyExternalRefs(): ExternalRefsDoc {
  return { schema: EXTERNAL_REFS_SCHEMA, subjects: [] };
}

function escapePointer(key: string): string {
  return key.replace(/~/g, '~0').replace(/\//g, '~1');
}

/** Strict parse of a PUT body: unknown fields, empty texts, `|` in a system, `publish` on cost centres are errors */
export function parseExternalRefsDoc(input: unknown): ParseResult<ExternalRefsDoc> {
  const errors: ConfigError[] = [];
  const fail = (path: string, message: string): void => void errors.push({ path: path === '' ? '/' : path, message });
  const object = (value: unknown, path: string, allowed: readonly string[]): Json | undefined => {
    const record = asRecord(value);
    if (!record) return void fail(path, tr('객체여야 합니다.'));
    for (const key of Object.keys(record)) if (!allowed.includes(key)) fail(`${path}/${escapePointer(key)}`, tr('알 수 없는 항목입니다.'));
    return record;
  };
  const text = (value: unknown, path: string): string | undefined => {
    if (typeof value !== 'string' || value.trim() === '') return void fail(path, tr('비어 있지 않은 문자열이어야 합니다.'));
    if (value.length > MAX_TEXT) return void fail(path, fill(tr('{0}자 이하여야 합니다.'), { 0: MAX_TEXT }));
    return value;
  };
  const flag = (value: unknown, path: string): boolean | undefined => {
    if (value === undefined) return undefined;
    if (typeof value !== 'boolean') return void fail(path, tr('true 또는 false여야 합니다.'));
    return value;
  };

  const root = object(input, '', ['schema', 'subjects', 'managedSpecificAssetIds']);
  if (!root) return { ok: false, errors };
  if (root['schema'] !== EXTERNAL_REFS_SCHEMA) fail('/schema', fill(tr('schema는 {0}이어야 합니다.'), { 0: EXTERNAL_REFS_SCHEMA }));
  if (!Array.isArray(root['subjects'])) fail('/subjects', tr('배열이어야 합니다.'));
  const subjects: ExternalRefSubject[] = [];
  const seenSubjects = new Set<string>();

  (Array.isArray(root['subjects']) ? root['subjects'] : []).forEach((rawEntry: unknown, i: number) => {
    const base = `/subjects/${i}`;
    const entry = object(rawEntry, base, ['subject', 'refs']);
    if (!entry) return;
    const rawSubject = object(entry['subject'], `${base}/subject`, ['kind', 'globalAssetId', 'key']);
    const kind = rawSubject?.['kind'];
    if (rawSubject && !SUBJECT_KINDS.includes(kind as (typeof SUBJECT_KINDS)[number])) {
      fail(`${base}/subject/kind`, fill(tr('다음 중 하나여야 합니다: {0}'), { 0: SUBJECT_KINDS.join(', ') }));
    }
    const globalAssetId = rawSubject ? text(rawSubject['globalAssetId'], `${base}/subject/globalAssetId`) : undefined;
    const needsKey = kind === 'consumable' || kind === 'tool';
    const key = needsKey && rawSubject ? text(rawSubject['key'], `${base}/subject/key`) : undefined;
    if (!needsKey && rawSubject?.['key'] !== undefined) fail(`${base}/subject/key`, tr('이 종류의 대상에는 key를 쓰지 않습니다.'));

    const refs: ExternalRef[] = [];
    const seenRefs = new Set<string>();
    if (!Array.isArray(entry['refs'])) fail(`${base}/refs`, tr('배열이어야 합니다.'));
    (Array.isArray(entry['refs']) ? entry['refs'] : []).forEach((rawRef: unknown, j: number) => {
      const path = `${base}/refs/${j}`;
      const ref = object(rawRef, path, REF_KEYS);
      if (!ref) return;
      const system = text(ref['system'], `${path}/system`);
      if (system?.includes('|')) fail(`${path}/system`, tr('system에는 |를 쓸 수 없습니다.'));
      const rawType = text(ref['type'], `${path}/type`);
      const type = rawType === undefined ? undefined : canonicalRefType(rawType);
      const id = text(ref['id'], `${path}/id`);
      const publish = flag(ref['publish'], `${path}/publish`);
      const sensitive = flag(ref['sensitive'], `${path}/sensitive`);
      if (publish && type === 'costCenter') fail(`${path}/publish`, tr('원가 센터(costCenter)는 공개(publish)할 수 없습니다.'));
      if (publish && sensitive) fail(`${path}/publish`, tr('민감(sensitive) 참조는 공개(publish)할 수 없습니다.'));
      const optional = (name: 'externalSubjectId' | 'syncedAt' | 'source'): string | undefined =>
        ref[name] === undefined ? undefined : text(ref[name], `${path}/${name}`);
      const externalSubjectId = optional('externalSubjectId');
      const syncedAt = optional('syncedAt');
      const source = optional('source');
      if (system === undefined || type === undefined || id === undefined) return;
      const pair = `${system}|${type}`;
      if (seenRefs.has(pair)) fail(path, fill(tr('같은 대상에 같은 system·type 참조가 두 번 있습니다: {0}'), { 0: pair }));
      seenRefs.add(pair);
      refs.push({
        system,
        type,
        id,
        ...(publish !== undefined ? { publish } : {}),
        ...(sensitive !== undefined ? { sensitive } : {}),
        ...(externalSubjectId !== undefined ? { externalSubjectId } : {}),
        ...(syncedAt !== undefined ? { syncedAt } : {}),
        ...(source !== undefined ? { source } : {}),
      });
    });

    if (globalAssetId === undefined || !SUBJECT_KINDS.includes(kind as (typeof SUBJECT_KINDS)[number]) || (needsKey && key === undefined)) return;
    const subject = (needsKey
      ? { kind, globalAssetId, key }
      : { kind, globalAssetId }) as ExternalRefSubject['subject'];
    const subjectKey = `${kind as string}|${globalAssetId}|${key ?? ''}`;
    if (seenSubjects.has(subjectKey)) fail(`${base}/subject`, tr('같은 대상이 두 번 있습니다.'));
    seenSubjects.add(subjectKey);
    subjects.push({ subject, refs });
  });

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { schema: EXTERNAL_REFS_SCHEMA, subjects } };
}

export interface ProjectedId {
  name: string;
  value: string;
}

export interface Projection {
  content: Json;
  added: ProjectedId[];
  removed: ProjectedId[];
  managed: string[];
  changed: boolean;
}

/** The specificAssetId a published ref becomes */
function specificAssetIdOf(ref: ExternalRef): Json {
  return {
    name: `${ref.system}:${ref.type}`,
    value: ref.id,
    ...(ref.externalSubjectId
      ? { externalSubjectId: { type: 'ExternalReference', keys: [{ type: 'GlobalReference', value: ref.externalSubjectId }] } }
      : {}),
  };
}

/**
 * New shell content with the published refs of its asset. Entries this projection put there before (`managed`) and no
 * longer published are removed; an entry with the same name is replaced; every other specificAssetId is untouched.
 */
export function projectSpecificAssetIds(shell: Json, doc: ExternalRefsDoc, previouslyManaged: readonly string[]): Projection {
  const content = structuredClone(shell);
  const info = assetInformationOf(content);
  const globalAssetId = info['globalAssetId'];
  const desired = new Map<string, Json>();
  for (const entry of doc.subjects) {
    if (entry.subject.kind !== 'asset' || entry.subject.globalAssetId !== globalAssetId) continue;
    for (const ref of entry.refs) if (ref.publish === true && isPublicRef(ref)) desired.set(`${ref.system}:${ref.type}`, specificAssetIdOf(ref));
  }
  const managedBefore = new Set(previouslyManaged);
  const added: ProjectedId[] = [];
  const removed: ProjectedId[] = [];
  const used = new Set<string>();
  const next: Json[] = [];
  const pair = (item: Json): ProjectedId => ({ name: String(item['name']), value: String(item['value']) });

  for (const item of asArray(info['specificAssetIds'])) {
    const name = typeof item['name'] === 'string' ? item['name'] : '';
    const wanted = desired.get(name);
    if (wanted && !used.has(name)) {
      used.add(name);
      if (JSON.stringify(wanted) !== JSON.stringify(item)) {
        removed.push(pair(item));
        added.push(pair(wanted));
      }
      next.push(wanted);
    } else if (wanted || managedBefore.has(name)) {
      removed.push(pair(item));
    } else next.push(item);
  }
  for (const [name, wanted] of desired) {
    if (used.has(name)) continue;
    next.push(wanted);
    added.push(pair(wanted));
  }
  // The V3.0 schema does not allow empty arrays
  if (next.length > 0) info['specificAssetIds'] = next;
  else delete info['specificAssetIds'];
  content['assetInformation'] = info;
  return { content, added, removed, managed: [...desired.keys()].sort(), changed: added.length > 0 || removed.length > 0 };
}

export interface SaveResult {
  value: ExternalRefsDoc;
  revision: number;
  projected: { added: ProjectedId[]; removed: ProjectedId[] };
}

interface PreparedSave {
  packageId: string;
  doc: ExternalRefsDoc;
  expectedRevision: number;
  shell: Json | undefined;
  projection: Projection | undefined;
}

/** Validates subjects against the package and computes the projection — writes nothing */
async function prepareSave(store: IntegrationAasStore, packageId: string, doc: ExternalRefsDoc, expectedRevision: number): Promise<PreparedSave> {
  const environment = await store.getEnvironment(packageId);
  const shells = shellsOf(environment);
  const assets = new Set(shells.map((shell) => assetInformationOf(shell)['globalAssetId']).filter((id): id is string => typeof id === 'string'));
  doc.subjects.forEach((entry, i) => {
    if (entry.subject.kind === 'asset' && !assets.has(entry.subject.globalAssetId)) {
      throw new ApiError(400, 'BadRequest', fill(tr('/subjects/{0}: 이 패키지의 자산이 아닙니다: {1}'), { 0: i, 1: entry.subject.globalAssetId }));
    }
  });
  const previous: Versioned<ExternalRefsDoc> | undefined = await store.getExternalRefs(packageId);
  const shell = shells[0];
  const projection = shell ? projectSpecificAssetIds(shell, doc, previous?.value.managedSpecificAssetIds ?? []) : undefined;
  const managed = projection?.managed ?? previous?.value.managedSpecificAssetIds ?? [];
  const toStore: ExternalRefsDoc = { schema: EXTERNAL_REFS_SCHEMA, subjects: doc.subjects, ...(managed.length > 0 ? { managedSpecificAssetIds: managed } : {}) };
  return { packageId, doc: toStore, expectedRevision, shell, projection };
}

/**
 * Saves several packages' docs **all or nothing** (one store batch: revision checks, uniqueness), then projects the
 * published refs into each shell. Throws `ConflictError` (stale revision), `ExternalRefConflictError` (claimed
 * elsewhere) or `NotFoundError` before anything is written.
 *
 * `onWritten` runs with the packages whose docs were stored — also when a later shell projection fails, so the caller
 * can still audit, invalidate caches and re-project what changed (review M4).
 */
export async function saveExternalRefsBatch(
  store: AasStore,
  items: readonly { packageId: string; doc: ExternalRefsDoc; expectedRevision: number }[],
  onWritten?: (packageIds: string[]) => Promise<void>,
): Promise<SaveResult[]> {
  const full = integrationStore(store);
  const prepared: PreparedSave[] = [];
  for (const item of items) prepared.push(await prepareSave(full, item.packageId, item.doc, item.expectedRevision));
  const saved = await full.putExternalRefsBatch(prepared.map((entry) => ({ packageId: entry.packageId, doc: entry.doc, expectedRevision: entry.expectedRevision })));
  try {
    const change = currentChange();
    for (const entry of prepared) {
      if (!entry.shell || !entry.projection?.changed) continue;
      const content = entry.projection.content;
      const shellId = String(entry.shell['id']);
      await runWithChange({ ...change, cause: 'external-refs' }, () => full.updateIdentifiable(entry.packageId, 'AssetAdministrationShell', shellId, content));
    }
  } finally {
    await onWritten?.(prepared.map((entry) => entry.packageId));
  }
  return prepared.map((entry, i) => ({
    value: saved[i]!.value,
    revision: saved[i]!.revision,
    projected: { added: entry.projection?.added ?? [], removed: entry.projection?.removed ?? [] },
  }));
}

/** One package — a batch of one */
export async function saveExternalRefs(
  store: AasStore,
  packageId: string,
  doc: ExternalRefsDoc,
  expectedRevision: number,
  onWritten?: (packageIds: string[]) => Promise<void>,
): Promise<SaveResult> {
  return (await saveExternalRefsBatch(store, [{ packageId, doc, expectedRevision }], onWritten))[0]!;
}
