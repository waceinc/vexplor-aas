/**
 * Bulk import of external references (design §4.5, ERP §4, E-6).
 *
 * Rows come as CSV (`globalAssetId,subjectKind,subjectKey,system,type,id,publish,sensitive,externalSubjectId`) or JSON
 * `{ rows: [...] }`. `globalAssetId` names the **owning equipment** (its package is found among the visible packages);
 * `subjectKey` is the consumable / tool business key, or for `bomChild` the child's globalAssetId.
 *
 * Import only adds or updates refs present in the file — it never deletes others. A ref is identified by
 * (subject, system, type); an unchanged row is no change at all (no new `syncedAt`), so importing the same file twice
 * gives zero changes the second time.
 */
import { parseCsv } from '@aas/linter';
import { fill, tr } from '@aas/core';
import { externalRefSubjectString, type AasStore, type ExternalRef, type ExternalRefsDoc, type ExternalRefSubject } from '@aas/store';
import { ApiError } from '../http.js';
import { assetInformationOf, shellsOf } from './exports/elements.js';
import { allPackages, integrationStore } from './exports/store.js';
import { emptyExternalRefs, parseExternalRefsDoc } from './external-refs.js';

export const IMPORT_COLUMNS = ['globalAssetId', 'subjectKind', 'subjectKey', 'system', 'type', 'id', 'publish', 'sensitive', 'externalSubjectId'] as const;

export interface ImportRow {
  /** File row number: CSV line counting the header as 1, or JSON array index + 1 */
  row: number;
  values: Record<string, string>;
}

export interface ImportPlan {
  changes: { packageId: string; add: (ExternalRef & { subject: string })[]; remove: (ExternalRef & { subject: string })[] }[];
  errors: { row: number; message: string }[];
  conflicts: { system: string; type: string; id: string; packageId: string; subject: string; claimedBy: { packageId: string; subject: string } }[];
  /** New docs to store, per package, with the revision they were read at */
  docs: Map<string, { doc: ExternalRefsDoc; revision: number }>;
}

/** Rows of the request body — CSV text / bytes, or JSON `{ rows: [...] }` */
export function importRows(body: unknown): ImportRow[] {
  if (body instanceof Uint8Array || typeof body === 'string') {
    const table = parseCsv(typeof body === 'string' ? body : new TextDecoder().decode(body));
    const header = (table[0] ?? []).map((cell) => cell.trim());
    const missing = IMPORT_COLUMNS.filter((column) => ['globalAssetId', 'system', 'type', 'id'].includes(column) && !header.includes(column));
    if (table.length === 0 || missing.length > 0) {
      throw new ApiError(400, 'BadRequest', fill(tr('CSV 머리글에 열이 없습니다: {0}'), { 0: missing.join(', ') || IMPORT_COLUMNS.join(', ') }));
    }
    return table.slice(1).map((cells, i) => ({
      row: i + 2,
      values: Object.fromEntries(header.map((name, j) => [name, (cells[j] ?? '').trim()])),
    }));
  }
  const rows = (body as { rows?: unknown } | undefined)?.rows;
  if (!Array.isArray(rows)) throw new ApiError(400, 'BadRequest', tr('본문은 CSV이거나 { rows: [...] } JSON이어야 합니다.'));
  return rows.map((raw: unknown, i) => {
    const record = (raw !== null && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const values: Record<string, string> = {};
    for (const column of IMPORT_COLUMNS) {
      const value = record[column];
      values[column] = value === undefined || value === null ? '' : String(value).trim();
    }
    return { row: i + 1, values };
  });
}

function flagOf(text: string): boolean | undefined | 'invalid' {
  const value = text.toLowerCase();
  if (value === '') return undefined;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return 'invalid';
}

function sameRef(a: ExternalRef, b: ExternalRef): boolean {
  return a.id === b.id && (a.publish ?? false) === (b.publish ?? false) && (a.sensitive ?? false) === (b.sensitive ?? false) && a.externalSubjectId === b.externalSubjectId;
}

export async function planImport(store: AasStore, rows: readonly ImportRow[], now: string, source: string): Promise<ImportPlan> {
  const full = integrationStore(store);
  const byAsset = new Map<string, string[]>();
  for (const record of await allPackages(store)) {
    for (const shell of shellsOf(await store.getEnvironment(record.id))) {
      const id = assetInformationOf(shell)['globalAssetId'];
      if (typeof id === 'string' && id !== '') byAsset.set(id, [...new Set([...(byAsset.get(id) ?? []), record.id])]);
    }
  }
  const plan: ImportPlan = { changes: [], errors: [], conflicts: [], docs: new Map() };
  const changes = new Map<string, ImportPlan['changes'][number]>();
  const seen = new Set<string>();
  const claimed = new Map<string, { packageId: string; subject: string }>();

  for (const { row, values } of rows) {
    const error = (message: string): void => void plan.errors.push({ row, message });
    const owners = byAsset.get(values['globalAssetId'] ?? '') ?? [];
    if (owners.length === 0) {
      error(fill(tr('이 globalAssetId를 가진 패키지가 없습니다: {0}'), { 0: values['globalAssetId'] ?? '' }));
      continue;
    }
    if (owners.length > 1) {
      error(fill(tr('이 globalAssetId를 가진 패키지가 여럿입니다: {0}'), { 0: owners.join(', ') }));
      continue;
    }
    const packageId = owners[0]!;
    const kind = values['subjectKind'] || 'asset';
    const key = values['subjectKey'] ?? '';
    const subject = (
      kind === 'bomChild'
        ? { kind, globalAssetId: key }
        : kind === 'consumable' || kind === 'tool'
          ? { kind, globalAssetId: values['globalAssetId'], key }
          : { kind, globalAssetId: values['globalAssetId'] }
    ) as ExternalRefSubject['subject'];
    const publish = flagOf(values['publish'] ?? '');
    const sensitive = flagOf(values['sensitive'] ?? '');
    if (publish === 'invalid' || sensitive === 'invalid') {
      error(tr('publish·sensitive는 true, false, 1, 0 또는 빈 칸이어야 합니다.'));
      continue;
    }
    const ref: ExternalRef = {
      system: values['system'] ?? '',
      type: values['type'] ?? '',
      id: values['id'] ?? '',
      ...(publish !== undefined ? { publish } : {}),
      ...(sensitive !== undefined ? { sensitive } : {}),
      ...(values['externalSubjectId'] ? { externalSubjectId: values['externalSubjectId'] } : {}),
    };
    // One ref through the strict document parser — the same rules as PUT, reported per row
    const check = parseExternalRefsDoc({ schema: emptyExternalRefs().schema, subjects: [{ subject, refs: [ref] }] });
    if (!check.ok) {
      for (const item of check.errors) error(`${item.path.replace(/^\/subjects\/0/, '')}: ${item.message}`);
      continue;
    }
    const subjectString = externalRefSubjectString(subject);
    const identity = `${packageId}#${subjectString}#${ref.system}|${ref.type}`;
    if (seen.has(identity)) {
      error(tr('파일 안에 같은 대상·system·type 행이 두 번 있습니다.'));
      continue;
    }
    seen.add(identity);

    if (!plan.docs.has(packageId)) {
      const current = await full.getExternalRefs(packageId);
      plan.docs.set(packageId, { doc: structuredClone(current?.value ?? emptyExternalRefs()), revision: current?.revision ?? 0 });
    }
    const target = plan.docs.get(packageId)!;
    let entry = target.doc.subjects.find((item) => externalRefSubjectString(item.subject) === subjectString);
    const existing = entry?.refs.find((item) => item.system === ref.system && item.type === ref.type);
    if (existing && sameRef(existing, ref)) continue;

    // Uniqueness: the key must not belong to another subject (stored, or earlier in this file)
    const refKey = `${ref.system}|${ref.type}|${ref.id}`;
    const holders = [...(await full.findExternalRef(ref.system, ref.type, ref.id)), ...(claimed.has(refKey) ? [claimed.get(refKey)!] : [])];
    const other = holders.find((holder) => holder.packageId !== packageId || holder.subject !== subjectString);
    if (other) {
      plan.conflicts.push({ system: ref.system, type: ref.type, id: ref.id, packageId, subject: subjectString, claimedBy: other });
      continue;
    }
    claimed.set(refKey, { packageId, subject: subjectString });

    if (!entry) {
      entry = { subject, refs: [] };
      target.doc.subjects.push(entry);
    }
    const stamped: ExternalRef = { ...ref, syncedAt: now, source };
    entry.refs = entry.refs.filter((item) => item !== existing).concat(stamped);
    const change = changes.get(packageId) ?? { packageId, add: [], remove: [] };
    change.add.push({ ...stamped, subject: subjectString });
    if (existing) change.remove.push({ ...existing, subject: subjectString });
    changes.set(packageId, change);
  }

  plan.changes = [...changes.values()].sort((a, b) => a.packageId.localeCompare(b.packageId, 'en', { numeric: true }));
  for (const packageId of [...plan.docs.keys()]) if (!changes.has(packageId)) plan.docs.delete(packageId);
  return plan;
}
