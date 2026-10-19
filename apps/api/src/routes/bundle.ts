/**
 * Reference bundle — exports one process (composite) file as **a single submission package** and reopens it.
 *
 * Basis: 레퍼런스번들_추진방안_정리_260930.md (reference bundle plan summary) §2.1 (folder structure), §2.3 (self-validation criteria).
 *
 *   GET  /packages/{id}/bundle/linkage  Linkage item analysis of the equipment tied to the process (for the UI)
 *   GET  /packages/{id}/bundle          Bundle ZIP — process file + equipment AASX + manifest + folder skeleton
 *   POST /bundles                       Upload a bundle ZIP to open the process and equipment at once (hash check)
 *
 * Important: a bundle is **not a plain copy but a fingerprinted copy**. The manifest's SHA256 prevents the incident of
 *    "the model changed to v0.0.2 but the bundle still holds v0.0.1". writeAasx pins the modification time,
 *    so identical content yields identical bytes, and the hash tells directly **whether the content is the same**.
 * Important: this tool's check results are a **pre-check**. The bundle says so too — the official verdict is
 *    the KOSMO Validator report (CLAUDE.md validation tool principle). Important: the Validator is a check performed **when producing per-equipment AASX**,
 *    so there is no official validator for bundles — do not write as if the bundle receives a Validator verdict (user, 2026-09-30).
 * Important: documents (Use-Case, guidance) are not written. Only folders and "slots to fill" are created (same principle as document materials).
 */
import { createHash } from 'node:crypto';
import {
  ArchiveReadError,
  readAasx,
  unzipArchive,
  writeAasx,
  zipArchive,
  type AasxLimits,
} from '@aas/aasx';
import { fill, PRODUCT_NAME, PRODUCT_VERSION, tr, type Environment, type MetamodelVersion } from '@aas/core';
import { currentActor } from '@aas/store';
import {
  ALL_RULES,
  bundleLinkage,
  DEFAULT_POLICY,
  findEntryNode,
  formatHtmlReport,
  hierarchyTree,
  HIERARCHY_SUBMODEL_ID_SHORT,
  lint,
  linkageCsv,
  type BundleLinkage,
  type HierarchyTreeNode,
  type LinterPolicy,
} from '@aas/linter';
import type { AasStore, PackageRecord } from '@aas/store';
import { ApiError, json, noContent, type ApiRequest } from '../http.js';
import { writeOutgoing, type OutgoingChoice } from '../outgoing.js';
import { hintedMetamodel, metamodelHintOf } from '../metamodel-hint.js';
import {
  ORIGINAL_PART,
  originalFile,
  ATTACHMENT_FOLDERS,
  checkAttachmentPath,
  isEvidencePath,
  isGeneratedPath,
  listAttachments,
  readCarried,
  removeAttachment,
  saveAttachment,
  writeCarried,
} from './bundle-files.js';
import {
  EVIDENCE_LEVELS,
  evidenceCsv,
  evidenceLevelNames,
  evidenceHtml,
  gatherEvidence,
  suggestedLevel,
  type EvidenceLevel,
  type EvidenceSource,
} from './evidence.js';
import type { Route } from '../router.js';
import { userFileResponse } from '../user-file.js';
import { localTimestamp } from './packages.js';

/**
 * The 7 reference bundle categories — codes are used in the manifest and file names.
 * Important: the names are values set by the program and the default title = the bundle folder name — keep them in Korean.
 *    Translate with `tr()` only where people read them (README) (dictionary: en/bundle.ts)
 */
export const BUNDLE_CATEGORIES: Record<string, string> = {
  RB01: '생산최적화/품질관리', // i18n-ignore — category name (see above)
  RB02: '에너지효율/지속가능성',
  RB03: '유연생산/자산관리', // i18n-ignore — category name (see above)
  RB04: '데이터통합/보안',
  RB05: '지능형 자율제조/AI 에이전트', // i18n-ignore — category name (see above)
  RB06: '설비 예지보전(PdM)',
  RB07: '공급망 디지털 연결', // i18n-ignore — category name (see above)
};

export const BUNDLE_MANIFEST = 'bundle-manifest.json';
export const BUNDLE_SCHEMA = 'wace-reference-bundle/1';

const FOLDERS = {
  process: '00_공정구성', // i18n-ignore — submission package folder/file name (spec structure)
  usecase: '01_UseCase문서',
  models: '02_참조모델', // i18n-ignore — submission package folder/file name (spec structure)
  guidance: '03_가이던스',
  linkage: '04_데이터연계정의', // i18n-ignore — submission package folder/file name (spec structure)
  samples: '05_샘플데이터',
  evidence: '06_검증결과', // i18n-ignore — submission package folder/file name (spec structure)
} as const;

/** File paths inside the bundle — README, manifest and writing guides use the same text */
// i18n-ignore — submission package folder/file name (spec structure)
const LINKAGE_CSV = `${FOLDERS.linkage}/연계항목_초안.csv`;
// i18n-ignore — submission package folder/file name (spec structure)
const EVIDENCE_HTML = `${FOLDERS.evidence}/수집기록.html`;
// i18n-ignore — submission package folder/file name (spec structure)
const SAMPLES_CSV = `${FOLDERS.samples}/수집값_*.csv`;

const sha256 = (data: Uint8Array): string => createHash('sha256').update(data).digest('hex');
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

interface ShellInfo {
  idShort?: string;
  globalAssetId?: string;
  assetType?: string;
  version?: string;
  revision?: string;
}

async function shellInfo(store: AasStore, packageId: string): Promise<ShellInfo> {
  const shells = await store.listIdentifiables(packageId, 'AssetAdministrationShell');
  const content = shells.items[0]?.content as
    | {
        idShort?: string;
        administration?: { version?: string; revision?: string };
        assetInformation?: { globalAssetId?: string; assetType?: string };
      }
    | undefined;
  return {
    ...(content?.idShort ? { idShort: content.idShort } : {}),
    ...(content?.assetInformation?.globalAssetId ? { globalAssetId: content.assetInformation.globalAssetId } : {}),
    ...(content?.assetInformation?.assetType ? { assetType: content.assetInformation.assetType } : {}),
    ...(content?.administration?.version ? { version: content.administration.version } : {}),
    ...(content?.administration?.revision ? { revision: content.administration.revision } : {}),
  };
}

/** Whether this is a composite (process/company) file — same criterion as the UI (App.tsx fileUnit): `/type/` in assetType */
const isComposite = (info: ShellInfo): boolean => (info.assetType ?? '').includes('/type/');

/**
 * Asset address -> open file. If several share the same address, pick **the most recently modified** —
 * the file a person just edited must go into the bundle.
 */
async function assetIndex(store: AasStore): Promise<Map<string, PackageRecord>> {
  const index = new Map<string, PackageRecord>();
  const all = await store.listPackages({ limit: 1000 });
  for (const record of all.items) {
    const info = await shellInfo(store, record.id);
    if (!info.globalAssetId) continue;
    const current = index.get(info.globalAssetId);
    if (!current || current.updatedAt < record.updatedAt) index.set(info.globalAssetId, record);
  }
  return index;
}

/**
 * Whether the file has a collection connection (AID). Important: files with AID attached are **demo copies** — they contain connection addresses,
 * making them different from the submitted reference model. Surface this in the bundle UI, manifest and README so they don't get mixed in (2026-09-30)
 */
export const AID_SUBMODEL_ID_SHORT = 'AssetInterfacesDescription';

async function hasAid(store: AasStore, packageId: string): Promise<boolean> {
  const submodels = await store.listIdentifiables(packageId, 'Submodel');
  return submodels.items.some((item) => item.idShort === AID_SUBMODEL_ID_SHORT);
}

export interface BundleMember {
  name: string;
  globalAssetId: string;
  bulkCount: number;
  /** Group path in the process file where this equipment hangs — ["WeldingProcess"] */
  groupPath: string[];
  record?: PackageRecord;
  info?: ShellInfo;
  /** Whether this is a demo copy with a collection connection (AID) attached */
  demo?: boolean;
}

interface ResolvedBundle {
  process: PackageRecord;
  processInfo: ShellInfo;
  /** All nodes pointing at files (equipment, sub-composites). If the same equipment appears twice, both */
  members: BundleMember[];
  /** Sub-composite files to include in the bundle (nested cases like company > process) */
  nested: PackageRecord[];
}

async function hierarchyOf(store: AasStore, packageId: string): Promise<HierarchyTreeNode[] | undefined> {
  const submodels = await store.listIdentifiables(packageId, 'Submodel');
  const found = submodels.items.find((item) => item.idShort === HIERARCHY_SUBMODEL_ID_SHORT);
  if (!found) return undefined;
  const entry = findEntryNode(found.content as never);
  return entry ? hierarchyTree(entry) : [];
}

export async function resolveBundle(store: AasStore, packageId: string): Promise<ResolvedBundle> {
  const process = await store.getPackage(packageId);
  if (!process) throw new ApiError(404, 'NotFound', tr('패키지를 찾을 수 없습니다.'));
  const processInfo = await shellInfo(store, packageId);
  const top = await hierarchyOf(store, packageId);
  if (!top || !isComposite(processInfo)) {
    throw new ApiError(
      400,
      'BadRequest',
      tr('번들은 공정(묶음) 파일에서 만듭니다 — 이 파일은 설비 한 대 파일입니다.'),
    );
  }

  const index = await assetIndex(store);
  const members: BundleMember[] = [];
  const nested: PackageRecord[] = [];
  const visited = new Set<string>([packageId]);

  const walk = async (nodes: HierarchyTreeNode[], groupPath: string[]): Promise<void> => {
    for (const node of nodes) {
      if (!node.globalAssetId) {
        // Group (intermediate node) — has no file. Only contributes to the path
        await walk(node.children, [...groupPath, node.name]);
        continue;
      }
      const record = index.get(node.globalAssetId);
      const info = record ? await shellInfo(store, record.id) : undefined;
      if (record && info && isComposite(info)) {
        // Important: sub-composites are expanded. Cycles are blocked during hierarchy editing, but blocked once more here
        if (visited.has(record.id)) continue;
        visited.add(record.id);
        nested.push(record);
        await walk((await hierarchyOf(store, record.id)) ?? [], [...groupPath, node.name]);
        continue;
      }
      // Equipment. The hierarchy inside an equipment file is parts (BoM), so it is not expanded
      members.push({
        name: node.name,
        globalAssetId: node.globalAssetId,
        bulkCount: node.bulkCount,
        groupPath,
        ...(record ? { record } : {}),
        ...(info ? { info } : {}),
        ...(record && (await hasAid(store, record.id)) ? { demo: true } : {}),
      });
    }
  };
  await walk(top, []);
  return { process, processInfo, members, nested };
}

/**
 * Bytes to put in the bundle — the **original if one was uploaded and the model is unchanged**, otherwise a repackaged one.
 * Sameness is compared by normalizing both the same way (the outgoing writer, at the version the file came in as) —
 * judged by content, not revision number.
 * `keep` — for telling files apart only (opening a bundle): a value the version cannot say must not stop that
 */
async function modelBytes(
  store: AasStore,
  packageId: string,
  choice: OutgoingChoice = {},
): Promise<{ data: Uint8Array; original: boolean }> {
  const record = await requireRecord(store, packageId);
  const current = writeOutgoing(await store.exportPackage(packageId), record, choice).data;
  const kept = (await store.packageFiles(packageId)).find((file) => file.part === ORIGINAL_PART);
  if (kept) {
    try {
      const normalized = writeOutgoing(readAasx(kept.data), record, choice).data;
      if (sha256(normalized) === sha256(current)) return { data: kept.data, original: true };
    } catch {
      // If the original can't be read, use the repackaged one
    }
  }
  return { data: current, original: false };
}

async function requireRecord(store: AasStore, packageId: string): Promise<PackageRecord> {
  const record = await store.getPackage(packageId);
  if (!record) throw new ApiError(404, 'NotFound', tr('패키지를 찾을 수 없습니다.'));
  return record;
}

/** The file as it goes into the bundle — the version it came in as (outgoing.ts); a value it cannot say stops the export */
async function exportBytes(store: AasStore, packageId: string): Promise<Uint8Array> {
  return writeOutgoing(await store.exportPackage(packageId), await requireRecord(store, packageId)).data;
}

/** The internal round trip the checks read — never converted, never refused (outgoing.ts) */
async function snapshotBytes(store: AasStore, packageId: string): Promise<Uint8Array> {
  return writeAasx(await store.exportPackage(packageId));
}

/**
 * Checks bundle bytes by the version the file is written as — the version it came in as (outgoing.ts). The bytes
 * alone cannot say it: a body written as JSON reads as "the lowest version that holds the content".
 */
function lintBytes(data: Uint8Array, policy: Partial<LinterPolicy>, record: Pick<PackageRecord, 'metamodel'>) {
  const pkg = readAasx(data);
  return {
    pkg,
    result: lint(pkg.environment, ALL_RULES, {
      package: pkg.opc,
      // No `inferred` — judged by the version written, never widened to the versions the content fits (packages.ts judgedVersion)
      metamodel: { version: record.metamodel.version },
      ...(Object.keys(policy).length > 0 ? { policy } : {}),
    }),
  };
}

/** File name to put in the bundle — keeps the original name but strips path characters */
const safeName = (name: string): string => name.replace(/[\\/:*?"<>|]/g, '_');

async function linkageFor(store: AasStore, resolved: ResolvedBundle): Promise<BundleLinkage> {
  const inputs = [];
  for (const member of resolved.members) {
    let environment: Environment | undefined;
    if (member.record) environment = (await store.exportPackage(member.record.id)).environment;
    inputs.push({ name: member.name, globalAssetId: member.globalAssetId, ...(environment ? { environment } : {}) });
  }
  return bundleLinkage(inputs);
}

export interface BundleOptions {
  code: string;
  title: string;
  version: string;
  /** Evidence level. 'auto' suggests from interface names (C if simulation only), otherwise left blank */
  evidence?: EvidenceLevel | 'auto' | 'none';
  /** Include only collected values from the last N minutes. Empty means all */
  evidenceMinutes?: number;
}

/** `evidenceMinutes` query -> start time (ISO) */
function evidenceWindow(request: ApiRequest, now: Date): { from?: string } {
  const raw = request.query['evidenceMinutes'];
  if (raw === undefined || raw === '' || raw === 'all') return {};
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new ApiError(400, 'BadRequest', fill(tr('evidenceMinutes는 양수(분)입니다: {0}'), { 0: raw }));
  }
  return { from: new Date(now.getTime() - minutes * 60_000).toISOString() };
}

function bundleOptions(request: ApiRequest, fallbackTitle: string): BundleOptions {
  const code = (request.query['code'] ?? 'RB00').toUpperCase();
  if (!/^RB\d{2}$/.test(code)) throw new ApiError(400, 'BadRequest', tr('번들 코드는 RB01 형식입니다.'));
  const version = request.query['version'] ?? '1.0.0';
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new ApiError(400, 'BadRequest', tr('버전은 1.0.0 형식입니다(운영 가이드라인과 같은 3자리).'));
  }
  const title = (request.query['title'] ?? '').trim() || BUNDLE_CATEGORIES[code] || fallbackTitle;
  const evidence = (request.query['evidence'] ?? 'auto').toUpperCase();
  if (!['A', 'B', 'C', 'AUTO', 'NONE'].includes(evidence)) {
    throw new ApiError(400, 'BadRequest', tr('증빙 수준은 A·B·C·auto·none 중 하나입니다.'));
  }
  return {
    code,
    title,
    version,
    evidence: (['AUTO', 'NONE'].includes(evidence) ? evidence.toLowerCase() : evidence) as BundleOptions['evidence'],
  };
}

/** Tree as text — README and the UI use the same shape */
function treeText(rootName: string, members: BundleMember[]): string {
  const lines = [rootName];
  let lastGroup = '';
  for (const member of members) {
    const group = member.groupPath.join(' > ');
    if (group && group !== lastGroup) lines.push(`  ▦ ${group}`);
    lastGroup = group;
    const indent = group ? '      ' : '  ';
    const count = member.bulkCount > 1 ? ` ${fill(tr('×{0}대'), { 0: member.bulkCount })}` : '';
    const file = member.record ? member.record.name : tr('(파일 없음 — 예정)');
    lines.push(`${indent}⚙ ${member.name}${count}  ${file}`);
  }
  return lines.join('\n');
}

const pendingNote = (title: string, lines: string[]): string =>
  [`# ${title}`, '', tr('> 이 파일은 **채울 자리 안내**입니다. 도구가 문서를 대신 쓰지 않습니다.'), '', ...lines, ''].join('\n');

/** Evidence summary shared by manifest, README and UI — excluding the values themselves */
function evidenceEntry(source: EvidenceSource, file?: string) {
  return {
    model: source.model,
    instance: source.instance,
    direct: source.direct,
    interfaces: source.interfaces,
    from: source.values[0]?.observedAt ?? '',
    to: source.values[source.values.length - 1]?.observedAt ?? '',
    samples: source.values.length,
    properties: new Set(source.values.map((v) => v.propertyName)).size,
    ...(source.truncated ? { truncated: true } : {}),
    ...(file ? { file } : {}),
  };
}

/** Build the bundle ZIP and manifest */
export async function buildBundle(
  store: AasStore,
  packageId: string,
  options: BundleOptions,
  policy: Partial<LinterPolicy>,
  now: Date,
): Promise<{ zip: Uint8Array; manifest: Record<string, unknown>; root: string }> {
  const resolved = await resolveBundle(store, packageId);
  const effectivePolicy = { ...DEFAULT_POLICY, ...policy };
  const root = safeName(`${options.code}_${options.title.replace(/[\/\s]+/g, '')}_v${options.version}`);
  const files: Record<string, Uint8Array> = {};
  const put = (path: string, data: Uint8Array | string): void => {
    files[`${root}/${path}`] = typeof data === 'string' ? encode(data) : data;
  };
  const stamp = now.toISOString();
  // "Who exported it" — picked from the request context (actor.ts). undefined on servers that don't use login
  const exporter = currentActor();
  // Human-readable documents (reports, records) use server local time — same rule as /report. The manifest stays ISO
  const printed = localTimestamp(now);

  // 1. Process composition — the process file (and sub-composites). Important: not submitted as a reference model (lacks the 4 mandatory submodels)
  const processFiles = [];
  for (const record of [resolved.process, ...resolved.nested]) {
    const data = await exportBytes(store, record.id);
    const { result, pkg } = lintBytes(data, policy, record);
    const hier = result.findings.filter((f) => f.ruleId.startsWith('HIER-') && f.severity === 'error').length;
    const path = `${FOLDERS.process}/${safeName(record.name)}`;
    put(path, data);
    put(
      // i18n-ignore — submission package folder/file name (spec structure)
      `${FOLDERS.evidence}/사전점검_${safeName(record.name.replace(/\.aasx$/i, ''))}.html`,
      formatHtmlReport(result, { title: fill(tr('{0} (공정 구성 — 사전 점검)'), { 0: record.name }), generatedAt: printed, policy: effectivePolicy }),
    );
    const shell = pkg.environment.assetAdministrationShells?.[0];
    processFiles.push({
      file: path,
      sourceName: record.name,
      assetName: shell?.idShort,
      globalAssetId: shell?.assetInformation?.globalAssetId,
      sha256: sha256(data),
      hierarchyErrors: hier,
      lint: { passed: result.passed, ...result.countBySeverity },
    });
  }

  // 2. Reference models — equipment AASX. Even if the same equipment is in two processes, the file is included only once
  interface ModelEntry {
    assetName: string;
    globalAssetId: string;
    groupPath: string[];
    bulkCount: number;
    sourceName: string;
    version?: string;
    revision?: string;
    file: string;
    /** If the same file is already in the bundle, points to its first position */
    duplicateOf?: string;
    /** Demo copy with a collection connection (AID) attached — must not be used as a submitted reference model */
    demo?: boolean;
    sha256?: string;
    original?: boolean;
    lint?: { passed: boolean; error: number; warning: number; info: number };
  }
  const models: ModelEntry[] = [];
  const planned = [];
  const packed = new Map<string, string>();
  for (const member of resolved.members) {
    if (!member.record) {
      planned.push({ assetName: member.name, globalAssetId: member.globalAssetId, groupPath: member.groupPath });
      continue;
    }
    let path = packed.get(member.record.id);
    let entry: Pick<ModelEntry, 'file' | 'sha256' | 'lint' | 'original'> | undefined;
    if (!path) {
      const { data, original } = await modelBytes(store, member.record.id);
      const { result } = lintBytes(data, policy, member.record);
      path = `${FOLDERS.models}/${safeName(member.record.name)}`;
      packed.set(member.record.id, path);
      put(path, data);
      put(
        // i18n-ignore — submission package folder/file name (spec structure)
        `${FOLDERS.evidence}/사전점검_${safeName(member.record.name.replace(/\.aasx$/i, ''))}.html`,
        formatHtmlReport(result, { title: fill(tr('{0} (사전 점검)'), { 0: member.record.name }), generatedAt: printed, policy: effectivePolicy }),
      );
      entry = {
        file: path,
        sha256: sha256(data),
        // true — the uploaded original as-is (same hash as the copy submitted to the operating agency). false — edited in the tool and repackaged
        original,
        lint: { passed: result.passed, ...result.countBySeverity },
      };
    }
    models.push({
      assetName: member.name,
      globalAssetId: member.globalAssetId,
      groupPath: member.groupPath,
      bulkCount: member.bulkCount,
      sourceName: member.record.name,
      ...(member.info?.version ? { version: member.info.version } : {}),
      ...(member.info?.revision ? { revision: member.info.revision } : {}),
      ...(member.demo ? { demo: true } : {}),
      ...(entry ?? { file: path, duplicateOf: path }),
    });
  }

  // 2-1. Live operation evidence — collected values of the equipment itself and units derived from it (derivedFrom). A record that substitutes for a demo
  const evidenceSources = await gatherEvidence(
    store,
    resolved.members.filter((m) => m.record).map((m) => ({ name: m.name, record: m.record! })),
    options.evidenceMinutes ? { from: new Date(now.getTime() - options.evidenceMinutes * 60_000).toISOString() } : {},
  );
  // If there is no new collection, carry over the previous bundle's evidence — the case where the bundle was reopened and only the model was edited
  const carried = evidenceSources.length === 0 ? await readCarried(store, resolved.process.id) : undefined;
  const carriedLevel = carried?.level === 'A' || carried?.level === 'B' || carried?.level === 'C' ? carried.level : null;
  const level: EvidenceLevel | null =
    options.evidence === 'none'
      ? null
      : evidenceSources.length === 0
        ? options.evidence === 'auto' || options.evidence === undefined
          ? carriedLevel
          : carried
            ? options.evidence
            : null
        : options.evidence === 'auto' || options.evidence === undefined
          ? suggestedLevel(evidenceSources)
          : options.evidence;
  const evidenceEntries: Record<string, unknown>[] = [...(carried?.entries ?? []).map((e) => ({ ...e, carried: true }))];
  if (evidenceSources.length > 0) {
    for (const source of evidenceSources) {
      // i18n-ignore — submission package folder/file name (spec structure)
      const csvPath = `${FOLDERS.samples}/수집값_${safeName(source.instance)}.csv`;
      put(csvPath, evidenceCsv(source));
      evidenceEntries.push(evidenceEntry(source, csvPath));
    }
    put(
      // i18n-ignore — submission package folder/file name (spec structure)
      `${FOLDERS.evidence}/수집기록.html`,
      evidenceHtml({
        // If the title is the category name as-is (default), translate that name too (same rule as README)
        title: `${options.code} ${tr(options.title)}`,
        level,
        generatedAt: printed,
        tool: `${PRODUCT_NAME} ${PRODUCT_VERSION}`,
        sources: evidenceSources,
      }),
    );
  }

  // 3. Linkage definition — common item table (draft). "Linkage key" and "KPI usage" are filled in by people
  const linkage = await linkageFor(store, resolved);
  // i18n-ignore — submission package folder/file name (spec structure)
  put(`${FOLDERS.linkage}/연계항목_초안.csv`, linkageCsv(linkage));
  const findingLines = linkage.findings.map((f) => `- ${f.severity === 'warning' ? tr('[확인]') : tr('[참고]')} ${f.message}`);
  put(
    // i18n-ignore — submission package folder/file name (spec structure)
    `${FOLDERS.linkage}/연계_확인사항.md`,
    [
      tr('# 데이터 연계 — 확인할 점'),
      '',
      fill(tr('분석 대상: 설비 {0}대의 OperationalData · 공통 항목(2대 이상) {1}개'), {
        0: linkage.members.length,
        1: linkage.items.filter((i) => i.coverage >= 2).length,
      }),
      linkage.missing.length > 0 ? `\n${fill(tr('분석에서 빠진 설비(파일 없음): {0}'), { 0: linkage.missing.join(', ') })}` : '',
      '',
      tr('연계 매핑은 **semanticId만으로 잡지 말고 경로(idShort 경로)를 함께** 적습니다.'),
      tr('같은 semanticId를 서로 다른 개념이 쓰는 사례가 실측으로 확인됐습니다(사업 참조모델 30종, 2026-09-30).'),
      '',
      ...(findingLines.length > 0 ? findingLines : [tr('- 확인할 점 없음')]),
      '',
    ].join('\n'),
  );

  // 4. Slots to fill — documents are written by people
  put(
    // i18n-ignore — submission package folder/file name (spec structure)
    `${FOLDERS.usecase}/_작성안내.md`,
    pendingNote(tr('Use-Case 문서 (hwpx 또는 docx + pdf)'), [
      tr('목차(안) — 추진방안 §2.2'),
      '',
      tr('1. 개요: 카테고리, 대상 업종·공정, 현장 문제, **데이터 출처와 증빙 수준(A 현장 적용 / B 실장비 재현 / C 시뮬레이션)**'),
      tr('2. 공정 흐름과 장비 구성 — `README.md`의 구성 트리, 「문서용 자료」의 구성도'),
      tr('3. Use-Case 시나리오: 붙임6 매핑 근거, 액터, 단계별 흐름'),
      fill(tr('4. 데이터 연계 구조 — `{0}`'), { 0: LINKAGE_CSV }),
      tr('5. KPI 산출: 산식, 필요한 Property, 샘플 계산'),
      tr('6. 실증: BaSyx 통합 적재, REST 조회 예시, 시연 화면'),
      tr('7. 중소기업 도입 절차: 다운로드 → 자사 값 입력 → 연동'),
      tr('8. 부록: 용어, 참조 표준, 용어사전 버전'),
    ]),
  );
  put(
    // i18n-ignore — submission package folder/file name (spec structure)
    `${FOLDERS.guidance}/_작성안내.md`,
    pendingNote(tr('가이던스 (장비별 1:1)'), [
      tr('아래 설비마다 작성한 가이던스를 넣습니다. 참조모델과 **같은 버전**이어야 합니다.'),
      '',
      ...[...new Set(resolved.members.filter((m) => m.record).map((m) => m.record!.name))].map(
        // i18n-ignore — file names to include (guidance file name per the submission package spec)
        (name) => `- [ ] ${name.replace(/\.aasx$/i, '')}_AAS활용가이던스`,
      ),
    ]),
  );
  put(
    // i18n-ignore — submission package folder/file name (spec structure)
    `${FOLDERS.samples}/_작성안내.md`,
    pendingNote(tr('샘플 데이터 (KPI 산출용)'), [
      tr('- 실데이터는 **기업 동의·비식별화 후**에만 넣습니다(GitHub 공개 대상).'),
      tr('- 가상 PLC 데이터는 파일명과 본문에 **「시뮬레이션」** 을 표기합니다.'),
    ]),
  );

  // 4-1. Attachments added by people — restored from those stored in the process file. If they overlap with tool-generated ones, the tool's wins.
  //      If there is a new collection record, old collection records are dropped entirely (so the new record and old CSV don't mix)
  const attachments = [];
  for (const attachment of await listAttachments(store, resolved.process.id)) {
    if (isGeneratedPath(attachment.path)) continue;
    if (evidenceSources.length > 0 && isEvidencePath(attachment.path)) continue;
    if (files[`${root}/${attachment.path}`]) continue;
    put(attachment.path, attachment.data);
    attachments.push({ path: attachment.path, size: attachment.size, sha256: sha256(attachment.data) });
  }

  const manifest = {
    schema: BUNDLE_SCHEMA,
    bundle: {
      code: options.code,
      category: BUNDLE_CATEGORIES[options.code] ?? null,
      title: options.title,
      version: options.version,
      createdAt: stamp,
      // Important: **who exported it.** For a submission package, "when and what" isn't enough; the person to ask
      //    later must be recorded. On servers that don't use login it is null —
      //    we don't pretend to know what we don't
      createdBy: exporter?.name ?? null,
      tool: `${PRODUCT_NAME} ${PRODUCT_VERSION}`,
      // Evidence level (A/B/C) — chosen by a person. If not chosen, suggest C only when simulation-only, otherwise leave blank
      evidenceLevel: level,
    },
    evidence: evidenceEntries,
    /** Documents and evidence added by people — preserved when the bundle is reopened */
    attachments,
    process: processFiles,
    models,
    planned,
    linkage: {
      file: LINKAGE_CSV,
      analyzedMembers: linkage.members.length,
      commonItems: linkage.items.filter((i) => i.coverage >= 2).length,
      warnings: linkage.findings.filter((f) => f.severity === 'warning').length,
    },
    notes: [
      tr('모델의 공식 검증(KOSMO Validator)은 장비별 AASX를 만들 때 받는 것이다. 여기 lint는 번들에 넣은 모델을 이 도구가 다시 확인한 참고 기록이다.'),
      tr('번들 자체의 확인은 해시 대조 · 공정 구성(HIER) · 데이터 연계 · 실동작 증빙으로 한다.'),
      tr('공정 구성 파일은 참조모델에 포함하지 않는다(설비 필수 서브모델 4종이 없다).'),
    ],
  };
  put(BUNDLE_MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);

  const uniqueModels = models.filter(
    (m): m is ModelEntry & Required<Pick<ModelEntry, 'sha256' | 'lint'>> => m.sha256 !== undefined && m.lint !== undefined,
  );
  put(
    'README.md',
    [
      // If the title is the category name as-is (default), translate that name too — titles written by people aren't in the dictionary and go out unchanged
      fill(tr('# {0} {1} — 레퍼런스 번들 v{2}'), { 0: options.code, 1: tr(options.title), 2: options.version }),
      '',
      fill(tr('- 카테고리: {0}'), { 0: BUNDLE_CATEGORIES[options.code] ? tr(BUNDLE_CATEGORIES[options.code]!) : tr('(미지정)') }),
      fill(tr('- 만든 날: {0} · 도구: {1} {2}'), { 0: stamp.slice(0, 10), 1: PRODUCT_NAME, 2: PRODUCT_VERSION }),
      ...(exporter ? [fill(tr('- 내보낸 사람: {0}'), { 0: exporter.name })] : []),
      level
        ? fill(tr('- 증빙 수준: **{0}** — {1}'), { 0: level, 1: tr(EVIDENCE_LEVELS[level]) })
        : tr('- 증빙 수준: **(사람이 채움 — A 현장 적용 / B 실장비 재현 / C 시뮬레이션)**'),
      '',
      tr('## 공정 구성'),
      '',
      '```',
      treeText(resolved.processInfo.idShort ?? resolved.process.name, resolved.members),
      '```',
      '',
      tr('## 포함 참조모델'),
      '',
      tr('| 파일 | 버전 | SHA256(앞 12자) | 원본 | 사전 점검 |'),
      '|---|---|---|---|---|',
      ...uniqueModels.map(
        (m) =>
          fill(tr('| {0} | {1}.{2} | `{3}` | {4} | {5} · 경고 {6} |'), {
            0: m.sourceName,
            1: m.version ?? '-',
            2: m.revision ?? '-',
            3: m.sha256.slice(0, 12),
            4: m.original ? tr('올린 파일 그대로') : tr('도구에서 고쳐 다시 포장'),
            5: m.lint.passed ? tr('통과') : fill(tr('위반 {0}'), { 0: m.lint.error }),
            6: m.lint.warning,
          }),
      ),
      ...(planned.length > 0
        ? ['', fill(tr('**파일이 없는 설비(예정)**: {0} — 번들 완성 전에 채웁니다.'), { 0: planned.map((p) => p.assetName).join(', ') })]
        : []),
      ...(models.some((m) => m.demo)
        ? [
            '',
            fill(tr('> **시연본 포함**: {0} — 수집 연결(AID)이 붙어 있습니다.'), {
              0: [...new Set(models.filter((m) => m.demo).map((m) => m.sourceName))].join(', '),
            }),
            tr('> 정식 번들에는 수집 연결이 없는 **원본 참조모델**을 넣으십시오.'),
          ]
        : []),
      '',
      tr('## 실동작 증빙'),
      '',
      ...(carried
        ? [
            fill(tr('> 이전 번들({0} v{1})에서 **이어받은 수집 기록**입니다 — 이번에 새로 모은 값은 없습니다.'), {
              0: carried.from.code ?? '',
              1: carried.from.version ?? '?',
            }),
            '',
          ]
        : []),
      ...(evidenceEntries.length > 0
        ? [
            fill(tr('시연 대신 **수집 기록**을 싣습니다 — `{0}`(인쇄하면 PDF), 전체 값은 `{1}`.'), {
              0: EVIDENCE_HTML,
              1: SAMPLES_CSV,
            }),
            '',
            tr('| 설비(형식) | 값을 모은 파일 | 수집 연결 | 기간 | 건수 |'),
            '|---|---|---|---|---|',
            ...(evidenceEntries as ReturnType<typeof evidenceEntry>[]).map(
              (e) =>
                `| ${e.model} | ${e.instance}${e.direct ? '' : ` ${tr('(파생 호기)')}`} | ${e.interfaces.map((i) => `${i.title} \`${i.endpoint}\``).join('<br>')} | ${localTimestamp(new Date(e.from))} ~ ${localTimestamp(new Date(e.to)).slice(11)} | ${e.samples} |`,
            ),
          ]
        : [tr('수집 기록이 없습니다. 이 번들의 설비(또는 「호기별로 나누기」로 만든 호기)를 수집한 뒤 다시 내보내면 여기에 실립니다.')]),
      '',
      tr('### 재현 방법 — 누구나 직접 돌려 볼 수 있습니다'),
      '',
      tr('1. AAS 저작 도구(설치 버전)를 띄우고 **「번들 열기」**로 이 ZIP을 엽니다 — 알림 띠에 해시 일치가 나옵니다'),
      tr('2. 공정 트리에서 설비를 열고, 오른쪽 수집 칸의 **「가상 PLC로 연결」**을 누릅니다 — 도구 안의 가상 PLC(시뮬레이션)가 그 설비의 운전 데이터 이름대로 태그를 만들고 수집 연결을 만듭니다'),
      tr('3. **「수집」**을 누르면 값이 들어옵니다(상태 「연결됨」). 원본을 건드리지 않으려면 먼저 「호기별로 나누기」로 호기를 만들어 그쪽에서 하십시오'),
      '',
      tr('## 사람이 넣은 문서'),
      '',
      ...(attachments.length > 0
        ? [tr('| 파일 | 크기 |'), '|---|---|', ...attachments.map((a) => `| ${a.path} | ${(a.size / 1024).toFixed(1)} KB |`)]
        : [tr('아직 없습니다 — Use-Case 문서와 장비별 가이던스를 해당 폴더에 넣으십시오(도구 「레퍼런스 번들 → 문서·첨부」에서 올리면 다시 열어도 보존됩니다).')]),
      '',
      tr('## 폴더'),
      '',
      tr('| 폴더 | 내용 |'),
      '|---|---|',
      fill(tr('| {0} | 공정 구성 파일(HierarchicalStructures). 참조모델에 포함하지 않음 |'), { 0: FOLDERS.process }),
      fill(tr('| {0} | Use-Case 문서 — 작성 안내 |'), { 0: FOLDERS.usecase }),
      fill(tr('| {0} | 설비 참조모델 AASX (해시는 {1}) |'), { 0: FOLDERS.models, 1: BUNDLE_MANIFEST }),
      fill(tr('| {0} | 장비별 가이던스 — 넣을 목록 |'), { 0: FOLDERS.guidance }),
      fill(tr('| {0} | 연계 항목 초안(CSV) · 확인할 점 |'), { 0: FOLDERS.linkage }),
      fill(tr('| {0} | KPI 산출용 샘플 데이터(수집값 CSV) — 비식별화 |'), { 0: FOLDERS.samples }),
      fill(tr('| {0} | 사전 점검 결과서(참고) · 수집 기록서(HTML) |'), { 0: FOLDERS.evidence }),
      '',
      tr('> 참조모델의 공식 검증(KOSMO Validator)은 **장비별 AASX를 만들 때** 받은 것입니다. 이 번들의 사전 점검은 넣은 모델을 다시 확인한 참고 기록이고,'),
      tr('> 번들 자체는 해시 대조 · 공정 구성(HIER) · 데이터 연계 · 실동작 증빙으로 확인합니다.'),
      '',
    ].join('\n'),
  );

  return { zip: zipArchive(files), manifest, root };
}

// ── Opening a bundle ──────────────────────────────────────────────────────────────

export interface BundleImportResult {
  bundle: Record<string, unknown>;
  processPackageId?: string;
  /** People's files kept in the process file — restored when exported again */
  attachments: string[];
  files: {
    file: string;
    packageId: string;
    /** Whether it matches the manifest hash. null if the file isn't in the manifest */
    hashOk: boolean | null;
    /** Whether an already-open file with the same content was reused as-is */
    reused: boolean;
  }[];
  problems: string[];
}

export async function importBundle(
  store: AasStore,
  data: Uint8Array,
  limits: Partial<AasxLimits>,
  /** `?metamodel=` — the screen's samples are stored as 3.1 when their content fits (metamodel-hint.ts) */
  hint?: MetamodelVersion,
): Promise<BundleImportResult> {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipArchive(data, limits);
  } catch (error) {
    if (error instanceof ArchiveReadError) throw new ApiError(400, 'BadRequest', error.message);
    throw error;
  }
  const manifestPath = Object.keys(entries).find((p) => p === BUNDLE_MANIFEST || p.endsWith(`/${BUNDLE_MANIFEST}`));
  if (!manifestPath) {
    throw new ApiError(400, 'BadRequest', fill(tr('{0}가 없습니다 — 이 도구로 만든 레퍼런스 번들이 아닙니다.'), { 0: BUNDLE_MANIFEST }));
  }
  let manifest: {
    schema?: string;
    bundle?: Record<string, unknown>;
    process?: { file: string; sha256: string }[];
    models?: { file: string; sha256?: string }[];
  };
  try {
    manifest = JSON.parse(new TextDecoder().decode(entries[manifestPath]));
  } catch {
    throw new ApiError(400, 'BadRequest', fill(tr('{0}를 읽을 수 없습니다.'), { 0: BUNDLE_MANIFEST }));
  }
  if (manifest.schema !== BUNDLE_SCHEMA) {
    throw new ApiError(400, 'BadRequest', fill(tr('지원하지 않는 번들 형식입니다: {0}'), { 0: String(manifest.schema) }));
  }
  const base = manifestPath.slice(0, manifestPath.length - BUNDLE_MANIFEST.length);
  const expected = new Map<string, string>();
  for (const entry of [...(manifest.process ?? []), ...(manifest.models ?? [])]) {
    if (entry.sha256) expected.set(entry.file, entry.sha256);
  }

  // Fingerprints of already-open files — same content isn't uploaded again (two identical Asset addresses would confuse the process)
  const opened = new Map<string, string>();
  const all = await store.listPackages({ limit: 1000 });
  for (const record of all.items) opened.set(sha256((await modelBytes(store, record.id, { keep: true })).data), record.id);

  const problems: string[] = [];
  const files: BundleImportResult['files'] = [];
  let processPackageId: string | undefined;
  // Equipment first, process last — the equipment the process points to must already exist so the UI can draw it right away
  const aasxPaths = Object.keys(entries)
    .filter((p) => p.startsWith(base) && /\.aasx$/i.test(p))
    .sort((a, b) => Number(a.slice(base.length).startsWith('00_')) - Number(b.slice(base.length).startsWith('00_')));

  for (const path of aasxPaths) {
    const relative = path.slice(base.length);
    const bytes = entries[path]!;
    const digest = sha256(bytes);
    const want = expected.get(relative);
    const hashOk = want === undefined ? null : want === digest;
    if (hashOk === false) problems.push(fill(tr('{0}: manifest의 해시와 다릅니다 — 번들을 만든 뒤 파일이 바뀌었습니다.'), { 0: relative }));
    if (want === undefined) problems.push(fill(tr('{0}: manifest에 없는 파일입니다.'), { 0: relative }));

    let packageId = opened.get(digest);
    const reused = packageId !== undefined;
    if (!packageId) {
      const pkg = readAasx(bytes, { limits });
      const name = relative.split('/').pop()!;
      // Keep the original as well — re-exporting yields the same bytes, so the hash chain continues
      const hinted = hintedMetamodel(pkg, hint);
      packageId = (await store.importPackage({ name, package: pkg, keep: [originalFile(bytes)], ...(hinted ? { metamodel: hinted } : {}) })).id;
      opened.set(digest, packageId);
    }
    files.push({ file: relative, packageId, hashOk, reused });
    if (relative.startsWith(`${FOLDERS.process}/`) && !processPackageId) processPackageId = packageId;
  }

  for (const file of expected.keys()) {
    if (!aasxPaths.some((p) => p.slice(base.length) === file)) problems.push(fill(tr('{0}: manifest에 있는데 번들에 없습니다.'), { 0: file }));
  }

  // Keep files added by people in the process file — restored on re-export (round-trip preservation)
  const kept: string[] = [];
  if (processPackageId) {
    for (const [path, bytes] of Object.entries(entries)) {
      if (!path.startsWith(base)) continue;
      const relative = path.slice(base.length);
      if (/\.aasx$/i.test(relative) || isGeneratedPath(relative)) continue;
      if (!ATTACHMENT_FOLDERS.some((folder) => relative.startsWith(`${folder}/`))) {
        problems.push(fill(tr('{0}: 번들 폴더(01·03~06) 밖이라 보관하지 않았습니다.'), { 0: relative }));
        continue;
      }
      await saveAttachment(store, processPackageId, checkAttachmentPath(relative), bytes);
      kept.push(relative);
    }
    const evidence = (manifest as { evidence?: Record<string, unknown>[] }).evidence ?? [];
    if (evidence.length > 0) {
      await writeCarried(store, processPackageId, {
        level: (manifest.bundle?.['evidenceLevel'] as string | null | undefined) ?? null,
        entries: evidence.map(({ carried: _carried, ...entry }) => entry),
        from: {
          ...(typeof manifest.bundle?.['code'] === 'string' ? { code: manifest.bundle['code'] } : {}),
          ...(typeof manifest.bundle?.['version'] === 'string' ? { version: manifest.bundle['version'] } : {}),
          ...(typeof manifest.bundle?.['createdAt'] === 'string' ? { createdAt: manifest.bundle['createdAt'] } : {}),
        },
      });
    }
  }

  return {
    bundle: manifest.bundle ?? {},
    ...(processPackageId ? { processPackageId } : {}),
    files,
    attachments: kept,
    problems,
  };
}

export interface BundleRouteOptions {
  policy?: Partial<LinterPolicy>;
  aasxLimits?: Partial<AasxLimits>;
}

export function bundleRoutes(store: AasStore, options: BundleRouteOptions = {}): Route[] {
  return [
    {
      /** For the UI — bundle composition, readiness status and linkage items */
      method: 'GET',
      pattern: '/packages/:packageId/bundle/linkage',
      success: [200],
      async handle({ params, request }) {
        const resolved = await resolveBundle(store, params['packageId']!);
        const linkage = await linkageFor(store, resolved);
        const members = [];
        type LintView = { passed: boolean; error: number; warning: number; aasd120: number };
        const checked = new Map<string, LintView>();
        for (const member of resolved.members) {
          let lintSummary: LintView | undefined;
          if (member.record) {
            lintSummary = checked.get(member.record.id);
            if (!lintSummary) {
              const { result } = lintBytes(await snapshotBytes(store, member.record.id), options.policy ?? {}, member.record);
              lintSummary = {
                passed: result.passed,
                error: result.countBySeverity.error,
                warning: result.countBySeverity.warning,
                // Important: KOSMO doesn't check it, but the standard validator (aas-test-engines) reports it as an **error** and BaSyx drops its children
                aasd120: result.countByRule['AASd-120'] ?? 0,
              };
              checked.set(member.record.id, lintSummary);
            }
          }
          members.push({
            name: member.name,
            globalAssetId: member.globalAssetId,
            bulkCount: member.bulkCount,
            groupPath: member.groupPath,
            ...(member.record ? { packageId: member.record.id, fileName: member.record.name } : {}),
            ...(member.info?.version ? { version: `${member.info.version}.${member.info.revision ?? '0'}` } : {}),
            ...(lintSummary ? { lint: lintSummary } : {}),
            ...(member.demo ? { demo: true } : {}),
          });
        }
        const sources = await gatherEvidence(
          store,
          resolved.members.filter((m) => m.record).map((m) => ({ name: m.name, record: m.record! })),
          evidenceWindow(request, new Date()),
        );
        const carried = await readCarried(store, resolved.process.id);
        // Collection record files are handled by "live operation evidence" — removing them from the attachment list would break carried-over evidence
        const attachments = (await listAttachments(store, resolved.process.id))
          .filter(({ path }) => !isEvidencePath(path))
          .map(({ path, size }) => ({ path, size }));
        return json(200, {
          process: { name: resolved.processInfo.idShort ?? resolved.process.name, fileName: resolved.process.name },
          categories: BUNDLE_CATEGORIES,
          members,
          linkage,
          evidence: {
            suggested: suggestedLevel(sources),
            levels: evidenceLevelNames(),
            sources: sources.map((s) => evidenceEntry(s)),
            // Record carried over when the bundle was opened — included when there is no new collection
            ...(carried ? { carried } : {}),
          },
          attachments,
          attachmentFolders: ATTACHMENT_FOLDERS,
        });
      },
    },
    {
      method: 'GET',
      pattern: '/packages/:packageId/bundle',
      success: [200],
      async handle({ params, request }) {
        const packageId = params['packageId']!;
        const record = await store.getPackage(packageId);
        if (!record) throw new ApiError(404, 'NotFound', tr('패키지를 찾을 수 없습니다.'));
        const bundleOpts = bundleOptions(request, record.name.replace(/\.aasx$/i, ''));
        const minutes = request.query['evidenceMinutes'];
        if (minutes !== undefined && minutes !== '' && minutes !== 'all') {
          evidenceWindow(request, new Date()); // format check
          bundleOpts.evidenceMinutes = Number(minutes);
        }
        const { zip, root } = await buildBundle(store, packageId, bundleOpts, options.policy ?? {}, new Date());
        return {
          status: 200,
          headers: {
            'content-type': 'application/zip',
            // ASCII name + UTF-8 original (spec VIII encoding item)
            'content-disposition': `attachment; filename="bundle-${bundleOpts.code}-v${bundleOpts.version}.zip"; filename*=UTF-8''${encodeURIComponent(`${root}.zip`)}`,
          },
          body: zip,
        };
      },
    },
    {
      /** Upload an attachment — body is the file bytes, path is e.g. ?path=01_UseCase문서/RB01.docx (01_UseCase "documents" folder) */
      method: 'PUT',
      pattern: '/packages/:packageId/bundle/files',
      success: [204],
      async handle({ params, request }) {
        const resolved = await resolveBundle(store, params['packageId']!);
        if (!(request.body instanceof Uint8Array)) throw new ApiError(400, 'BadRequest', tr('본문이 파일 바이트가 아닙니다.'));
        const path = checkAttachmentPath(request.query['path'] ?? '');
        await saveAttachment(store, resolved.process.id, path, request.body);
        return noContent();
      },
    },
    {
      /** Get an attachment — the UI fetches it and saves it as a file */
      method: 'GET',
      pattern: '/packages/:packageId/bundle/files',
      success: [200],
      fileDownload: true,
      async handle({ params, request }) {
        const path = checkAttachmentPath(request.query['path'] ?? '');
        const found = (await listAttachments(store, params['packageId']!)).find((a) => a.path === path);
        if (!found) throw new ApiError(404, 'NotFound', fill(tr('첨부가 없습니다: {0}'), { 0: path }));
        // Important: the stored type comes from the file name the uploader picked (an .svg can carry script) — user-file.ts
        //    decides by the bytes. A passive file is still offered under its name, so saving it keeps working
        const response = userFileResponse(found.data, path.split('/').pop());
        response.headers['content-disposition'] ??=
          `attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent(path.split('/').pop()!)}`;
        return response;
      },
    },
    {
      method: 'DELETE',
      pattern: '/packages/:packageId/bundle/files',
      success: [204],
      async handle({ params, request }) {
        const path = checkAttachmentPath(request.query['path'] ?? '');
        try {
          await removeAttachment(store, params['packageId']!, path);
        } catch {
          throw new ApiError(404, 'NotFound', fill(tr('첨부가 없습니다: {0}'), { 0: path }));
        }
        return noContent();
      },
    },
    {
      method: 'POST',
      pattern: '/bundles',
      success: [201],
      async handle({ request }) {
        if (!(request.body instanceof Uint8Array)) {
          throw new ApiError(400, 'BadRequest', tr('본문이 ZIP 바이트가 아닙니다.'));
        }
        return json(201, await importBundle(store, request.body, options.aasxLimits ?? {}, metamodelHintOf(request)));
      },
    },
  ];
}
