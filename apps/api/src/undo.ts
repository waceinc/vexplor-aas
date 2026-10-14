/**
 * Undo / Redo — per package.
 *
 * What users wanted was "a back button for when I make a mistake". Per-submodel history (history/restore)
 * existed, but ① you had to know which submodel's history to open and ② you had to pick a timestamp, so "press once
 * to undo what I just did" was not possible.
 *
 * Approach: **snapshot the whole Environment right before any model-changing request** (the api.ts dispatcher does this).
 * Any kind of change (value edit, delete, reorder, duplicate, auto-fix, AID, import) is reverted the same way —
 * we do not write an inverse for each operation. On undo, we **compare the current state with the snapshot per Identifiable**
 * and update/create/delete only what differs. So an undo is also recorded as a normal change in submodel history.
 *
 * Limitations (deliberate choices):
 *  - Memory only. Restarting the server clears it — undo means "just now, right here".
 *    Persistent history is kept separately by store.history.
 *  - Attachments, thumbnails and package names are not covered. Only the model (Environment).
 *    The exception is "sidecars" — files that change together with the model. Format propagation (routes/derivation.ts) changes the values and
 *    the format copy (baseline) together; undoing only the values left the baseline at the new format values, so the format change wrongly
 *    looked like "values edited on this unit" (observed on screen 2026-10-14). Only such requests snapshot and restore their sidecars too.
 *  - Changes made by others are reverted too (the package is a shared work item, with no per-user separation).
 *  - A deleted Identifiable that is restored is appended to the end of the array (it gets a new ordinal). Order may not be
 *    lossless on export, but the content is intact.
 */
import type { Environment } from '@aas/core';
import { ENVIRONMENT_FIELD, type AasStore, type IdentifiableModelType, type PackageFileRecord } from '@aas/store';
import { fill, tr } from '@aas/core';

export const UNDO_DEPTH = 30;

export interface Snapshot {
  /** The Environment at that time. Kept as a string for comparison */
  json: string;
  /** Human-readable change description — "what is being undone" */
  label: string;
  takenAt: string;
  /**
   * Sidecars — present only for requests that opted to snapshot them. The file at that time per part, or null if it did not exist.
   * Sidecars are rolled back only when returning to a snapshot that has this field (other undos leave the link untouched)
   */
  files?: Record<string, PackageFileRecord | null>;
}

export interface UndoStatus {
  /** Most recent first */
  undo: string[];
  redo: string[];
}

interface Stacks {
  undo: Snapshot[];
  redo: Snapshot[];
}

export class UndoStack {
  private readonly stacks = new Map<string, Stacks>();

  constructor(
    private readonly store: AasStore,
    private readonly depth = UNDO_DEPTH,
    /** Parts that can be snapshotted as sidecars (e.g. the format copy) */
    private readonly sidecars: readonly string[] = [],
  ) {}

  /**
   * Snapshot the current state. undefined if the package does not exist.
   *
   * If `actorName` is given it is appended to the description — the undo list then shows "who" in addition to
   * "what". Since it is a shared work item, changes by others pile into the same stack.
   * Important: do not pass it when re-snapshotting (commit/shift) — appending to an already-suffixed description would duplicate it.
   */
  async capture(packageId: string, label: string, actorName?: string, withFiles = false): Promise<Snapshot | undefined> {
    if (!(await this.store.getPackage(packageId))) return undefined;
    const environment = await this.store.getEnvironment(packageId);
    const described = actorName === undefined ? label : `${label} — ${actorName}`;
    const snapshot: Snapshot = { json: JSON.stringify(environment), label: described, takenAt: new Date().toISOString() };
    if (withFiles && this.sidecars.length > 0) {
      const files = await this.store.packageFiles(packageId);
      snapshot.files = Object.fromEntries(
        this.sidecars.map((part) => [part, files.find((file) => file.part === part) ?? null]),
      );
    }
    return snapshot;
  }

  /**
   * After a change request finishes — if the model actually changed, push the previous snapshot and clear redo.
   * (Requests that only bump the revision while the model stays the same, such as collection or attachments, are not pushed)
   */
  async commit(packageId: string, before: Snapshot): Promise<boolean> {
    const after = await this.capture(packageId, before.label);
    if (!after || after.json === before.json) return false;
    const stacks = this.of(packageId);
    stacks.undo.unshift(before);
    if (stacks.undo.length > this.depth) stacks.undo.length = this.depth;
    stacks.redo = [];
    return true;
  }

  status(packageId: string): UndoStatus {
    const stacks = this.stacks.get(packageId);
    return {
      undo: stacks?.undo.map((s) => s.label) ?? [],
      redo: stacks?.redo.map((s) => s.label) ?? [],
    };
  }

  /** Returns the description of the undone change. undefined if there is none */
  async undo(packageId: string): Promise<string | undefined> {
    return this.shift(packageId, 'undo');
  }

  async redo(packageId: string): Promise<string | undefined> {
    return this.shift(packageId, 'redo');
  }

  forget(packageId: string): void {
    this.stacks.delete(packageId);
  }

  private of(packageId: string): Stacks {
    let stacks = this.stacks.get(packageId);
    if (!stacks) {
      stacks = { undo: [], redo: [] };
      this.stacks.set(packageId, stacks);
    }
    return stacks;
  }

  private async shift(packageId: string, from: 'undo' | 'redo'): Promise<string | undefined> {
    const stacks = this.of(packageId);
    const target = stacks[from][0];
    if (!target) return undefined;
    const current = await this.capture(packageId, target.label, undefined, target.files !== undefined);
    if (!current) {
      this.forget(packageId);
      return undefined;
    }
    await applyEnvironment(this.store, packageId, JSON.parse(target.json) as Environment);
    for (const [part, file] of Object.entries(target.files ?? {})) {
      if (file) await this.store.putPackageFile(packageId, file);
      else if (current.files?.[part]) await this.store.deletePackageFile(packageId, part);
    }
    stacks[from].shift();
    stacks[from === 'undo' ? 'redo' : 'undo'].unshift(current);
    return target.label;
  }
}

/** Make what is stored now equal to `target` — touch only the Identifiables that differ */
export async function applyEnvironment(store: AasStore, packageId: string, target: Environment): Promise<void> {
  const current = await store.getEnvironment(packageId);
  const key = (modelType: string, id: string) => `${modelType} ${id}`;
  const wanted = new Map<
    string,
    { modelType: IdentifiableModelType; id: string; content: Record<string, unknown> }
  >();
  const have = new Map<string, Record<string, unknown>>();

  for (const [modelType, field] of Object.entries(ENVIRONMENT_FIELD) as [
    IdentifiableModelType,
    keyof Environment,
  ][]) {
    for (const item of (target[field] ?? []) as unknown as Record<string, unknown>[]) {
      wanted.set(key(modelType, String(item['id'])), { modelType, id: String(item['id']), content: item });
    }
    for (const item of (current[field] ?? []) as unknown as Record<string, unknown>[]) {
      have.set(key(modelType, String(item['id'])), item);
    }
  }

  // Delete first — so ids do not collide when creating
  for (const k of have.keys()) {
    if (!wanted.has(k)) {
      const space = k.indexOf(' ');
      await store.deleteIdentifiable(packageId, k.slice(0, space) as IdentifiableModelType, k.slice(space + 1));
    }
  }
  for (const [k, item] of wanted) {
    const existing = have.get(k);
    if (existing === undefined) {
      await store.createIdentifiable(packageId, item.content);
    } else if (JSON.stringify(existing) !== JSON.stringify(item.content)) {
      await store.updateIdentifiable(packageId, item.modelType, item.id, item.content);
    }
  }
}

/**
 * Build a human-readable change description from the request — it becomes the undo button's title.
 * We do not try to match every path rule exactly: target name + action is enough to tell "what is being undone".
 */
export function describeChange(method: string, path: string): string {
  const decode = (s: string) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  const segments = path.split('/').filter(Boolean).map(decode);
  const last = segments[segments.length - 1] ?? '';
  const at = (name: string) => segments.indexOf(name);

  if (at('fix') >= 0) return tr('자동 고치기');
  if (at('derivation') >= 0) return tr('형식 변경 반영');
  if (at('restore') >= 0) return tr('이력에서 되돌리기');
  if (at('aid') >= 0 || at('interfaces') >= 0) return tr('수집 연결 만들기');
  if (at('hierarchy') >= 0) return tr('구성 편집');
  if (at('import-submodel') >= 0) return tr('다른 파일에서 가져오기');

  const elements = at('submodel-elements');
  if (elements >= 0) {
    const pathPart = segments[elements + 1];
    const target = pathPart ? (pathPart.split('.').pop() ?? pathPart) : undefined;
    const name = target ? fill(tr('「{0}」'), { 0: target }) : tr('요소');
    if (last === 'move') return fill(tr('{0} 순서 바꾸기'), { 0: name });
    if (last === 'duplicate') return fill(tr('{0} 복제'), { 0: name });
    if (last === 'attachment') return fill(tr('{0} 첨부 바꾸기'), { 0: name });
    if (method === 'DELETE') return fill(tr('{0} 지움'), { 0: name });
    if (method === 'POST') return pathPart ? fill(tr('{0} 밑에 요소 추가'), { 0: name }) : tr('요소 추가');
    return fill(tr('{0} 고침'), { 0: name });
  }
  const submodels = at('submodels');
  if (submodels >= 0) {
    if (method === 'DELETE') return tr('서브모델 지움');
    if (method === 'POST' && segments[submodels + 1] === undefined) return tr('서브모델 추가');
    return tr('서브모델 고침');
  }
  if (at('concept-descriptions') >= 0) {
    if (method === 'DELETE') return tr('개념 설명 지움');
    if (method === 'POST') return tr('개념 설명 추가');
    return tr('개념 설명 고침');
  }
  if (at('shells') >= 0) return tr('AAS 고침');
  if (segments.length === 2 && method === 'PUT') return tr('파일 다시 올림');
  return `${method} ${segments.slice(2).join('/') || path}`;
}
