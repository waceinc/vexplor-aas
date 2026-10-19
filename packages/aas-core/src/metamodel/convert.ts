/**
 * Detecting the version a model needs, and lowering a model to an older version with a report of what it costs.
 *
 * Important: lowering never mutates its input and never drops anything without a report entry. "Saved as 3.0" must
 *    not mean "some fields quietly vanished" — the caller gets the removed values back and decides what to tell the user.
 */
import type { Environment } from '../types/environment.js';
import { deleteAtPointer, getAtPointer, parentPointer } from '../pointer.js';
import { fill, tr } from '../i18n/index.js';
import { scanFeatures, type FeatureCode, type FeatureHit } from './features.js';
import {
  compareVersions,
  DEFAULT_METAMODEL_VERSION,
  METAMODEL_VERSIONS,
  type MetamodelDetection,
  type MetamodelVersion,
} from './versions.js';

/** The lowest version that can hold this content. JSON carries no version marker, so this is always an inference */
export function detectMetamodelVersion(environment: Environment): MetamodelDetection {
  const hits = scanFeatures(environment);
  let version: MetamodelVersion = METAMODEL_VERSIONS[0];
  for (const h of hits) if (compareVersions(h.since, version) > 0) version = h.since;
  return {
    version,
    source: 'content',
    inferred: true,
    evidence: hits.map((h) => ({ pointer: h.pointer, feature: h.code, since: h.since })),
  };
}

export interface DowngradeEntry {
  /** dropped = removed from the output; unrepresentable = the target version has no way to say it */
  kind: 'dropped' | 'unrepresentable';
  /** JSON Pointer in the **input** model */
  pointer: string;
  feature: FeatureCode;
  field: string;
  /** First version that allows it */
  since: MetamodelVersion;
  /** The value found — for a dropped entry this is everything that was removed, so nothing is lost for good */
  value?: unknown;
  /** What happened and why, in the request's language */
  message: string;
}

export interface DowngradeReport {
  target: MetamodelVersion;
  /** True when the output says exactly what the input says */
  lossless: boolean;
  entries: DowngradeEntry[];
}

/**
 * Thrown when writing the target version would state something false or lose data without a report:
 *  - `unrepresentable` — the target cannot express a value and the caller did not ask to keep it as is;
 *  - `would-drop` — fields would be removed but the caller has no way to receive the report (writeAasx with a version).
 */
export class DowngradeError extends Error {
  readonly report: DowngradeReport;
  readonly reason: 'unrepresentable' | 'would-drop';
  constructor(report: DowngradeReport, reason: DowngradeError['reason'] = 'unrepresentable') {
    const listed = report.entries.filter((e) => (reason === 'unrepresentable' ? e.kind === 'unrepresentable' : e.kind === 'dropped'));
    const head = listed.slice(0, 5).map((e) => `  ${e.pointer}: ${e.message}`).join('\n');
    const title =
      reason === 'unrepresentable'
        ? fill(tr('V{0}으로 쓸 수 없는 값이 {1}건 있습니다.'), { 0: report.target, 1: listed.length })
        : fill(tr('V{0}으로 쓰면 빠지는 칸이 {1}건 있습니다 — 보고서를 함께 받는 쓰기로 저장하십시오.'), { 0: report.target, 1: listed.length });
    super(`${title}\n${head}${listed.length > 5 ? '\n  ...' : ''}`);
    this.name = 'DowngradeError';
    this.report = report;
    this.reason = reason;
  }
}

export interface ConvertOptions {
  /** Version to write. Default {@link DEFAULT_METAMODEL_VERSION} */
  to?: MetamodelVersion;
  /**
   * What to do with a value the target cannot express (AssetKind Batch in 3.1, a missing entityType in 3.0, …).
   *  - `error` (default): throw {@link DowngradeError} with the full report — writing a substitute would state
   *    something false, and dropping it would lose data.
   *  - `keep`: leave the value as it is and list it in the report. The output then does not validate against the
   *    target schema; use it only when the caller shows that to the user.
   */
  unrepresentable?: 'error' | 'keep';
}

export interface ConvertResult {
  /** The input object itself when nothing had to change — so the output bytes cannot drift */
  environment: Environment;
  report: DowngradeReport;
}

function messageOf(hit: FeatureHit, target: MetamodelVersion): string {
  const v = { field: hit.field, since: hit.since, target, value: typeof hit.value === 'string' ? hit.value : '' };
  switch (hit.code) {
    case 'administration-createdAt':
    case 'administration-updatedAt':
      return fill(tr('{field}는 V{since}에서 생긴 칸이라 V{target}에는 없습니다 — 뺐고, 값은 이 보고서에 남겼습니다.'), v);
    case 'dataSpecificationUom':
      return fill(tr('단위 데이터 사양(DataSpecificationUom)은 V{since}에서 생겨 V{target}에는 없습니다 — 이 사양 항목을 뺐고, 내용은 이 보고서에 남겼습니다.'), v);
    case 'assetKind-role':
    case 'assetKind-batch':
      return fill(tr('assetKind {value}는 V{since}에서 생긴 값이라 V{target}에는 없습니다. 다른 값으로 바꾸면 자산의 성격이 달라집니다.'), v);
    case 'entityType-missing':
      return fill(tr('entityType이 없습니다. V{since}부터는 비워 둘 수 있지만 V{target}에서는 필수이고, 대신 넣을 값을 알 수 없습니다.'), v);
    case 'relationship-first-missing':
    case 'relationship-second-missing':
      return fill(tr('{field}가 없습니다. V{since}부터는 비워 둘 수 있지만 V{target}에서는 필수이고, 가리킬 대상을 지어낼 수 없습니다.'), v);
    case 'contentType-missing':
      return fill(tr('contentType이 없습니다. V{since}부터는 비워 둘 수 있지만 V{target}에서는 필수이고, 파일 형식을 짐작해 넣을 수 없습니다.'), v);
    case 'contentType-length':
      return fill(tr('contentType이 100자를 넘습니다. V{since}부터 128자까지 되지만 V{target}은 100자까지입니다.'), v);
    case 'idShort-hyphen':
      return fill(tr('idShort {value}에 하이픈(-)이 있습니다. V{since}부터 되지만 V{target}에서는 안 됩니다. 이름을 바꾸면 이 요소를 가리키는 참조가 끊깁니다.'), v);
    case 'length-2048':
      return fill(tr('{field}가 2000자를 넘습니다. V{since}부터 2048자까지 되지만 V{target}은 2000자까지이고, 자르면 다른 식별자가 됩니다.'), v);
    case 'valueId-missing':
      return fill(tr('값 목록 항목에 valueId가 없습니다. V{since}부터는 비워 둘 수 있지만 V{target}에서는 필수입니다.'), v);
  }
}

/** Removes arrays emptied by a drop — the official schemas do not allow empty arrays (PKG-EMPTY-ARRAY) */
function removeEmptiedArrays(root: unknown, droppedEntryPointers: string[]): void {
  for (const pointer of droppedEntryPointers) {
    const holder = parentPointer(pointer);
    const list = getAtPointer(root, holder);
    if (Array.isArray(list) && list.length === 0) deleteAtPointer(root, holder);
  }
}

/** Lowers (or keeps) a model for writing as `to`. Raising needs no change: every older construct is still allowed */
export function convertEnvironment(environment: Environment, options: ConvertOptions = {}): ConvertResult {
  const target = options.to ?? DEFAULT_METAMODEL_VERSION;
  const policy = options.unrepresentable ?? 'error';
  const hits = scanFeatures(environment).filter((h) => compareVersions(h.since, target) > 0);

  const entries: DowngradeEntry[] = hits.map((h) => {
    const entry: DowngradeEntry = {
      kind: h.kind === 'drop' ? 'dropped' : 'unrepresentable',
      pointer: h.pointer,
      feature: h.code,
      field: h.field,
      since: h.since,
      message: messageOf(h, target),
    };
    if (h.value !== undefined) entry.value = h.value;
    return entry;
  });
  const report: DowngradeReport = { target, lossless: entries.length === 0, entries };

  if (policy === 'error' && entries.some((e) => e.kind === 'unrepresentable')) throw new DowngradeError(report);
  const drops = entries.filter((e) => e.kind === 'dropped');
  if (drops.length === 0) return { environment, report };

  // A JSON copy keeps key order (so unchanged parts serialize identically) and needs no DOM/Node globals
  const copy = JSON.parse(JSON.stringify(environment)) as Environment;
  // Important: delete from the last pointer back — removing an earlier array entry first would shift the later indices
  for (const drop of [...drops].reverse()) deleteAtPointer(copy, drop.pointer);
  removeEmptiedArrays(copy, drops.filter((d) => d.feature === 'dataSpecificationUom').map((d) => d.pointer));
  return { environment: copy, report };
}
