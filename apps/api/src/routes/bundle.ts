/**
 * 레퍼런스 번들 — 공정(묶음) 파일 하나를 **제출용 꾸러미 한 벌**로 내보내고 다시 연다.
 *
 * 근거: 레퍼런스번들_추진방안_정리_260930.md §2.1(폴더 구조) · §2.3(자체 검증 기준).
 *
 *   GET  /packages/{id}/bundle/linkage  공정에 묶인 설비들의 연계 항목 분석(화면용)
 *   GET  /packages/{id}/bundle          번들 ZIP — 공정 파일 + 설비 AASX + manifest + 폴더 골격
 *   POST /bundles                       번들 ZIP을 올려 공정·설비를 한 번에 연다(해시 대조)
 *
 * 🔴 번들은 **복사본이 아니라 지문이 붙은 사본**이다. 「모델은 v0.0.2로 바뀌었는데 번들에는
 *    v0.0.1이 남는」 사고를 막는 것이 manifest의 SHA256이다. writeAasx는 수정시각을 고정해
 *    같은 내용이면 같은 바이트를 내므로, 해시는 **내용이 같은가**를 그대로 말해 준다.
 * 🔴 이 도구의 검사 결과는 **사전 점검**이다. 번들에도 그렇게 적는다 — 공식 판정은
 *    KOSMO Validator 결과서다(CLAUDE.md 검증 도구 원칙). 🔴 Validator는 **장비별 AASX를 만들 때** 받는 검증이라
 *    번들에는 공식 검증기가 없다 — 번들이 Validator 판정을 받는 것처럼 쓰지 않는다(사용자 2026-09-30).
 * 🔴 문서(Use-Case·가이던스)는 쓰지 않는다. 폴더와 「채울 자리」만 만든다(문서용 자료와 같은 원칙).
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
import { PRODUCT_NAME, PRODUCT_VERSION, type Environment } from '@aas/core';
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
  evidenceHtml,
  gatherEvidence,
  suggestedLevel,
  type EvidenceLevel,
  type EvidenceSource,
} from './evidence.js';
import type { Route } from '../router.js';
import { localTimestamp } from './packages.js';

/** 레퍼런스 번들 분류 7건 — 코드는 manifest와 파일명에 쓴다 */
export const BUNDLE_CATEGORIES: Record<string, string> = {
  RB01: '생산최적화/품질관리',
  RB02: '에너지효율/지속가능성',
  RB03: '유연생산/자산관리',
  RB04: '데이터통합/보안',
  RB05: '지능형 자율제조/AI 에이전트',
  RB06: '설비 예지보전(PdM)',
  RB07: '공급망 디지털 연결',
};

export const BUNDLE_MANIFEST = 'bundle-manifest.json';
export const BUNDLE_SCHEMA = 'wace-reference-bundle/1';

const FOLDERS = {
  process: '00_공정구성',
  usecase: '01_UseCase문서',
  models: '02_참조모델',
  guidance: '03_가이던스',
  linkage: '04_데이터연계정의',
  samples: '05_샘플데이터',
  evidence: '06_검증결과',
} as const;

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

/** 묶음(공정·회사) 파일인가 — 화면(App.tsx fileUnit)과 같은 기준: assetType에 `/type/` */
const isComposite = (info: ShellInfo): boolean => (info.assetType ?? '').includes('/type/');

/**
 * Asset 주소 → 열린 파일. 같은 주소가 여럿이면 **가장 최근에 고친 것**을 고른다 —
 * 사람이 방금 고친 파일이 번들에 들어가야 한다.
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
 * 수집 연결(AID)이 붙은 파일인가. 🔴 AID를 붙인 파일은 **시연본**이다 — 접속 주소가 들어 있어
 * 제출 참조모델과 다른 파일이 된다. 번들 화면·manifest·README에 드러내 섞이지 않게 한다(2026-09-30)
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
  /** 공정 파일 안에서 이 설비가 매달린 그룹 경로 — ["WeldingProcess"] */
  groupPath: string[];
  record?: PackageRecord;
  info?: ShellInfo;
  /** 수집 연결(AID)이 붙은 시연본인가 */
  demo?: boolean;
}

interface ResolvedBundle {
  process: PackageRecord;
  processInfo: ShellInfo;
  /** 파일(설비·하위 묶음)을 가리키는 마디 전부. 같은 설비가 두 번 나와도 둘 다 */
  members: BundleMember[];
  /** 번들에 넣을 하위 묶음 파일(회사 > 공정처럼 겹친 경우) */
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
  if (!process) throw new ApiError(404, 'NotFound', '패키지를 찾을 수 없습니다.');
  const processInfo = await shellInfo(store, packageId);
  const top = await hierarchyOf(store, packageId);
  if (!top || !isComposite(processInfo)) {
    throw new ApiError(
      400,
      'BadRequest',
      '번들은 공정(묶음) 파일에서 만듭니다 — 이 파일은 설비 한 대 파일입니다.',
    );
  }

  const index = await assetIndex(store);
  const members: BundleMember[] = [];
  const nested: PackageRecord[] = [];
  const visited = new Set<string>([packageId]);

  const walk = async (nodes: HierarchyTreeNode[], groupPath: string[]): Promise<void> => {
    for (const node of nodes) {
      if (!node.globalAssetId) {
        // 그룹(중간 마디) — 파일이 없다. 경로에만 들어간다
        await walk(node.children, [...groupPath, node.name]);
        continue;
      }
      const record = index.get(node.globalAssetId);
      const info = record ? await shellInfo(store, record.id) : undefined;
      if (record && info && isComposite(info)) {
        // 🔴 하위 묶음은 펼친다. 순환은 계층 편집 때 막히지만 여기서도 한 번 더 막는다
        if (visited.has(record.id)) continue;
        visited.add(record.id);
        nested.push(record);
        await walk((await hierarchyOf(store, record.id)) ?? [], [...groupPath, node.name]);
        continue;
      }
      // 설비. 설비 파일 안의 계층은 부품(BoM)이라 펼치지 않는다
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
 * 번들에 넣을 바이트 — 올린 원본이 있고 **모델이 그대로면 원본**, 아니면 다시 포장한 것.
 * 같은지는 둘 다 같은 방식(writeAasx)으로 정규화해 비교한다 — 리비전 번호가 아니라 내용으로 판단한다
 */
async function modelBytes(store: AasStore, packageId: string): Promise<{ data: Uint8Array; original: boolean }> {
  const current = await exportBytes(store, packageId);
  const kept = (await store.packageFiles(packageId)).find((file) => file.part === ORIGINAL_PART);
  if (kept) {
    try {
      const normalized = writeAasx(readAasx(kept.data));
      if (sha256(normalized) === sha256(current)) return { data: kept.data, original: true };
    } catch {
      // 원본을 못 읽으면 다시 포장한 것을 쓴다
    }
  }
  return { data: current, original: false };
}

async function exportBytes(store: AasStore, packageId: string): Promise<Uint8Array> {
  return writeAasx(await store.exportPackage(packageId));
}

function lintBytes(data: Uint8Array, policy: Partial<LinterPolicy>) {
  const pkg = readAasx(data);
  return {
    pkg,
    result: lint(pkg.environment, ALL_RULES, {
      package: pkg.opc,
      ...(Object.keys(policy).length > 0 ? { policy } : {}),
    }),
  };
}

/** 번들에 넣을 파일명 — 원래 이름을 지키되 경로 문자는 뺀다 */
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
  /** 증빙 수준. 'auto'면 인터페이스 이름으로 제안(시뮬레이션뿐이면 C), 아니면 비워 둔다 */
  evidence?: EvidenceLevel | 'auto' | 'none';
  /** 최근 N분 수집값만 싣는다. 비우면 전부 */
  evidenceMinutes?: number;
}

/** `evidenceMinutes` 질의 → 시작 시각(ISO) */
function evidenceWindow(request: ApiRequest, now: Date): { from?: string } {
  const raw = request.query['evidenceMinutes'];
  if (raw === undefined || raw === '' || raw === 'all') return {};
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new ApiError(400, 'BadRequest', `evidenceMinutes는 양수(분)입니다: ${raw}`);
  }
  return { from: new Date(now.getTime() - minutes * 60_000).toISOString() };
}

function bundleOptions(request: ApiRequest, fallbackTitle: string): BundleOptions {
  const code = (request.query['code'] ?? 'RB00').toUpperCase();
  if (!/^RB\d{2}$/.test(code)) throw new ApiError(400, 'BadRequest', '번들 코드는 RB01 형식입니다.');
  const version = request.query['version'] ?? '1.0.0';
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new ApiError(400, 'BadRequest', '버전은 1.0.0 형식입니다(운영 가이드라인과 같은 3자리).');
  }
  const title = (request.query['title'] ?? '').trim() || BUNDLE_CATEGORIES[code] || fallbackTitle;
  const evidence = (request.query['evidence'] ?? 'auto').toUpperCase();
  if (!['A', 'B', 'C', 'AUTO', 'NONE'].includes(evidence)) {
    throw new ApiError(400, 'BadRequest', '증빙 수준은 A·B·C·auto·none 중 하나입니다.');
  }
  return {
    code,
    title,
    version,
    evidence: (['AUTO', 'NONE'].includes(evidence) ? evidence.toLowerCase() : evidence) as BundleOptions['evidence'],
  };
}

/** 트리를 글자로 — README와 화면이 같은 모양을 쓴다 */
function treeText(rootName: string, members: BundleMember[]): string {
  const lines = [rootName];
  let lastGroup = '';
  for (const member of members) {
    const group = member.groupPath.join(' > ');
    if (group && group !== lastGroup) lines.push(`  ▦ ${group}`);
    lastGroup = group;
    const indent = group ? '      ' : '  ';
    const count = member.bulkCount > 1 ? ` ×${member.bulkCount}대` : '';
    const file = member.record ? member.record.name : '(파일 없음 — 예정)';
    lines.push(`${indent}⚙ ${member.name}${count}  ${file}`);
  }
  return lines.join('\n');
}

const pendingNote = (title: string, lines: string[]): string =>
  [`# ${title}`, '', '> 이 파일은 **채울 자리 안내**입니다. 도구가 문서를 대신 쓰지 않습니다.', '', ...lines, ''].join('\n');

/** manifest·README·화면이 함께 쓰는 증빙 요약 — 값 자체는 빼고 */
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

/** 번들 ZIP과 manifest를 만든다 */
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
  // 「누가 내보냈나」 — 요청 문맥에서 집어 온다(actor.ts). 로그인을 안 쓰는 서버면 undefined
  const exporter = currentActor();
  // 사람이 읽는 문서(결과서·기록서)는 서버 지역 시각 — /report와 같은 규칙. manifest는 ISO 그대로
  const printed = localTimestamp(now);

  // ① 공정 구성 — 공정 파일(과 하위 묶음). 🔴 참조모델로 제출하지 않는다(필수 서브모델 4종 없음)
  const processFiles = [];
  for (const record of [resolved.process, ...resolved.nested]) {
    const data = await exportBytes(store, record.id);
    const { result, pkg } = lintBytes(data, policy);
    const hier = result.findings.filter((f) => f.ruleId.startsWith('HIER-') && f.severity === 'error').length;
    const path = `${FOLDERS.process}/${safeName(record.name)}`;
    put(path, data);
    put(
      `${FOLDERS.evidence}/사전점검_${safeName(record.name.replace(/\.aasx$/i, ''))}.html`,
      formatHtmlReport(result, { title: `${record.name} (공정 구성 — 사전 점검)`, generatedAt: printed, policy: effectivePolicy }),
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

  // ② 참조모델 — 설비 AASX. 같은 설비가 두 공정에 있어도 파일은 한 번만 넣는다
  interface ModelEntry {
    assetName: string;
    globalAssetId: string;
    groupPath: string[];
    bulkCount: number;
    sourceName: string;
    version?: string;
    revision?: string;
    file: string;
    /** 같은 파일이 이미 번들에 있으면 첫 자리를 가리킨다 */
    duplicateOf?: string;
    /** 수집 연결(AID)이 붙은 시연본 — 제출 참조모델로 쓰면 안 된다 */
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
      const { result } = lintBytes(data, policy);
      path = `${FOLDERS.models}/${safeName(member.record.name)}`;
      packed.set(member.record.id, path);
      put(path, data);
      put(
        `${FOLDERS.evidence}/사전점검_${safeName(member.record.name.replace(/\.aasx$/i, ''))}.html`,
        formatHtmlReport(result, { title: `${member.record.name} (사전 점검)`, generatedAt: printed, policy: effectivePolicy }),
      );
      entry = {
        file: path,
        sha256: sha256(data),
        // true — 올린 원본 그대로(운영기관 제출본과 해시가 같다). false — 도구에서 고쳐 다시 포장했다
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

  // ②-1 실동작 증빙 — 설비 자신과 거기서 파생된 호기(derivedFrom)의 수집값. 시연을 대신하는 기록
  const evidenceSources = await gatherEvidence(
    store,
    resolved.members.filter((m) => m.record).map((m) => ({ name: m.name, record: m.record! })),
    options.evidenceMinutes ? { from: new Date(now.getTime() - options.evidenceMinutes * 60_000).toISOString() } : {},
  );
  // 새 수집이 없으면 이전 번들의 증빙을 이어받는다 — 번들을 다시 열어 모델만 고친 경우다
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
      const csvPath = `${FOLDERS.samples}/수집값_${safeName(source.instance)}.csv`;
      put(csvPath, evidenceCsv(source));
      evidenceEntries.push(evidenceEntry(source, csvPath));
    }
    put(
      `${FOLDERS.evidence}/수집기록.html`,
      evidenceHtml({
        title: `${options.code} ${options.title}`,
        level,
        generatedAt: printed,
        tool: `${PRODUCT_NAME} ${PRODUCT_VERSION}`,
        sources: evidenceSources,
      }),
    );
  }

  // ③ 연계 정의 — 공통 항목표(초안). 「연계 키」「KPI 용도」는 사람이 채운다
  const linkage = await linkageFor(store, resolved);
  put(`${FOLDERS.linkage}/연계항목_초안.csv`, linkageCsv(linkage));
  const findingLines = linkage.findings.map((f) => `- ${f.severity === 'warning' ? '⚠' : 'ℹ'} ${f.message}`);
  put(
    `${FOLDERS.linkage}/연계_확인사항.md`,
    [
      '# 데이터 연계 — 확인할 점',
      '',
      `분석 대상: 설비 ${linkage.members.length}대의 OperationalData · 공통 항목(2대 이상) ${linkage.items.filter((i) => i.coverage >= 2).length}개`,
      linkage.missing.length > 0 ? `\n분석에서 빠진 설비(파일 없음): ${linkage.missing.join(', ')}` : '',
      '',
      '연계 매핑은 **semanticId만으로 잡지 말고 경로(idShort 경로)를 함께** 적습니다.',
      '같은 semanticId를 서로 다른 개념이 쓰는 사례가 실측으로 확인됐습니다(사업 참조모델 30종, 2026-09-30).',
      '',
      ...(findingLines.length > 0 ? findingLines : ['- 확인할 점 없음']),
      '',
    ].join('\n'),
  );

  // ④ 채울 자리 — 문서는 사람이 쓴다
  put(
    `${FOLDERS.usecase}/_작성안내.md`,
    pendingNote('Use-Case 문서 (hwpx 또는 docx + pdf)', [
      '목차(안) — 추진방안 §2.2',
      '',
      '1. 개요: 카테고리, 대상 업종·공정, 현장 문제, **데이터 출처와 증빙 수준(A 현장 적용 / B 실장비 재현 / C 시뮬레이션)**',
      '2. 공정 흐름과 장비 구성 — `README.md`의 구성 트리, 「문서용 자료」의 구성도',
      '3. Use-Case 시나리오: 붙임6 매핑 근거, 액터, 단계별 흐름',
      `4. 데이터 연계 구조 — \`${FOLDERS.linkage}/연계항목_초안.csv\``,
      '5. KPI 산출: 산식, 필요한 Property, 샘플 계산',
      '6. 실증: BaSyx 통합 적재, REST 조회 예시, 시연 화면',
      '7. 중소기업 도입 절차: 다운로드 → 자사 값 입력 → 연동',
      '8. 부록: 용어, 참조 표준, 용어사전 버전',
    ]),
  );
  put(
    `${FOLDERS.guidance}/_작성안내.md`,
    pendingNote('가이던스 (장비별 1:1)', [
      '아래 설비마다 제출한 가이던스를 넣습니다. 참조모델과 **같은 버전**이어야 합니다.',
      '',
      ...[...new Set(resolved.members.filter((m) => m.record).map((m) => m.record!.name))].map(
        (name) => `- [ ] ${name.replace(/\.aasx$/i, '')}_AAS활용가이던스`,
      ),
    ]),
  );
  put(
    `${FOLDERS.samples}/_작성안내.md`,
    pendingNote('샘플 데이터 (KPI 산출용)', [
      '- 🔴 실데이터는 **기업 동의·비식별화 후**에만 넣습니다(GitHub 공개 대상).',
      '- 가상 PLC 데이터는 파일명과 본문에 **「시뮬레이션」** 을 표기합니다.',
    ]),
  );

  // ④-1 사람이 넣은 첨부 — 공정 파일에 보관된 것을 되살린다. 도구가 만든 것과 겹치면 도구 것이 이긴다.
  //      새 수집 기록이 있으면 옛 수집 기록은 통째로 뺀다(새 기록서와 옛 CSV가 섞이지 않게)
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
      // 🔴 **누가 내보냈나.** 제출 꾸러미라 「언제·무엇을」만으로는 모자라고, 나중에
      //    물어볼 사람이 적혀 있어야 한다. 로그인을 안 쓰는 서버면 null이다 —
      //    모르는 것을 아는 척하지 않는다
      createdBy: exporter?.name ?? null,
      tool: `${PRODUCT_NAME} ${PRODUCT_VERSION}`,
      // 증빙 수준(A/B/C) — 사람이 고른 것. 고르지 않았으면 시뮬레이션뿐일 때만 C를 제안하고 그 밖엔 비운다
      evidenceLevel: level,
    },
    evidence: evidenceEntries,
    /** 사람이 넣은 문서·증빙 — 번들을 다시 열어도 보존된다 */
    attachments,
    process: processFiles,
    models,
    planned,
    linkage: {
      file: `${FOLDERS.linkage}/연계항목_초안.csv`,
      analyzedMembers: linkage.members.length,
      commonItems: linkage.items.filter((i) => i.coverage >= 2).length,
      warnings: linkage.findings.filter((f) => f.severity === 'warning').length,
    },
    notes: [
      '모델의 공식 검증(KOSMO Validator)은 장비별 AASX를 만들 때 받는 것이다. 여기 lint는 번들에 넣은 모델을 이 도구가 다시 확인한 참고 기록이다.',
      '번들 자체의 확인은 해시 대조 · 공정 구성(HIER) · 데이터 연계 · 실동작 증빙으로 한다.',
      '공정 구성 파일은 참조모델로 제출하지 않는다(설비 필수 서브모델 4종이 없다).',
    ],
  };
  put(BUNDLE_MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);

  const uniqueModels = models.filter(
    (m): m is ModelEntry & Required<Pick<ModelEntry, 'sha256' | 'lint'>> => m.sha256 !== undefined && m.lint !== undefined,
  );
  put(
    'README.md',
    [
      `# ${options.code} ${options.title} — 레퍼런스 번들 v${options.version}`,
      '',
      `- 카테고리: ${BUNDLE_CATEGORIES[options.code] ?? '(미지정)'}`,
      `- 만든 날: ${stamp.slice(0, 10)} · 도구: ${PRODUCT_NAME} ${PRODUCT_VERSION}`,
      ...(exporter ? [`- 내보낸 사람: ${exporter.name}`] : []),
      level
        ? `- 증빙 수준: **${level}** — ${EVIDENCE_LEVELS[level]}`
        : `- 증빙 수준: **(사람이 채움 — A 현장 적용 / B 실장비 재현 / C 시뮬레이션)**`,
      '',
      '## 공정 구성',
      '',
      '```',
      treeText(resolved.processInfo.idShort ?? resolved.process.name, resolved.members),
      '```',
      '',
      '## 포함 참조모델',
      '',
      '| 파일 | 버전 | SHA256(앞 12자) | 원본 | 사전 점검 |',
      '|---|---|---|---|---|',
      ...uniqueModels.map(
        (m) =>
          `| ${m.sourceName} | ${m.version ?? '-'}.${m.revision ?? '-'} | \`${m.sha256.slice(0, 12)}\` | ${m.original ? '올린 파일 그대로' : '⚠ 도구에서 고쳐 다시 포장'} | ${m.lint.passed ? '통과' : `위반 ${m.lint.error}`} · 경고 ${m.lint.warning} |`,
      ),
      ...(planned.length > 0
        ? ['', `**파일이 없는 설비(예정)**: ${planned.map((p) => p.assetName).join(', ')} — 번들 완성 전에 채웁니다.`]
        : []),
      ...(models.some((m) => m.demo)
        ? [
            '',
            `> ⚡ **시연본 포함**: ${[...new Set(models.filter((m) => m.demo).map((m) => m.sourceName))].join(', ')} — 수집 연결(AID)이 붙어 있습니다.`,
            '> 제출용 번들에는 수집 연결이 없는 **원본 참조모델**을 넣으십시오.',
          ]
        : []),
      '',
      '## 실동작 증빙',
      '',
      ...(carried
        ? [
            `> 이전 번들(${carried.from.code ?? ''} v${carried.from.version ?? '?'})에서 **이어받은 수집 기록**입니다 — 이번에 새로 모은 값은 없습니다.`,
            '',
          ]
        : []),
      ...(evidenceEntries.length > 0
        ? [
            `시연 대신 **수집 기록**을 싣습니다 — \`${FOLDERS.evidence}/수집기록.html\`(인쇄하면 PDF), 전체 값은 \`${FOLDERS.samples}/수집값_*.csv\`.`,
            '',
            '| 설비(형식) | 값을 모은 파일 | 수집 연결 | 기간 | 건수 |',
            '|---|---|---|---|---|',
            ...(evidenceEntries as ReturnType<typeof evidenceEntry>[]).map(
              (e) =>
                `| ${e.model} | ${e.instance}${e.direct ? '' : ' (파생 호기)'} | ${e.interfaces.map((i) => `${i.title} \`${i.endpoint}\``).join('<br>')} | ${localTimestamp(new Date(e.from))} ~ ${localTimestamp(new Date(e.to)).slice(11)} | ${e.samples} |`,
            ),
          ]
        : ['수집 기록이 없습니다. 이 번들의 설비(또는 「호기별로 나누기」로 만든 호기)를 수집한 뒤 다시 내보내면 여기에 실립니다.']),
      '',
      '### 재현 방법 — 누구나 직접 돌려 볼 수 있습니다',
      '',
      '1. AAS 저작 도구(설치판)를 띄우고 **「번들 열기」**로 이 ZIP을 엽니다 — 알림 띠에 해시 일치가 나옵니다',
      '2. 공정 트리에서 설비를 열고, 오른쪽 수집 칸의 **「가상 PLC로 연결」**을 누릅니다 — 도구 안의 가상 PLC(시뮬레이션)가 그 설비의 운전 데이터 이름대로 태그를 세우고 수집 연결을 만듭니다',
      '3. **「수집」**을 누르면 값이 들어옵니다(🟢 연결됨). 제출본을 건드리지 않으려면 먼저 「호기별로 나누기」로 호기를 만들어 그쪽에서 하십시오',
      '',
      '## 사람이 넣은 문서',
      '',
      ...(attachments.length > 0
        ? ['| 파일 | 크기 |', '|---|---|', ...attachments.map((a) => `| ${a.path} | ${(a.size / 1024).toFixed(1)} KB |`)]
        : ['아직 없습니다 — Use-Case 문서와 장비별 가이던스를 해당 폴더에 넣으십시오(도구 「레퍼런스 번들 → 문서·첨부」에서 올리면 다시 열어도 보존됩니다).']),
      '',
      '## 폴더',
      '',
      `| 폴더 | 내용 |`,
      '|---|---|',
      `| ${FOLDERS.process} | 공정 구성 파일(HierarchicalStructures). 참조모델로 제출하지 않음 |`,
      `| ${FOLDERS.usecase} | Use-Case 문서 — 작성 안내 |`,
      `| ${FOLDERS.models} | 설비 참조모델 AASX (해시는 ${BUNDLE_MANIFEST}) |`,
      `| ${FOLDERS.guidance} | 장비별 가이던스 — 넣을 목록 |`,
      `| ${FOLDERS.linkage} | 연계 항목 초안(CSV) · 확인할 점 |`,
      `| ${FOLDERS.samples} | KPI 산출용 샘플 데이터(수집값 CSV) — 비식별화 |`,
      `| ${FOLDERS.evidence} | 사전 점검 결과서(참고) · 수집 기록서(HTML) |`,
      '',
      '> 참조모델의 공식 검증(KOSMO Validator)은 **장비별 AASX를 만들 때** 받은 것입니다. 이 번들의 사전 점검은 넣은 모델을 다시 확인한 참고 기록이고,',
      '> 번들 자체는 해시 대조 · 공정 구성(HIER) · 데이터 연계 · 실동작 증빙으로 확인합니다.',
      '',
    ].join('\n'),
  );

  return { zip: zipArchive(files), manifest, root };
}

// ── 번들 열기 ──────────────────────────────────────────────────────────────

export interface BundleImportResult {
  bundle: Record<string, unknown>;
  processPackageId?: string;
  /** 공정 파일에 보관한 사람 파일 — 다시 내보내면 되살아난다 */
  attachments: string[];
  files: {
    file: string;
    packageId: string;
    /** manifest의 해시와 같은가. manifest에 없는 파일이면 null */
    hashOk: boolean | null;
    /** 이미 열려 있던 같은 내용의 파일을 그대로 썼는가 */
    reused: boolean;
  }[];
  problems: string[];
}

export async function importBundle(
  store: AasStore,
  data: Uint8Array,
  limits: Partial<AasxLimits>,
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
    throw new ApiError(400, 'BadRequest', `${BUNDLE_MANIFEST}가 없습니다 — 이 도구로 만든 레퍼런스 번들이 아닙니다.`);
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
    throw new ApiError(400, 'BadRequest', `${BUNDLE_MANIFEST}를 읽을 수 없습니다.`);
  }
  if (manifest.schema !== BUNDLE_SCHEMA) {
    throw new ApiError(400, 'BadRequest', `지원하지 않는 번들 형식입니다: ${String(manifest.schema)}`);
  }
  const base = manifestPath.slice(0, manifestPath.length - BUNDLE_MANIFEST.length);
  const expected = new Map<string, string>();
  for (const entry of [...(manifest.process ?? []), ...(manifest.models ?? [])]) {
    if (entry.sha256) expected.set(entry.file, entry.sha256);
  }

  // 이미 열린 파일의 지문 — 같은 내용이면 새로 올리지 않는다(같은 Asset 주소가 둘이면 공정이 헷갈린다)
  const opened = new Map<string, string>();
  const all = await store.listPackages({ limit: 1000 });
  for (const record of all.items) opened.set(sha256((await modelBytes(store, record.id)).data), record.id);

  const problems: string[] = [];
  const files: BundleImportResult['files'] = [];
  let processPackageId: string | undefined;
  // 설비 먼저, 공정 나중 — 공정이 열릴 때 가리킬 설비가 이미 있어야 화면이 바로 이어 그린다
  const aasxPaths = Object.keys(entries)
    .filter((p) => p.startsWith(base) && /\.aasx$/i.test(p))
    .sort((a, b) => Number(a.slice(base.length).startsWith('00_')) - Number(b.slice(base.length).startsWith('00_')));

  for (const path of aasxPaths) {
    const relative = path.slice(base.length);
    const bytes = entries[path]!;
    const digest = sha256(bytes);
    const want = expected.get(relative);
    const hashOk = want === undefined ? null : want === digest;
    if (hashOk === false) problems.push(`${relative}: manifest의 해시와 다릅니다 — 번들을 만든 뒤 파일이 바뀌었습니다.`);
    if (want === undefined) problems.push(`${relative}: manifest에 없는 파일입니다.`);

    let packageId = opened.get(digest);
    const reused = packageId !== undefined;
    if (!packageId) {
      const pkg = readAasx(bytes, { limits });
      const name = relative.split('/').pop()!;
      // 원본을 함께 보관 — 다시 내보내도 같은 바이트, 해시가 이어진다
      packageId = (await store.importPackage({ name, package: pkg, keep: [originalFile(bytes)] })).id;
      opened.set(digest, packageId);
    }
    files.push({ file: relative, packageId, hashOk, reused });
    if (relative.startsWith(`${FOLDERS.process}/`) && !processPackageId) processPackageId = packageId;
  }

  for (const file of expected.keys()) {
    if (!aasxPaths.some((p) => p.slice(base.length) === file)) problems.push(`${file}: manifest에 있는데 번들에 없습니다.`);
  }

  // 사람이 넣은 파일을 공정 파일에 보관한다 — 다시 내보낼 때 되살린다(왕복 보존)
  const kept: string[] = [];
  if (processPackageId) {
    for (const [path, bytes] of Object.entries(entries)) {
      if (!path.startsWith(base)) continue;
      const relative = path.slice(base.length);
      if (/\.aasx$/i.test(relative) || isGeneratedPath(relative)) continue;
      if (!ATTACHMENT_FOLDERS.some((folder) => relative.startsWith(`${folder}/`))) {
        problems.push(`${relative}: 번들 폴더(01·03~06) 밖이라 보관하지 않았습니다.`);
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
      /** 화면용 — 번들 구성과 준비 상태, 연계 항목 */
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
              const { result } = lintBytes(await exportBytes(store, member.record.id), options.policy ?? {});
              lintSummary = {
                passed: result.passed,
                error: result.countBySeverity.error,
                warning: result.countBySeverity.warning,
                // 🔴 KOSMO는 안 보지만 표준 검증기(aas-test-engines)는 **오류**로 보고 BaSyx는 그 하위를 버린다
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
        // 수집 기록 파일은 「실동작 증빙」이 맡는다 — 첨부 목록에서 지우면 이어받은 증빙이 깨진다
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
            levels: EVIDENCE_LEVELS,
            sources: sources.map((s) => evidenceEntry(s)),
            // 번들을 열 때 이어받은 기록 — 새 수집이 없으면 이것이 실린다
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
        if (!record) throw new ApiError(404, 'NotFound', '패키지를 찾을 수 없습니다.');
        const bundleOpts = bundleOptions(request, record.name.replace(/\.aasx$/i, ''));
        const minutes = request.query['evidenceMinutes'];
        if (minutes !== undefined && minutes !== '' && minutes !== 'all') {
          evidenceWindow(request, new Date()); // 형식 검사
          bundleOpts.evidenceMinutes = Number(minutes);
        }
        const { zip, root } = await buildBundle(store, packageId, bundleOpts, options.policy ?? {}, new Date());
        return {
          status: 200,
          headers: {
            'content-type': 'application/zip',
            // ASCII 이름 + UTF-8 원본(기획서 Ⅷ 인코딩 항목)
            'content-disposition': `attachment; filename="bundle-${bundleOpts.code}-v${bundleOpts.version}.zip"; filename*=UTF-8''${encodeURIComponent(`${root}.zip`)}`,
          },
          body: zip,
        };
      },
    },
    {
      /** 첨부 올리기 — 본문은 파일 바이트, 경로는 ?path=01_UseCase문서/RB01.docx */
      method: 'PUT',
      pattern: '/packages/:packageId/bundle/files',
      success: [204],
      async handle({ params, request }) {
        const resolved = await resolveBundle(store, params['packageId']!);
        if (!(request.body instanceof Uint8Array)) throw new ApiError(400, 'BadRequest', '본문이 파일 바이트가 아닙니다.');
        const path = checkAttachmentPath(request.query['path'] ?? '');
        await saveAttachment(store, resolved.process.id, path, request.body);
        return noContent();
      },
    },
    {
      /** 첨부 받기 — 화면에서 열어 본다 */
      method: 'GET',
      pattern: '/packages/:packageId/bundle/files',
      success: [200],
      async handle({ params, request }) {
        const path = checkAttachmentPath(request.query['path'] ?? '');
        const found = (await listAttachments(store, params['packageId']!)).find((a) => a.path === path);
        if (!found) throw new ApiError(404, 'NotFound', `첨부가 없습니다: ${path}`);
        return {
          status: 200,
          headers: {
            'content-type': found.contentType,
            'content-disposition': `attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent(path.split('/').pop()!)}`,
          },
          body: found.data,
        };
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
          throw new ApiError(404, 'NotFound', `첨부가 없습니다: ${path}`);
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
          throw new ApiError(400, 'BadRequest', '본문이 ZIP 바이트가 아닙니다.');
        }
        return json(201, await importBundle(store, request.body, options.aasxLimits ?? {}));
      },
    },
  ];
}
