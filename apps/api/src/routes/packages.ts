/**
 * AASX 파일 서버 인터페이스 — IDTA-01002-3-0 `AasxFileServerServiceSpecification/SSP-001`.
 *
 * 처음에는 우리 임의 경로로 만들었다가, 규격 원문(docs/spec/part2/)을 확보해 대조하면서
 * **표준에 같은 경로가 이미 있다는 것**을 발견해 규격에 맞췄다.
 *   GET  /packages                 패키지 목록(PackageDescription)
 *   POST /packages                 multipart/form-data로 AASX 저장 → 201 + Location
 *   GET  /packages/{packageId}     **AASX 파일 자체**를 준다 (JSON 메타데이터가 아니다)
 *   PUT  /packages/{packageId}     교체 → 204
 *   DELETE /packages/{packageId}   삭제 → 204
 *
 * 우리 고유 확장은 규격 경로를 침범하지 않도록 하위 경로로 뺐다 — `/metadata` · `/lint` · `/fix`.
 * 규격에 없는 경로를 우리가 열었는지는 `node scripts/part2-coverage.mjs`가 감시한다.
 */
import { DEFAULT_SPEC_PART, readAasx, writeAasx, type AasxLimits } from '@aas/aasx';
import {
  AidBuildError,
  aidConceptDescriptions,
  mergeRuntimeGroup,
  RuntimeBuildError,
  valuedNames,
  buildAidSubmodel,
  CollectionRunner,
  latestByProperty,
  overlayEnvironment,
  parseAid,
  type AidInterface,
  type ProtocolReader,
} from '@aas/collector';
import {
  ALL_RULES,
  DEFAULT_POLICY,
  formatHtmlReport,
  addChild,
  childNodes,
  findEntryNode,
  hierarchyTree,
  HIERARCHY_SUBMODEL_ID_SHORT,
  isValidAssetName,
  lint,
  ruleCatalog,
  overviewUml,
  planFor,
  submodelInfo,
  submodelTable,
  submodelTables,
  submodelTablesHtml,
  submodelUml,
  tableCsv,
  lintAndFix,
  revertRelocations,
  type FixSelector,
  placeholderThumbnail,
  removeChild,
  renameEnvironment,
  scaffoldEnvironment,
  type Finding,
  type LinterPolicy,
} from '@aas/linter';
import type { Environment } from '@aas/core';
import {
  IDENTIFIABLE_MODEL_TYPES,
  type AasStore,
  type IdentifiableModelType,
  type PackageRecord,
} from '@aas/store';
import { decodeIdentifier } from '../base64url.js';
import { ApiError, bytes, json, noContent, pagedResponse, type ApiRequest } from '../http.js';
import { fieldValues, fileOf, MultipartError, parseMultipart } from '../multipart.js';
import type { Route } from '../router.js';
import { originalFile } from './bundle-files.js';

/** AASX 패키지의 미디어 타입 (규격 AasxFileServer §GetAASXByPackageId) */
export const AASX_MEDIA_TYPE = 'application/asset-administration-shell-package';

/**
 * 결과서에 찍는 시각 — 제출 문서라 **서버의 지역 시각**으로 적는다.
 * ISO(UTC)로 찍었더니 화면 시계와 9시간 어긋난 문서가 나갔다(2026-09-03 시연).
 * 초는 뺀다 — 문서를 구분하는 데는 분이면 충분하고, 눈으로 대조하기 쉽다
 */
export function localTimestamp(at: Date): string {
  const two = (n: number) => String(n).padStart(2, '0');
  return `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())} ${two(at.getHours())}:${two(at.getMinutes())}`;
}

interface UploadedPackage {
  name: string;
  data: Uint8Array;
}

/**
 * 업로드 본문을 읽는다.
 *  - 규격: multipart/form-data (fileName · file · aasIds)
 *  - 확장: 본문에 AASX 바이트를 그대로 두고 `?name=` — 우리 저작 UI가 쓰기 편한 형태다
 */
function uploadedPackage(request: ApiRequest): UploadedPackage {
  const contentType = request.headers['content-type'] ?? '';
  const body = request.body;

  if (contentType.includes('multipart/form-data')) {
    if (!(body instanceof Uint8Array)) {
      throw new ApiError(400, 'BadRequest', 'multipart 본문을 읽지 못했습니다.');
    }
    let parts;
    try {
      parts = parseMultipart(body, contentType);
    } catch (error) {
      throw new ApiError(400, 'BadRequest', error instanceof MultipartError ? error.message : String(error));
    }
    const file = fileOf(parts, 'file');
    if (!file) throw new ApiError(400, 'BadRequest', 'file 조각이 없습니다.');
    const name = fieldValues(parts, 'fileName')[0] ?? file.filename ?? 'package.aasx';
    return { name, data: file.data };
  }

  if (!(body instanceof Uint8Array)) {
    throw new ApiError(400, 'BadRequest', '본문이 AASX 바이트가 아닙니다.');
  }
  const name = request.query['name'];
  if (!name) {
    throw new ApiError(
      400,
      'BadRequest',
      'multipart/form-data로 보내거나(규격), name 질의 인자를 함께 주십시오(확장).',
    );
  }
  return { name, data: body };
}

/** 규격의 PackageDescription. 우리 메타데이터를 덧붙인다(규격은 추가 속성을 막지 않는다) */
async function packageDescription(
  store: AasStore,
  record: PackageRecord,
): Promise<Record<string, unknown>> {
  const shells = await store.listIdentifiables(record.id, 'AssetAdministrationShell');
  const first = shells.items[0];
  return {
    packageId: record.id,
    aasIds: shells.items.map((r) => r.id),
    // ↓ 규격 밖 확장. 표준 클라이언트는 모르는 필드를 무시한다
    name: record.name,
    // 🔴 장비명과 Asset 주소를 목록에 함께 실어 준다. 공정을 만들 때 "이 파일이 무슨
    //    설비인지"를 알아야 고를 수 있는데, 파일명은 「03-SPR장비-뿌80.aasx」처럼
    //    사업 번호가 섞여 있어 그것만으로는 판단이 안 된다
    assetName: first?.idShort,
    globalAssetId: (first?.content as { assetInformation?: { globalAssetId?: string } } | undefined)
      ?.assetInformation?.globalAssetId,
    // 공정(묶음) 파일인지 — 화면이 설비와 공정을 가르는 표준 필드(…/type/*)
    assetType: (first?.content as { assetInformation?: { assetType?: string } } | undefined)?.assetInformation
      ?.assetType,
    revision: record.revision,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/**
 * 저장본을 AASX로 되돌려 L1(패키지) 규칙까지 검사할 수 있게 한다.
 * L1 규칙은 ZIP 파트·관계·Content_Types를 보므로 Environment만으로는 검사할 수 없다.
 */
async function snapshot(store: AasStore, packageId: string): Promise<ReturnType<typeof readAasx>> {
  const exported = await store.exportPackage(packageId);
  return readAasx(writeAasx(exported));
}

/**
 * 교정 결과를 저장소에 반영한다.
 * id가 바뀐 교정(IRI 이관)은 삭제 + 생성으로 나타난다 — 새 id는 다른 신원이므로 그게 맞다.
 * 이관 대장(relocations)이 그 연결을 대신 기록한다.
 */
async function writeBackEnvironment(
  store: AasStore,
  packageId: string,
  next: Environment,
): Promise<{ created: number; updated: number; deleted: number }> {
  const counts = { created: 0, updated: 0, deleted: 0 };
  const fields: Record<IdentifiableModelType, keyof Environment> = {
    AssetAdministrationShell: 'assetAdministrationShells',
    Submodel: 'submodels',
    ConceptDescription: 'conceptDescriptions',
  };

  for (const modelType of IDENTIFIABLE_MODEL_TYPES) {
    const incoming = (next[fields[modelType]] ?? []) as unknown as Record<string, unknown>[];
    const incomingIds = new Set(incoming.map((c) => String(c['id'])));

    const existing: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await store.listIdentifiables(packageId, modelType, {
        limit: 200,
        ...(cursor ? { cursor } : {}),
      });
      existing.push(...page.items.map((r) => r.id));
      cursor = page.cursor;
    } while (cursor);

    for (const content of incoming) {
      const id = String(content['id']);
      if (existing.includes(id)) {
        const current = await store.getIdentifiable(packageId, modelType, id);
        if (current && JSON.stringify(current.content) === JSON.stringify(content)) continue;
        await store.updateIdentifiable(packageId, modelType, id, content);
        counts.updated += 1;
      } else {
        await store.createIdentifiable(packageId, content);
        counts.created += 1;
      }
    }

    for (const id of existing) {
      if (incomingIds.has(id)) continue;
      await store.deleteIdentifiable(packageId, modelType, id);
      counts.deleted += 1;
    }
  }

  return counts;
}

function bodyObject(request: ApiRequest): Record<string, unknown> {
  const body = request.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body) || body instanceof Uint8Array) {
    throw new ApiError(400, 'BadRequest', '본문이 JSON 객체가 아닙니다.');
  }
  return body as Record<string, unknown>;
}

/** Reference의 첫 키 값 */
/**
 * 공정 파일의 계층 서브모델을 찾아 준다.
 *
 * 🔴 없으면 404가 아니라 **400**이다. 파일은 있는데 이 기능을 쓸 수 있는 파일이 아닌 것이라,
 *    "없는 것을 달라고 했다"보다 "설비 파일에 공정 기능을 썼다"는 쪽이 맞는 설명이다.
 */
async function findHierarchy(
  store: AasStore,
  packageId: string,
): Promise<{ submodel: Record<string, unknown>; record: PackageRecord }> {
  const record = await store.getPackage(packageId);
  if (!record) throw new ApiError(404, 'NotFound', '패키지를 찾을 수 없습니다.');
  const submodels = await store.listIdentifiables(packageId, 'Submodel');
  const found = submodels.items.find((item) => item.idShort === HIERARCHY_SUBMODEL_ID_SHORT);
  if (!found) {
    throw new ApiError(
      400,
      'BadRequest',
      `이 파일에는 ${HIERARCHY_SUBMODEL_ID_SHORT} 서브모델이 없습니다 — 공정 파일이 아닙니다.`,
    );
  }
  return { submodel: found.content as Record<string, unknown>, record };
}

/**
 * 순환 검사 — source의 계층을 따라 내려가며 target이 나오면 안 된다.
 * 자산 주소 → 패키지 대응은 열린 파일 전체에서 만든다(파일 수가 적어 그때 훑어도 된다).
 */
async function guardCycle(store: AasStore, targetId: string, sourceId: string): Promise<void> {
  // 자산 주소 → 패키지 id
  const byAsset = new Map<string, string>();
  const all = await store.listPackages({ limit: 1000 });
  for (const record of all.items) {
    const shells = await store.listIdentifiables(record.id, 'AssetAdministrationShell');
    const asset = (shells.items[0]?.content as
      | { assetInformation?: { globalAssetId?: string } }
      | undefined)?.assetInformation?.globalAssetId;
    if (asset) byAsset.set(asset, record.id);
  }

  const visited = new Set<string>();
  const walk = async (packageId: string): Promise<boolean> => {
    if (packageId === targetId) return true; // 순환이다
    if (visited.has(packageId)) return false;
    visited.add(packageId);
    const submodels = await store.listIdentifiables(packageId, 'Submodel');
    const hierarchy = submodels.items.find((item) => item.idShort === HIERARCHY_SUBMODEL_ID_SHORT);
    if (!hierarchy) return false;
    const entry = findEntryNode(hierarchy.content as never);
    if (!entry) return false;
    // 🔴 중첩 전체를 본다 — 그룹 밑에 숨은 참조도 순환을 만든다
    const flat: { globalAssetId?: string; children: unknown[] }[] = [];
    const collect = (nodes: ReturnType<typeof hierarchyTree>): void => {
      for (const node of nodes) {
        flat.push(node as never);
        collect(node.children);
      }
    };
    collect(hierarchyTree(entry));
    for (const node of flat) {
      const next = node.globalAssetId ? byAsset.get(node.globalAssetId) : undefined;
      if (next && (await walk(next))) return true;
    }
    return false;
  };

  if (await walk(sourceId)) {
    throw new ApiError(
      400,
      'BadRequest',
      '넣으려는 파일이 (직접 또는 몇 단계 건너) 이 파일을 이미 담고 있습니다 — 순환이 됩니다.',
    );
  }
}

/** 이력 요약용 — 그 판의 요소 수(재귀) */
function countElements(content: Record<string, unknown>): number {
  let count = 0;
  const walk = (list: unknown): void => {
    if (!Array.isArray(list)) return;
    for (const element of list) {
      count += 1;
      const holder = element as { value?: unknown; statements?: unknown };
      walk(holder.value);
      walk(holder.statements);
    }
  };
  walk((content as { submodelElements?: unknown }).submodelElements);
  return count;
}

/** 자식에 적힌 대수. 없으면 1대다 */
function bulkCountOf(entity: { statements?: unknown[] }): number {
  const statements = (entity.statements ?? []) as { idShort?: string; value?: string }[];
  const bulk = statements.find((element) => element.idShort === 'BulkCount');
  const value = Number(bulk?.value);
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function firstKeyValue(reference: unknown): string | undefined {
  const keys = (reference as { keys?: { value?: unknown }[] } | undefined)?.keys;
  const value = keys?.[0]?.value;
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** 서브모델 안에서 쓰이는 semanticId를 전부 모은다 — 함께 가져와야 할 CD를 찾는 데 쓴다 */
function semanticIdsOf(node: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(node)) {
    for (const item of node) semanticIdsOf(item, out);
    return out;
  }
  if (typeof node !== 'object' || node === null) return out;
  const record = node as Record<string, unknown>;
  const semantic = firstKeyValue(record['semanticId']);
  if (semantic) out.add(semantic);
  for (const value of Object.values(record)) semanticIdsOf(value, out);
  return out;
}

/**
 * 질의 인자로 온 정책 덮어쓰기.
 *
 * 규정 충돌은 숨기지 않고 **고르게 한다**는 것이 이 제품의 원칙이다(명세 §5).
 * 특히 `smlChildIdShort=forbid`는 "KOSMO 제출"과 "표준 도구·BaSyx 상호운용" 중
 * 무엇을 우선할지 고르는 스위치다.
 */
function policyFromQuery(request: ApiRequest): Partial<LinterPolicy> {
  const overrides: Partial<LinterPolicy> = {};
  const sml = request.query['smlChildIdShort'];
  if (sml === 'warn' || sml === 'forbid' || sml === 'allow') overrides.smlChildIdShort = sml;
  const iri = request.query['iriConflict'];
  if (iri === 'kosmo-first' || iri === 'idta-preserve') overrides.iriConflict = iri;
  const terms = request.query['standardTemplateSemantics'];
  if (terms === 'kosmo-first' || terms === 'preserve') overrides.standardTemplateSemantics = terms;
  return overrides;
}

/** 린트 결과를 응답용으로 줄인다 — findings 전량은 저작 UI가 따로 받아 간다 */
function lintSummary(result: ReturnType<typeof lint>): Record<string, unknown> {
  return {
    passed: result.passed,
    countBySeverity: result.countBySeverity,
    countByRule: result.countByRule,
    rulesRun: result.rulesRun,
  };
}

export interface PackageRouteOptions {
  /** 서버 기본 린터 정책. 질의 인자가 오면 그것이 우선한다 */
  policy?: Partial<LinterPolicy>;
  /**
   * 업로드 AASX의 압축 해제 상한(기획서 Ⅷ Zip Bomb).
   * 배포 환경의 메모리에 맞춰 조절한다 — 폐쇄망 소형 서버와 클라우드가 같을 수 없다.
   */
  aasxLimits?: Partial<AasxLimits>;
  /**
   * 수집 어댑터를 어떻게 열지(M8). 주지 않으면 수집 경로가 501로 답한다 —
   * 저작만 하는 배포에서는 OPC UA 스택을 올릴 이유가 없다.
   */
  openReader?: (descriptor: AidInterface) => Promise<ProtocolReader>;
  /** 설비 훑기. 같은 이유로 주입받는다 — 프로토콜을 아는 곳은 @aas/opcua 하나뿐이다 */
  browseDevice?: (endpoint: string) => Promise<unknown>;
  /**
   * 내장 가상 PLC — 설비 AASX를 주면 그 운전 데이터 이름대로 태그를 세우고 접속 주소·태그를 돌려준다.
   * 없으면 「가상 PLC로 연결」이 501로 답한다(수집이 꺼진 배포)
   */
  simulate?: (
    environment: Environment,
  ) => Promise<{ machine: string; endpoint: string; title: string; tags: { name: string; href: string; type: string }[] }>;
}

/**
 * 한 파일을 고쳐 되쓴다.
 * 낱개 교정과 일괄 교정이 **같은 길**을 쓰도록 뽑아 뒀다 — 둘이 갈라지면 결과가 달라진다.
 */
/**
 * IRI 이관 대장 — 패키지 안의 파트로 남긴다(`/aasx/_idta_relocated_iris.json`, 20종 작업 때와 같은 이름).
 * 🔴 교정 응답에만 실려 있던 것을 2026-09-11에 파트로 옮겼다: "옮기고 끝"이면 규정 해석이 뒤집혔을 때
 *    되돌릴 길이 없다(04 명세 §5의 제품 요구). 파트라서 내려받은 .aasx에 같이 들어가고 다시 올려도 살아 있다
 */
const LEDGER_PART = '/aasx/_idta_relocated_iris.json';

async function readLedger(store: AasStore, packageId: string): Promise<Record<string, string>> {
  const files = await store.packageFiles(packageId);
  const part = files.find((file) => file.part === LEDGER_PART);
  if (!part) return {};
  try {
    const parsed = JSON.parse(new TextDecoder().decode(part.data)) as Record<string, string>;
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

async function writeLedger(store: AasStore, packageId: string, ledger: Record<string, string>): Promise<void> {
  if (Object.keys(ledger).length === 0) {
    await store.deletePackageFile(packageId, LEDGER_PART).catch(() => undefined);
    return;
  }
  await store.putPackageFile(packageId, {
    part: LEDGER_PART,
    role: 'extra',
    contentType: 'application/json',
    data: new TextEncoder().encode(JSON.stringify(ledger, null, 2)),
  });
}

/** 새로 옮긴 것을 대장에 합친다 — 먼저 적힌 원본이 남는다(두 번 옮겨도 최초 원본으로 돌아가야 한다) */
async function mergeLedger(store: AasStore, packageId: string, added: Record<string, string>): Promise<Record<string, string>> {
  if (Object.keys(added).length === 0) return readLedger(store, packageId);
  const current = await readLedger(store, packageId);
  for (const [now, origin] of Object.entries(added)) {
    // 옮긴 것을 또 옮겼으면(원본→A→B) 대장은 B→원본으로
    const root = current[origin] ?? origin;
    if (current[now] === undefined) current[now] = root;
  }
  await writeLedger(store, packageId, current);
  return current;
}

/**
 * 교정 미리보기 — 무엇을 어떻게 고칠지 **저장하지 않고** 계산한다(사용자 2026-09-11: 팝업에서 항목별
 * 전/후를 보고 체크한 것만 반영). 썸네일이 없으면 임시 그림 파트가 있는 것으로 치고 계산한다 —
 * 실제 반영(fixOne)이 그 파트를 만들기 때문에 미리보기와 결과가 같아야 한다
 */
async function previewFix(
  store: AasStore,
  packageId: string,
  overrides: Partial<LinterPolicy>,
  includeWarnings: boolean,
): Promise<ReturnType<typeof lintAndFix>> {
  const pkg = await snapshot(store, packageId);
  const hasImage = pkg.opc.parts.some((part) => /\.(png|jpe?g|gif|bmp)$/i.test(part));
  if (!hasImage) pkg.opc.parts.push(placeholderThumbnail().part);
  return lintAndFix(pkg.environment, {
    package: pkg.opc,
    includeWarnings,
    ...(Object.keys(overrides).length > 0 ? { policy: overrides } : {}),
  });
}

async function fixOne(
  store: AasStore,
  packageId: string,
  overrides: Partial<LinterPolicy>,
  /** 고칠 수 있는 경고도 함께 손댈지 — 저작 UI는 켠다(2026-09-07). 스크립트 호출은 기본 위반만 */
  includeWarnings = false,
  /** 미리보기에서 고른 것만 — 없으면 전부 */
  select?: readonly FixSelector[],
): Promise<{ result: ReturnType<typeof lintAndFix>; counts: unknown; ledger: Record<string, string> }> {
  // 🔴 썸네일 사전 처리 — 패키지에 이미지 파트가 하나도 없으면 fixer가 "파일을 먼저
  //    추가하라"며 전부 건너뛴다. 그런데 화면은 「고칠 수 있음」이라 광고한다(실측:
  //    XML판 픽스처에서 고치기가 헛돌았다). 뼈대가 쓰는 임시 그림을 넣어 주면
  //    KOSMO-AAS-1 fixer가 그걸 가리키고, PKG-THUMB-PART의 파트·관계·Content_Types는
  //    writeAasx가 만든다. 임시 그림이라는 사실은 요약의 「다음 할 일」이 알려 준다.
  const files = await store.packageFiles(packageId);
  const hasImage = files.some((file) => /\.(png|jpe?g|gif|bmp)$/i.test(file.part));
  if (!hasImage) {
    const placeholder = placeholderThumbnail();
    await store.putPackageFile(packageId, {
      part: placeholder.part,
      role: 'thumbnail',
      contentType: placeholder.contentType,
      data: placeholder.data,
    });
  }

  const pkg = await snapshot(store, packageId);
  const result = lintAndFix(pkg.environment, {
    package: pkg.opc,
    includeWarnings,
    ...(select ? { select } : {}),
    ...(Object.keys(overrides).length > 0 ? { policy: overrides } : {}),
  });
  const counts = await writeBackEnvironment(store, packageId, result.environment);
  const ledger = await mergeLedger(store, packageId, result.relocations);
  return { result, counts, ledger };
}

export function packageRoutes(store: AasStore, options: PackageRouteOptions = {}): Route[] {
  const routes = baseRoutes(store, options);
  const aid = routes.find((route) => route.method === 'POST' && route.pattern === '/packages/:packageId/aid')!;
  return [
    ...routes,
    {
      /**
       * 「가상 PLC로 연결」 — 평가자가 설치판만으로 번들을 재현하는 길(2026-09-30).
       * 내장 가상 PLC에 이 설비를 붙이고, 그 태그로 수집 연결(AID)을 만든다. 만드는 길은 「수집 연결 만들기」와
       * **같은 처리**를 그대로 탄다 — 두 길이 갈라지면 결과가 달라진다.
       * 🔴 이미 **다른 주소**로 수집 연결이 있으면 덮지 않는다(409) — 현장 PLC 연결을 시뮬레이션으로 조용히 바꾸면 안 된다.
       */
      method: 'POST',
      pattern: '/packages/:packageId/simulate',
      success: [201],
      async handle(context) {
        if (!options.simulate) {
          throw new ApiError(501, 'NotImplemented', '가상 PLC는 수집이 켜진 서버(COLLECT=on)에서만 씁니다.');
        }
        const packageId = context.params['packageId']!;
        const record = await store.getPackage(packageId);
        if (!record) throw new ApiError(404, 'NotFound', '패키지를 찾을 수 없습니다.');
        const environment = (await store.exportPackage(packageId)).environment;
        const assetType = String(environment.assetAdministrationShells?.[0]?.assetInformation?.['assetType' as never] ?? '');
        if (assetType.includes('/type/')) {
          throw new ApiError(400, 'BadRequest', '가상 PLC는 설비 파일에 붙입니다 — 공정(묶음) 파일에는 수집할 값이 없습니다.');
        }
        let sim: Awaited<ReturnType<NonNullable<PackageRouteOptions['simulate']>>>;
        try {
          sim = await options.simulate(environment);
        } catch (error) {
          const message = (error as Error).message;
          throw new ApiError(
            503,
            'ServiceUnavailable',
            /EADDRINUSE|address already in use/i.test(message)
              ? '가상 PLC 포트(14850)를 이미 다른 프로그램이 쓰고 있습니다 — 가상PLC_시작.bat 창이 떠 있으면 닫고 다시 누르십시오.'
              : `가상 PLC를 띄우지 못했습니다: ${message}`,
          );
        }
        if (sim.tags.length === 0) {
          throw new ApiError(400, 'BadRequest', '운전 데이터(OperationalData)에 Property가 없어 흉내 낼 태그가 없습니다.');
        }
        const existing = parseAid(environment).find((iface) => iface.base && iface.base !== sim.endpoint);
        if (existing) {
          throw new ApiError(
            409,
            'Conflict',
            `이미 다른 주소(${existing.base})로 수집 연결이 있습니다 — 가상 PLC로 바꾸지 않았습니다. 시연은 「호기별로 나누기」로 만든 호기에서 하십시오.`,
          );
        }
        await aid.handle({
          ...context,
          request: { ...context.request, body: { endpoint: sim.endpoint, title: sim.title, tags: sim.tags } },
        });
        return json(201, { machine: sim.machine, endpoint: sim.endpoint, title: sim.title, tags: sim.tags.length });
      },
    },
  ];
}

function baseRoutes(store: AasStore, options: PackageRouteOptions): Route[] {
  const readOptions = options.aasxLimits ? { limits: options.aasxLimits } : {};
  return [
    {
      /**
       * 새 설비 만들기.
       *
       * 🔴 빈 AAS를 주지 않는다. KOSMO는 서브모델 4종을 요구하고 총 개수를 6~8종으로 묶는다.
       * 빈 파일에서 출발하면 그것을 사람이 기억해 하나씩 붙여야 하는데, 그건 지금도 되는 일이라
       * 새로 만들 이유가 없다. **태어나자마자 위반 0건인 뼈대**를 준다.
       */
      method: 'POST',
      pattern: '/packages/new',
      success: [201],
      async handle({ request }) {
        const body = (request.body ?? {}) as Record<string, unknown>;
        const assetName = String(body['assetName'] ?? '').trim();
        if (!isValidAssetName(assetName)) {
          throw new ApiError(
            400,
            'BadRequest',
            '장비명은 영문으로 시작하고 영문·숫자·밑줄만 씁니다. 예: RollFormingMachine',
          );
        }
        const extras = Array.isArray(body['extraSubmodels'])
          ? (body['extraSubmodels'] as unknown[]).map(String)
          : undefined;
        // 설비 / 묶음(composite). process·company는 옛 이름 — 같은 구조라 그대로 받는다
        const wanted = String(body['unit'] ?? 'equipment');
        const unit = ['composite', 'process', 'company'].includes(wanted)
          ? (wanted as 'composite' | 'process' | 'company')
          : ('equipment' as const);

        const environment = scaffoldEnvironment({
          assetName,
          unit,
          ...(extras ? { extraSubmodels: extras } : {}),
          ...(options.policy ? { policy: options.policy } : {}),
        });
        const thumbnail = placeholderThumbnail();
        const record = await store.importPackage({
          name: `${assetName}.aasx`,
          package: {
            environment,
            specPart: DEFAULT_SPEC_PART,
            thumbnail: { part: thumbnail.part, contentType: thumbnail.contentType, data: thumbnail.data },
            supplementaryFiles: [],
            extraParts: new Map(),
          },
        });
        const description = await packageDescription(store, record);
        return json(201, description);
      },
    },
    {
      /**
       * 파일 복제 — 호기별로 나누기의 실체.
       *
       * 서브모델·첨부·썸네일까지 통째로 복사하고 **id는 새 이름으로 개명**한다.
       * 이름만 단 빈 마디를 주면 "기존 파일의 서브모델이 안 딸려온다"(실측 제보).
       */
      method: 'POST',
      pattern: '/packages/:packageId/clone',
      success: [201],
      async handle({ params, request }) {
        const packageId = params['packageId']!;
        const body = (request.body ?? {}) as Record<string, unknown>;
        const assetName = String(body['assetName'] ?? '').trim();
        if (!isValidAssetName(assetName)) {
          throw new ApiError(
            400,
            'BadRequest',
            '이름은 영문으로 시작하고 영문·숫자·밑줄만 씁니다. 예: RollFormingMachine_1',
          );
        }
        const source = await store.getPackage(packageId);
        if (!source) throw new ApiError(404, 'NotFound', '패키지를 찾을 수 없습니다.');
        const exported = await store.exportPackage(packageId);
        const iriBase = (options.policy?.iriBase ?? DEFAULT_POLICY.iriBase) as string;
        let environment: Environment;
        try {
          environment = renameEnvironment(exported.environment, assetName, iriBase);
        } catch (error) {
          throw new ApiError(400, 'BadRequest', (error as Error).message);
        }
        const record = await store.importPackage({
          name: `${assetName}.aasx`,
          package: { ...exported, environment },
        });
        return json(201, await packageDescription(store, record));
      },
    },
    {
      method: 'GET',
      pattern: '/packages',
      success: [200],
      async handle({ request }) {
        const page = await store.listPackages(
          request.query['cursor'] ? { cursor: request.query['cursor'] } : {},
        );
        const wanted = request.query['aasId'];
        const aasId = wanted === undefined ? undefined : decodeIdentifier(wanted);

        const descriptions = [];
        for (const record of page.items) {
          const description = await packageDescription(store, record);
          if (aasId !== undefined && !(description['aasIds'] as string[]).includes(aasId)) continue;
          descriptions.push(description);
        }
        return pagedResponse(descriptions, page.cursor);
      },
    },
    {
      method: 'POST',
      pattern: '/packages',
      success: [201],
      async handle({ request }) {
        const upload = uploadedPackage(request);
        const pkg = readAasx(upload.data, readOptions);
        // 원본 바이트 보관 — 고치지 않으면 레퍼런스 번들에 이 파일 그대로 들어간다(해시 대조)
        const record = await store.importPackage({ name: upload.name, package: pkg, keep: [originalFile(upload.data)] });
        const description = await packageDescription(store, record);
        return {
          status: 201,
          headers: { 'content-type': 'application/json', location: `/packages/${record.id}` },
          body: { ...description, warnings: pkg.warnings },
        };
      },
    },
    {
      method: 'GET',
      pattern: '/packages/:packageId',
      success: [200],
      async handle({ params }) {
        const packageId = params['packageId']!;
        const record = await store.getPackage(packageId);
        if (!record) throw new ApiError(404, 'NotFound', '패키지를 찾을 수 없습니다.');
        const data = writeAasx(await store.exportPackage(packageId));
        return bytes(200, data, AASX_MEDIA_TYPE, record.name);
      },
    },
    {
      method: 'PUT',
      pattern: '/packages/:packageId',
      success: [204],
      async handle({ request, params }) {
        const packageId = params['packageId']!;
        const existing = await store.getPackage(packageId);
        if (!existing) throw new ApiError(404, 'NotFound', '패키지를 찾을 수 없습니다.');

        const upload = uploadedPackage(request);
        const pkg = readAasx(upload.data, readOptions);
        // 교체는 새로 담는 것과 같다. 같은 packageId를 유지해 클라이언트의 링크를 지킨다
        await store.deletePackage(packageId);
        // 🔴 주인을 **그대로 넘긴다.** 안 넘기면 바꾼 사람의 것이 된다 — 관리자가 남의 파일을
        //    바꿔 줬다고 그 파일이 관리자 것이 되거나, 공용 파일이 한 사람 것이 되면 안 된다
        await store.importPackage({
          id: packageId,
          name: upload.name,
          package: pkg,
          keep: [originalFile(upload.data)],
          owner: existing.owner ?? null,
        });
        return noContent();
      },
    },
    {
      method: 'DELETE',
      pattern: '/packages/:packageId',
      success: [204],
      async handle({ params }) {
        await store.deletePackage(params['packageId']!);
        return noContent();
      },
    },

    // ── 아래는 규격 밖 확장 — 저작 UI가 쓴다 ──────────────────────────────────
    {
      method: 'GET',
      pattern: '/packages/:packageId/metadata',
      async handle({ params }) {
        const record = await store.getPackage(params['packageId']!);
        if (!record) throw new ApiError(404, 'NotFound', '패키지를 찾을 수 없습니다.');
        return json(200, { ...record, ...(await packageDescription(store, record)) });
      },
    },
    {
      /**
       * 서브모델 변경 이력 — 되돌리기의 재료.
       *
       * 저장소는 처음부터 변경 전 내용을 통째로 쌓아 왔는데(store.history) 화면이 쓸 길이
       * 없었다. 실수(잘못 지움·잘못 고침)를 복구할 방법이 없다는 것이 실사용 검증에서
       * 확인된 구멍이다(2026-08-26).
       */
      method: 'GET',
      pattern: '/packages/:packageId/history/:submodelId',
      success: [200],
      async handle({ params }) {
        const packageId = params['packageId']!;
        const submodelId = decodeIdentifier(params['submodelId']!);
        const entries = await store.history(packageId, 'Submodel', submodelId);
        return json(200, {
          result: entries.map((entry) => ({
            changedAt: entry.changedAt,
            operation: entry.operation,
            revision: entry.revision,
            // 사람이 "어느 판인지" 가늠할 단서 — 그때의 요소 수
            elementCount: countElements(entry.content),
            // 「누가」 — 없을 수 있다(로그인을 안 쓰는 서버, 2026-10-02 이전 기록)
            actorName: entry.actorName,
          })),
        });
      },
    },
    {
      /**
       * 이력의 한 판으로 되돌린다.
       * 🔴 되돌리기 자체도 이력에 남는다(updateIdentifiable을 그대로 타므로) —
       *    되돌린 것을 또 되돌릴 수 있다. 조용히 덮어쓰고 끝나는 것보다 한 수 위다.
       */
      method: 'POST',
      pattern: '/packages/:packageId/history/:submodelId/restore',
      success: [200],
      async handle({ params, request }) {
        const packageId = params['packageId']!;
        const submodelId = decodeIdentifier(params['submodelId']!);
        const changedAt = String(bodyObject(request)['changedAt'] ?? '');
        const entries = await store.history(packageId, 'Submodel', submodelId);
        const entry = entries.find((candidate) => candidate.changedAt === changedAt);
        if (!entry) throw new ApiError(404, 'NotFound', '그 시각의 이력이 없습니다.');
        const current = await store.getIdentifiable(packageId, 'Submodel', submodelId);
        if (current) {
          await store.updateIdentifiable(packageId, 'Submodel', submodelId, entry.content);
        } else {
          // 지워진 서브모델의 복원 — delete 이력이 마지막 내용을 들고 있다
          await store.createIdentifiable(packageId, entry.content);
        }
        return json(200, { restored: changedAt });
      },
    },
    {
      /**
       * 공정의 계층 — 무엇으로 이루어졌는지 보여 준다.
       *
       * 공정 파일은 **자기 안에 설비 상세를 담지 않는다.** globalAssetId라는 끈 하나로
       * 설비 파일을 가리킬 뿐이다(값 동기화 A안과 같은 정신 — 원본은 한 군데다).
       * 그래서 화면이 "무엇이 매달려 있는지"를 물어볼 자리가 필요하다.
       */
      method: 'GET',
      pattern: '/packages/:packageId/hierarchy',
      success: [200],
      async handle({ params }) {
        const packageId = params['packageId']!;
        const { submodel } = await findHierarchy(store, packageId);
        const entry = findEntryNode(submodel as never);
        if (!entry) return json(200, { entryNode: null, children: [] });
        // 🔴 중첩 트리로 준다 — 회사>공정>장비를 한 파일 안에서 그리는 것이 목적이라
        //    한 층만 주면 화면이 그 밑을 볼 수 없다. 그룹(중간 마디)은 globalAssetId가 없다
        // 🔴 globalAssetId를 전 층에 빈 문자열로라도 채운다. 최상위만 채웠더니
        //    그룹 속 그룹부터 키가 빠져 화면이 그룹을 설비로 착각했다(실측)
        const normalize = (
          nodes: ReturnType<typeof hierarchyTree>,
        ): { name: string; globalAssetId: string; bulkCount: number; children: unknown[] }[] =>
          nodes.map((node) => ({
            name: node.name,
            globalAssetId: node.globalAssetId ?? '',
            bulkCount: node.bulkCount,
            children: normalize(node.children),
          }));
        return json(200, {
          entryNode: {
            name: entry.idShort ?? '',
            globalAssetId: (entry as unknown as { globalAssetId?: string }).globalAssetId ?? '',
          },
          children: normalize(hierarchyTree(entry)),
        });
      },
    },
    {
      /**
       * 설비 하나를 계층에 매단다.
       *
       * 두 가지로 부를 수 있다.
       *  ① `sourcePackageId` — 이 도구에 이미 올려 둔 설비 파일을 고른다. **권장.**
       *     이름과 Asset 주소를 그 파일에서 읽으므로 손으로 옮겨 적다 틀릴 일이 없다
       *  ② `name` + `globalAssetId` — 아직 파일이 없는 설비를 미리 적어 둘 때
       */
      method: 'POST',
      pattern: '/packages/:packageId/hierarchy/nodes',
      success: [201],
      async handle({ params, request }) {
        const packageId = params['packageId']!;
        const body = bodyObject(request);
        const { submodel } = await findHierarchy(store, packageId);

        let name = String(body['name'] ?? '').trim();
        let globalAssetId = String(body['globalAssetId'] ?? '').trim();
        // 어느 마디 밑에 넣을지 — 진입점부터의 이름 경로. 비우면 최상위
        const parentPath = Array.isArray(body['parentPath'])
          ? (body['parentPath'] as unknown[]).map(String)
          : [];

        // 그룹(중간 마디) — 파일 없이 층만 만든다. 회사 파일 안의 「용접공정」 같은 것
        if (body['group'] === true) {
          if (!name) throw new ApiError(400, 'BadRequest', '그룹 이름이 비었습니다.');
          let grouped;
          try {
            grouped = addChild(
              submodel as never,
              { name, group: true },
              (options.policy?.iriBase ?? DEFAULT_POLICY.iriBase) as string,
              parentPath,
            );
          } catch (error) {
            throw new ApiError(400, 'BadRequest', (error as Error).message);
          }
          await store.updateIdentifiable(packageId, 'Submodel', String(submodel['id']), grouped as never);
          return json(201, { name, group: true });
        }

        const sourcePackageId = String(body['sourcePackageId'] ?? '').trim();
        if (sourcePackageId) {
          if (sourcePackageId === packageId) {
            throw new ApiError(400, 'BadRequest', '자기 자신을 매달 수 없습니다.');
          }
          // 🔴 순환 방지 — A가 B를 담고 B가 A를 담으면 트리가 무한이 된다.
          //    계층이 재귀(회사→공정→설비)가 되면서 실제로 만들 수 있는 실수가 됐다.
          //    넣으려는 파일의 계층을 따라 내려가며 지금 파일이 나오면 거부한다.
          await guardCycle(store, packageId, sourcePackageId);
          const shells = await store.listIdentifiables(sourcePackageId, 'AssetAdministrationShell');
          const shell = shells.items[0];
          if (!shell) throw new ApiError(404, 'NotFound', '고른 파일에 AAS가 없습니다.');
          const content = shell.content as {
            idShort?: string;
            assetInformation?: { globalAssetId?: string };
          };
          name = name || content.idShort || '';
          globalAssetId = globalAssetId || content.assetInformation?.globalAssetId || '';
          if (!globalAssetId) {
            throw new ApiError(
              400,
              'BadRequest',
              '고른 파일에 Asset 주소(globalAssetId)가 없습니다 — 그 파일을 먼저 고치십시오.',
            );
          }
        }

        const bulk = Number(body['bulkCount']);
        let next;
        try {
          next = addChild(
            submodel as never,
            {
              name,
              globalAssetId,
              ...(Number.isFinite(bulk) && bulk > 1 ? { bulkCount: Math.trunc(bulk) } : {}),
            },
            (options.policy?.iriBase ?? DEFAULT_POLICY.iriBase) as string,
            parentPath,
          );
        } catch (error) {
          throw new ApiError(400, 'BadRequest', (error as Error).message);
        }

        await store.updateIdentifiable(packageId, 'Submodel', String(submodel['id']), next as never);
        return json(201, { name, globalAssetId });
      },
    },
    {
      /** 매단 설비를 뺀다. 🔴 관계도 함께 뺀다 — 하나만 지우면 짝이 안 맞는 파일이 된다 */
      method: 'DELETE',
      pattern: '/packages/:packageId/hierarchy/nodes/:name',
      success: [204],
      async handle({ params, request }) {
        const packageId = params['packageId']!;
        const name = decodeURIComponent(params['name']!);
        const parentRaw = request.query['parent'];
        const parentPath = parentRaw ? String(parentRaw).split('/').filter(Boolean) : [];
        const { submodel } = await findHierarchy(store, packageId);
        let next;
        try {
          next = removeChild(submodel as never, name, parentPath);
        } catch (error) {
          throw new ApiError(404, 'NotFound', (error as Error).message);
        }
        await store.updateIdentifiable(packageId, 'Submodel', String(submodel['id']), next as never);
        return { status: 204, headers: {}, body: '' };
      },
    },
    {
      /**
       * 다른 패키지에서 서브모델을 가져온다 — 기획서 Phase 3 「IDTA 표준 템플릿 임포트」의 실질.
       *
       * IDTA 공식 템플릿 파일을 우리가 배포할 수는 없다(라이선스·오프라인). 대신 **검증을 통과한
       * 기존 AASX에서 복사**한다 — 설비를 여러 종 만들 때 실제로 쓰던 방식이고, 그 원본이
       * KOSMO Validator를 통과한 것이라는 점이 표준 템플릿보다 오히려 확실하다.
       *
       * 두 가지를 함께 처리하지 않으면 가져오는 순간 파일이 깨진다.
       *   ① id 재작성 — 장비가 다르면 Submodel id도 달라야 한다(KOSMO-SM-2)
       *   ② ConceptDescription 동반 — 안 가져오면 KOSMO-SME-3이 전부 터진다
       */
      method: 'POST',
      pattern: '/packages/:packageId/import-submodel',
      async handle({ request, params }) {
        const targetId = params['packageId']!;
        const body = bodyObject(request);
        const sourcePackageId = String(body['sourcePackageId'] ?? '');
        const submodelId = String(body['submodelId'] ?? '');
        const retarget = body['retarget'] !== false;
        /*
         * 🔴 같은 idShort의 서브모델이 이미 있을 때. 전에는 판(version)이 다르면 id가 달라
         *    말없이 둘째 DigitalNameplate가 생겼다(전문가 시연 실측) — AAS 하나에 같은 이름이
         *    둘이면 Package Explorer도 KOSMO도 어느 것을 볼지 정해 주지 않는다.
         *    기본은 거절(409)하고, 화면이 사람에게 물어 바꾸기/나란히 두기를 고르게 한다.
         */
        const onDuplicate = String(body['onDuplicate'] ?? 'reject') as 'reject' | 'replace' | 'alongside';

        const target = await store.getPackage(targetId);
        if (!target) throw new ApiError(404, 'NotFound', '가져올 대상 패키지가 없습니다.');
        const source = await store.getIdentifiable(sourcePackageId, 'Submodel', submodelId);
        if (!source) throw new ApiError(404, 'NotFound', '원본 Submodel을 찾을 수 없습니다.');

        const content = JSON.parse(JSON.stringify(source.content)) as Record<string, unknown>;
        const oldId = String(content['id']);

        const existing = await store.listIdentifiables(targetId, 'Submodel', { limit: 200 });
        const takenNames = new Set(existing.items.map((item) => item.idShort).filter((n): n is string => !!n));
        const sameName = existing.items.filter(
          (item) => item.idShort !== undefined && item.idShort === content['idShort'],
        );
        if (sameName.length > 0) {
          if (onDuplicate === 'reject') {
            throw new ApiError(
              409,
              'Conflict',
              `이미 「${String(content['idShort'])}」 서브모델이 있습니다. 바꾸거나 나란히 둘지 정해 주십시오.`,
            );
          }
          if (onDuplicate === 'alongside') {
            const base = String(content['idShort']);
            let n = 2;
            while (takenNames.has(`${base}_${n}`)) n += 1;
            content['idShort'] = `${base}_${n}`;
          }
        }

        if (retarget) {
          const shells = await store.listIdentifiables(targetId, 'AssetAdministrationShell');
          const assetName = shells.items[0]?.idShort;
          const idShort = typeof content['idShort'] === 'string' ? content['idShort'] : undefined;
          if (!assetName || !idShort) {
            throw new ApiError(
              400,
              'BadRequest',
              '가져오는 쪽 AAS의 idShort와 원본 Submodel의 idShort가 모두 있어야 id를 다시 지을 수 있습니다.',
            );
          }
          const admin = content['administration'] as { version?: string; revision?: string } | undefined;
          const version = admin?.version ?? '1';
          const revision = admin?.revision ?? '0';
          const newId = `${DEFAULT_POLICY.iriBase}/sm/${assetName}/${idShort}/${version}/${revision}`;
          content['id'] = newId;
          content['administration'] = { ...(admin ?? {}), version, revision };
          // 원본이 자기 id를 semanticId로 쓰고 있었다면 새 id로 따라간다(KOSMO-SM-3).
          // 바깥 IRI를 가리키고 있었다면 손대지 않는다 — 그건 판단이 필요한 일이라 린터에 맡긴다
          if (firstKeyValue(content['semanticId']) === oldId) {
            content['semanticId'] = {
              type: 'ExternalReference',
              keys: [{ type: 'GlobalReference', value: newId }],
            };
          }
        }

        const newId = String(content['id']);

        // 바꾸기 — 같은 이름의 옛것을 지우고(AAS 참조도 함께) 새것을 넣는다
        // 🔴 자리 보존(2026-09-07 실전 검증): 지우고 새로 넣으면 맨 뒤라 DigitalNameplate가 트리 끝으로
        //    내려갔다 — 필수 4종의 순서가 깨져 보인다. 옛것의 자리(ordinal)와 AAS 참조 위치를 기억해
        //    새것을 **그 자리에** 넣는다. 새로 만들기 뼈대 → 다른 파일에서 가져오기가 정확히 이 경우다
        const replaced: string[] = [];
        let seatOrdinal: number | undefined;
        let seatRefIndex: number | undefined;
        if (sameName.length > 0 && onDuplicate === 'replace') {
          seatOrdinal = Math.min(...sameName.map((old) => old.ordinal));
          for (const old of sameName) {
            await store.deleteIdentifiable(targetId, 'Submodel', old.id);
            replaced.push(old.id);
          }
          const shells = await store.listIdentifiables(targetId, 'AssetAdministrationShell');
          for (const shell of shells.items) {
            const shellContent = JSON.parse(JSON.stringify(shell.content)) as {
              submodels?: { keys?: { value: string }[] }[];
            };
            const refs = shellContent.submodels ?? [];
            const at = refs.findIndex((ref) => replaced.includes(ref.keys?.[0]?.value ?? ''));
            if (at >= 0 && seatRefIndex === undefined) seatRefIndex = at;
            shellContent.submodels = refs.filter((ref) => !replaced.includes(ref.keys?.[0]?.value ?? ''));
            await store.updateIdentifiable(
              targetId,
              'AssetAdministrationShell',
              shell.id,
              shellContent as unknown as Record<string, unknown>,
            );
          }
        }

        if (await store.getIdentifiable(targetId, 'Submodel', newId)) {
          throw new ApiError(409, 'Conflict', `이미 같은 id의 Submodel이 있습니다: ${newId}`);
        }
        await store.createIdentifiable(targetId, content, seatOrdinal === undefined ? {} : { ordinal: seatOrdinal });

        // 함께 가져와야 할 ConceptDescription — 없으면 KOSMO-SME-3이 전부 터진다
        const wanted = semanticIdsOf(content);
        let copied = 0;
        for (const semantic of wanted) {
          if (await store.getIdentifiable(targetId, 'ConceptDescription', semantic)) continue;
          const cd = await store.getIdentifiable(sourcePackageId, 'ConceptDescription', semantic);
          if (!cd) continue;
          await store.createIdentifiable(targetId, cd.content);
          copied += 1;
        }

        // AAS의 submodels[]에도 매단다 — 바꾸기였으면 옛 참조가 있던 자리에
        const shells = await store.listIdentifiables(targetId, 'AssetAdministrationShell');
        const shell = shells.items[0];
        if (shell) {
          const shellContent = JSON.parse(JSON.stringify(shell.content)) as { submodels?: unknown[] };
          const refs = (shellContent.submodels ??= []);
          const ref = { type: 'ModelReference', keys: [{ type: 'Submodel', value: newId }] };
          if (seatRefIndex !== undefined && seatRefIndex <= refs.length) refs.splice(seatRefIndex, 0, ref);
          else refs.push(ref);
          await store.updateIdentifiable(
            targetId,
            'AssetAdministrationShell',
            shell.id,
            shellContent as unknown as Record<string, unknown>,
          );
        }

        return json(201, {
          submodelId: newId,
          renamedFrom: newId === oldId ? undefined : oldId,
          copiedConceptDescriptions: copied,
          ...(replaced.length > 0 ? { replaced } : {}),
          ...(onDuplicate === 'alongside' && sameName.length > 0 ? { idShort: content['idShort'] } : {}),
        });
      },
    },
    {
      /**
       * 리비전 목록 (확장) — 낙관적 잠금에 쓴다.
       *
       * Part 2의 목록 응답은 모델 그 자체라 리비전을 실을 자리가 없다(실으면 모델이 오염된다).
       * 그렇다고 요소마다 GET을 한 번씩 더 하면 편집할 때마다 왕복이 늘어난다.
       * 그래서 리비전만 따로 준다 — UI는 이 값을 If-Match로 되돌려 보낸다.
       */
      method: 'GET',
      pattern: '/packages/:packageId/revisions',
      async handle({ params }) {
        const packageId = params['packageId']!;
        const record = await store.getPackage(packageId);
        if (!record) throw new ApiError(404, 'NotFound', '패키지를 찾을 수 없습니다.');

        const out: Record<string, Record<string, number>> = {};
        for (const modelType of IDENTIFIABLE_MODEL_TYPES) {
          const map: Record<string, number> = {};
          let cursor: string | undefined;
          do {
            const page = await store.listIdentifiables(packageId, modelType, {
              limit: 500,
              ...(cursor ? { cursor } : {}),
            });
            for (const item of page.items) map[item.id] = item.revision;
            cursor = page.cursor;
          } while (cursor);
          out[modelType] = map;
        }
        return json(200, { package: record.revision, ...out });
      },
    },
    {
      /** AID가 기술한 인터페이스 — 무엇을 수집할 수 있는지(M8) */
      method: 'GET',
      pattern: '/packages/:packageId/interfaces',
      async handle({ params }) {
        const packageId = params['packageId']!;
        const environment = await store.getEnvironment(packageId);
        const interfaces = parseAid(environment);
        return json(200, {
          // 자체 매핑이 아니라 **파일 안의 AID**가 출처다(IDTA-02017)
          source: 'AssetInterfacesDescription',
          interfaces,
        });
      },
    },
    {
      /** 수집값 조회 — 모델이 아니라 시계열이다(A안) */
      method: 'GET',
      pattern: '/packages/:packageId/values',
      async handle({ params, request }) {
        const packageId = params['packageId']!;
        const query: Parameters<AasStore['readValues']>[1] = {};
        const interfaceName = request.query['interface'];
        if (interfaceName) query.interfaceName = interfaceName;
        const propertyName = request.query['property'];
        if (propertyName) query.propertyName = propertyName;
        const from = request.query['from'];
        if (from) query.from = from;
        const to = request.query['to'];
        if (to) query.to = to;
        const limit = request.query['limit'];
        if (limit !== undefined) {
          const parsed = Number(limit);
          if (!Number.isInteger(parsed) || parsed <= 0) {
            throw new ApiError(400, 'BadRequest', `limit이 양의 정수가 아닙니다: ${limit}`);
          }
          query.limit = parsed;
        }
        const values = await store.readValues(packageId, query);
        return json(200, { result: values });
      },
    },
    {
      /**
       * 한 번 수집한다(M8). 주기 실행은 수집기가 따로 돌리고, 이 경로는 **지금 확인**용이다.
       * 어댑터가 주입되지 않은 배포에서는 501로 답한다 — 저작만 하는 서버도 있다.
       */
      method: 'POST',
      pattern: '/packages/:packageId/collect',
      async handle({ params }) {
        const packageId = params['packageId']!;
        if (!options.openReader) {
          throw new ApiError(
            501,
            'NotImplemented',
            '이 서버에는 수집 어댑터가 없습니다. OPC UA 스택을 올린 배포에서 쓰십시오.',
          );
        }
        const environment = await store.getEnvironment(packageId);
        const interfaces = parseAid(environment);
        if (interfaces.length === 0) {
          throw new ApiError(
            404,
            'NotFound',
            'AssetInterfacesDescription 서브모델이 없습니다. 수집할 주소를 알 수 없습니다.',
          );
        }

        const runner = new CollectionRunner({
          packageId,
          interfaces,
          openReader: options.openReader,
          sink: { append: (samples) => store.appendValues(packageId, samples) },
          intervalMs: 0,
        });
        try {
          return json(200, await runner.runOnce());
        } finally {
          await runner.stop();
        }
      },
    },
    {
      /**
       * 규칙·규약 카탈로그 — **"무슨 근거로 통과라고 하는가"에 답한다.**
       *
       * 🔴 문서에 적힌 것이 아니라 **지금 도는 규칙**을 그대로 뽑는다.
       *    문서와 코드가 어긋나면 이 화면이 먼저 드러낸다.
       */
      method: 'GET',
      pattern: '/rules',
      async handle({ request }) {
        const overrides = { ...options.policy, ...policyFromQuery(request) };
        return json(200, ruleCatalog(overrides));
      },
    },
    {
      /**
       * 파일 없이도 규약을 알아야 한다 — 첫 화면에서 「새 설비 만들기」를 그리려면 필요하다.
       * 지식은 한 곳(린터 정책)에만 둔다.
       */
      method: 'GET',
      pattern: '/policy',
      async handle() {
        return json(200, { ...DEFAULT_POLICY, ...options.policy });
      },
    },
    {
      /**
       * 가이던스에 붙일 UML 다이어그램(SVG).
       *
       * KTL 규정 §13 주의사항 3이 **모든 서브모델에 UML Diagram 첨부**를 요구한다.
       * 🔴 도구는 파일에 있는 사실만 그린다 — 문서 문장은 사람이 쓴다.
       * `?submodel=` 없으면 AAS 전체 구성도.
       */
      method: 'GET',
      pattern: '/packages/:packageId/diagram.svg',
      async handle({ params, request }) {
        const pkg = await snapshot(store, params['packageId']!);
        const wanted = request.query['submodel'];
        const fontSize = Number(request.query['fontSize']);
        const options = Number.isFinite(fontSize) && fontSize > 0 ? { fontSize } : {};

        let svg: string;
        if (wanted === undefined || wanted === '') {
          svg = overviewUml(pkg.environment, options);
        } else {
          const submodel = (pkg.environment.submodels ?? []).find(
            (item) => item.idShort === wanted || item.id === wanted,
          );
          if (!submodel) throw new ApiError(404, 'NotFound', `서브모델을 찾을 수 없습니다: ${wanted}`);
          svg = submodelUml(submodel, options);
        }
        return {
          status: 200,
          headers: { 'content-type': 'image/svg+xml; charset=utf-8' },
          body: new TextEncoder().encode(svg),
        };
      },
    },
    {
      /**
       * 서브모델 구성요소 상세 정보 테이블 — 가이던스 부속물(규정 §13 주의사항 5).
       *
       * 🔴 표를 **만들지 말아야 하는 서브모델**이 있다. IDTA 표준 템플릿은 규정이 "표는 생략"이라고
       *    정했다 — 그 경우 표 대신 기재할 정보와 사람이 채울 항목을 돌려준다.
       * `format=html`(붙여넣기용) · `csv`(엑셀) · 기본은 JSON(화면용).
       */
      method: 'GET',
      pattern: '/packages/:packageId/table',
      async handle({ params, request }) {
        const pkg = await snapshot(store, params['packageId']!);
        const wanted = request.query['submodel'];
        if (!wanted) throw new ApiError(400, 'BadRequest', 'submodel을 지정하십시오.');
        const submodel = (pkg.environment.submodels ?? []).find(
          (item) => item.idShort === wanted || item.id === wanted,
        );
        if (!submodel) throw new ApiError(404, 'NotFound', `서브모델을 찾을 수 없습니다: ${wanted}`);

        const plan = planFor(submodel);
        const format = request.query['format'];

        if (plan.kind === 'info') {
          const info = submodelInfo(submodel);
          if (format === 'html' || format === 'csv') {
            throw new ApiError(
              409,
              'Conflict',
              `${plan.idShort}은(는) 표를 만들지 않습니다. ${plan.reason}`,
            );
          }
          return json(200, { plan, info });
        }

        const rows = submodelTable(pkg.environment, submodel);
        const tables = submodelTables(pkg.environment, submodel);
        if (format === 'html') {
          // 🔴 화면에 보이는 것과 문서에 붙는 것이 **같아야** 한다 — 같은 HTML을 쓴다
          // 표 번호는 문서 전체에서 이어져야 한다 — 시작값을 받는다
          const from = Number(request.query['from']);
          return {
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
            body: new TextEncoder().encode(
              submodelTablesHtml(tables, {
                submodelName: plan.idShort,
                ...(Number.isFinite(from) && from > 0 ? { from } : {}),
              }),
            ),
          };
        }
        if (format === 'csv') {
          return {
            status: 200,
            headers: {
              'content-type': 'text/csv; charset=utf-8',
              'content-disposition': `attachment; filename="table.csv"; filename*=UTF-8''${encodeURIComponent(`${plan.idShort}.csv`)}`,
            },
            body: new TextEncoder().encode(tableCsv(rows)),
          };
        }
        return json(200, { plan, rows, tables, tableCount: tables.length });
      },
    },
    {
      /** 서브모델마다 어떤 자료를 만들어야 하는지 한눈에 (표인가 정보인가) */
      method: 'GET',
      pattern: '/packages/:packageId/doc-plan',
      async handle({ params }) {
        const pkg = await snapshot(store, params['packageId']!);
        return json(200, {
          result: (pkg.environment.submodels ?? []).map((submodel) => planFor(submodel)),
        });
      },
    },
    {
      /**
       * 설비를 훑어 태그 목록을 가져온다 — NodeId를 손으로 치지 않게 하는 자리.
       *
       * 🔴 파일에 매이지 않는다. 아직 AID를 만들기 **전에** 쓰는 기능이라 packageId가 없다.
       * 🔴 읽기만 한다. 설비에 아무것도 쓰지 않는다.
       */
      method: 'POST',
      pattern: '/opcua/browse',
      success: [200],
      async handle({ request }) {
        if (!options.browseDevice) {
          throw new ApiError(501, 'NotImplemented', '이 배포에는 수집 어댑터가 없습니다.');
        }
        const body = (request.body ?? {}) as Record<string, unknown>;
        const endpoint = String(body['endpoint'] ?? '').trim();
        if (!/^opc\.tcp:\/\/.+/.test(endpoint)) {
          throw new ApiError(400, 'BadRequest', `접속 주소는 opc.tcp:// 로 시작해야 합니다: ${endpoint}`);
        }
        try {
          return json(200, await options.browseDevice(endpoint));
        } catch (error) {
          /*
           * 🔴 자기 자신(또는 같은 도구)을 가리킨 것은 **막는다.** 경고로 두면 안 된다:
           *    담아서 만들면 `createMissing`이 모델에 항목 수십 개와 CD 수십 개를 세우는데,
           *    「연결삭제」는 AID만 지운다 — 되돌릴 길이 없다.
           */
          // 🔴 `instanceof`를 쓰지 않는다 — 이 파일은 프로토콜을 몰라야 한다(browseDevice 주입 원칙).
          //    이름으로 본다: @aas/opcua의 SelfBrowseError가 이 이름을 쓴다.
          if (error instanceof Error && error.name === 'OutboundBlockedError') {
            throw new ApiError(403, 'Forbidden', error.message);
          }
          if (error instanceof Error && error.name === 'SelfBrowseError') {
            throw new ApiError(409, 'Conflict', error.message);
          }
          // 못 붙는 것은 우리 잘못이 아니다 — 사유를 그대로 전한다
          throw new ApiError(
            502,
            'BadGateway',
            error instanceof Error ? error.message : String(error),
          );
        }
      },
    },
    {
      /**
       * 수집 연결(AID) 만들기.
       *
       * AID 구조는 4~5단 중첩이라 「요소 추가」로 사람이 쌓을 수 없다 — 여기서 접속 주소와
       * 태그 목록만 받아 IDTA-02017 규격대로 짓는다. 표준 semanticId까지 함께 붙는다.
       *
       * 🔴 이미 AID가 있으면 **바꿔치운다**(replace). 수집 연결은 장비마다 하나가 정상이고,
       *    두 개가 쌓이면 어느 쪽이 맞는지 알 수 없다.
       */
      method: 'POST',
      pattern: '/packages/:packageId/aid',
      success: [201],
      async handle({ params, request }) {
        const packageId = params['packageId']!;
        const body = (request.body ?? {}) as Record<string, unknown>;

        const shells = await store.listIdentifiables(packageId, 'AssetAdministrationShell');
        const shell = shells.items[0];
        if (!shell?.idShort) {
          throw new ApiError(400, 'BadRequest', 'AAS의 idShort(장비명)가 있어야 AID id를 지을 수 있습니다.');
        }

        let submodel: Record<string, unknown>;
        try {
          submodel = buildAidSubmodel({
            assetName: shell.idShort,
            iriBase: (options.policy?.iriBase ?? DEFAULT_POLICY.iriBase) as string,
            endpoint: String(body['endpoint'] ?? ''),
            title: typeof body['title'] === 'string' ? body['title'] : undefined,
            tags: Array.isArray(body['tags']) ? (body['tags'] as never[]) : [],
          } as never);
        } catch (error) {
          if (error instanceof AidBuildError) throw new ApiError(400, 'BadRequest', error.message);
          throw error;
        }

        const newId = String(submodel['id']);
        // 🔴 자체 IRI 용어의 CD를 함께 넣는다 — 없으면 만든 순간 KOSMO-SME-3 13건으로
        //    태어난다(전문가 시연에서 실측). 이미 있는 id는 건너뛴다
        for (const concept of aidConceptDescriptions({
          assetName: String(shell.idShort),
          iriBase: (options.policy?.iriBase ?? DEFAULT_POLICY.iriBase) as string,
          endpoint: String(body['endpoint'] ?? ''),
          tags: Array.isArray(body['tags']) ? (body['tags'] as never[]) : [],
        } as never)) {
          const cid = String(concept['id']);
          const already = await store.getIdentifiable(packageId, 'ConceptDescription', cid);
          if (!already) await store.createIdentifiable(packageId, concept);
        }
        const existing = await store.getIdentifiable(packageId, 'Submodel', newId);
        if (existing) {
          await store.updateIdentifiable(packageId, 'Submodel', newId, submodel);
        } else {
          await store.createIdentifiable(packageId, submodel);
          // AAS의 submodels[]에도 매단다 — 빠뜨리면 어디에도 매달리지 않은 서브모델이 된다
          const shellContent = JSON.parse(JSON.stringify(shell.content)) as { submodels?: unknown[] };
          (shellContent.submodels ??= []).push({
            type: 'ModelReference',
            keys: [{ type: 'Submodel', value: newId }],
          });
          await store.updateIdentifiable(
            packageId,
            'AssetAdministrationShell',
            shell.id,
            shellContent as unknown as Record<string, unknown>,
          );
        }

        /*
         * 🔴 수집 연결의 **나머지 절반** — 태그가 얹힐 자리를 모델에 세운다.
         *
         * AID만 만들면 수집은 되지만, 모델에 같은 idShort가 없으면 값이 표준 API(live)로도
         * OPC UA 노출로도 나가지 않는다. 지금까지는 그 사실을 경고로만 알렸다 —
         * 태그가 수십 개면 사용자가 트리에서 손으로 다 만들어야 했고, 그건 곧 포기였다.
         *
         * 자리는 KTL 규칙을 따른다: OperationalData > 대분류 > 소분류 > Property.
         * 요청이 `createMissing`을 **명시할 때만** 만든다 — 남의 모델을 조용히 늘리지 않는다.
         */
        const createMissing = body['createMissing'] as
          | { group?: unknown; subgroup?: unknown }
          | undefined;
        let elementsAdded: string[] = [];
        /** 다른 서브모델에 이미 있어 만들지 않은 이름 — 사용자가 알아야 한다 */
        let elementsConflicted: string[] = [];
        if (createMissing) {
          const iriBase = (options.policy?.iriBase ?? DEFAULT_POLICY.iriBase) as string;
          let target = (await store.listIdentifiables(packageId, 'Submodel')).items.find(
            (item) => item.idShort === 'OperationalData',
          );
          /*
           * 🔴 없으면 만든다. OperationalData는 **KOSMO 필수 서브모델**이라(policy.requiredSubmodels)
           *    없는 것 자체가 이미 위반이다. 여기서 400으로 막으면 부가 기능 하나 때문에
           *    「수집 연결 만들기」 본 동작이 통째로 실패한다 — 그건 더 나쁘다.
           */
          if (!target) {
            const smId = `${iriBase}/sm/${shell.idShort}/OperationalData/1/0`;
            const created = await store.createIdentifiable(packageId, {
              modelType: 'Submodel',
              id: smId,
              idShort: 'OperationalData',
              kind: 'Template',
              administration: { version: '1', revision: '0' },
              semanticId: {
                type: 'ExternalReference',
                keys: [{ type: 'GlobalReference', value: smId }],
              },
              // 🔴 submodelElements를 비워 두지 않는다 — V3.0 스키마가 빈 배열을 거부한다.
              //    바로 아래 merge가 채운다
            });
            const shellNow = await store.getIdentifiable(
              packageId,
              'AssetAdministrationShell',
              shell.id,
            );
            const content = JSON.parse(JSON.stringify(shellNow?.content ?? shell.content)) as {
              submodels?: unknown[];
            };
            (content.submodels ??= []).push({
              type: 'ModelReference',
              keys: [{ type: 'Submodel', value: smId }],
            });
            await store.updateIdentifiable(
              packageId,
              'AssetAdministrationShell',
              shell.id,
              content as unknown as Record<string, unknown>,
            );
            target = created;
          }
          /*
           * 🔴 파일 **전체**에서 값이 얹힐 수 있는 이름을 모아 넘긴다. 대상 서브모델 안만 보면
           *    DigitalNameplate의 `SerialNumber` 같은 이름을 여기 또 만들고,
           *    그러면 수집값이 어느 쪽에 얹힐지 몰라 **둘 다** 못 얹는다(실측).
           *    판정은 `valuedNames`가 한다 — 덧씌우기와 같은 규칙이어야 갈라지지 않는다.
           */
          const takenNames = valuedNames(await store.getEnvironment(packageId), target.id);

          try {
            const merged = mergeRuntimeGroup(target.content, {
              iriBase,
              takenNames,
              group: String(createMissing.group ?? 'ProcessMonitoring'),
              subgroup: String(createMissing.subgroup ?? 'CollectedValues'),
              tags: Array.isArray(body['tags']) ? (body['tags'] as never[]) : [],
            });
            if (merged.added.length > 0) {
              for (const concept of merged.conceptDescriptions) {
                const cid = String(concept['id']);
                const already = await store.getIdentifiable(packageId, 'ConceptDescription', cid);
                if (!already) {
                  await store.createIdentifiable(packageId, concept);
                  continue;
                }
                /*
                 * 🔴 CD 하나를 AID와 모델이 **함께 쓴다**(같은 태그 이름 = 같은 cd/{name}).
                 *    AID 쪽이 먼저 STRING으로 만들어 두는데, 모델 Property가 xs:double이면
                 *    KOSMO-SME-5로 걸린다(실측). 자료형을 아는 쪽은 **Property다** —
                 *    AID의 그 요소는 SMC라 SME-5 검사 대상이 아니어서 바꿔도 탈이 없다.
                 *    우리가 만든 자체 IRI CD일 때만 손댄다.
                 */
                if (!cid.startsWith(iriBase)) continue;
                await store.updateIdentifiable(packageId, 'ConceptDescription', cid, {
                  ...already.content,
                  embeddedDataSpecifications: concept['embeddedDataSpecifications'],
                });
              }
              await store.updateIdentifiable(packageId, 'Submodel', target.id, merged.submodel);
            }
            elementsAdded = merged.added;
            elementsConflicted = merged.conflicts;
          } catch (error) {
            if (error instanceof RuntimeBuildError)
              throw new ApiError(400, 'BadRequest', error.message);
            throw error;
          }
        }

        // 만들자마자 알려 준다: 태그 이름이 모델 요소와 맞는가 (live 내보내기의 조건)
        const environment = await store.getEnvironment(packageId);
        const overlay = overlayEnvironment(
          environment,
          (Array.isArray(body['tags']) ? (body['tags'] as { name: string }[]) : []).map((tag) => ({
            packageId,
            interfaceName: 'InterfaceTemplateForOPCUA',
            propertyName: tag.name,
            observedAt: new Date().toISOString(),
            valueText: '',
          })),
        );

        return json(201, {
          submodelId: newId,
          replaced: existing !== null && existing !== undefined,
          nameMatches: overlay.notes.filter((note) => note.outcome === 'applied').length,
          nameMisses: overlay.notes
            .filter((note) => note.outcome !== 'applied')
            .map((note) => note.propertyName),
          /** createMissing으로 새로 세운 요소 */
          elementsAdded,
          /** 다른 서브모델에 같은 이름이 있어 만들지 않은 것 */
          elementsConflicted,
        });
      },
    },
    {
      /**
       * 수집값이 모델의 어느 요소에 얹히는지 — **연결 상태 점검**.
       *
       * 🔴 이게 없으면 `live=true`로 읽어도 값이 안 바뀌는 이유를 알 수 없다.
       *    실측 사례: 시연 파일의 AID는 `MotorSpeed`를 수집하는데 모델에는 그 이름이 없다
       *    (모델은 `CurrentLineSpeed`). **AID 이름과 요소 idShort가 맞아야 얹힌다.**
       */
      method: 'GET',
      pattern: '/packages/:packageId/live',
      async handle({ params }) {
        const packageId = params['packageId']!;
        const pkg = await snapshot(store, packageId);
        const samples = await store.readValues(packageId, { limit: 500 });
        const result = overlayEnvironment(pkg.environment, samples);
        return json(200, {
          collected: latestByProperty(samples).size,
          applied: result.applied,
          notes: result.notes,
        });
      },
    },
    {
      method: 'GET',
      pattern: '/packages/:packageId/policy',
      async handle({ params }) {
        const record = await store.getPackage(params['packageId']!);
        if (!record) throw new ApiError(404, 'NotFound', '패키지를 찾을 수 없습니다.');
        // 저작 UI가 새 id를 만들 때 쓴다. 규약(iriBase 등)을 UI에 복사해 두면
        // 린터와 UI가 서로 다른 규칙을 갖게 된다 — 지식은 한 곳에만 둔다
        return json(200, { ...DEFAULT_POLICY, ...options.policy });
      },
    },
    {
      method: 'GET',
      pattern: '/packages/:packageId/lint',
      async handle({ params, request }) {
        const pkg = await snapshot(store, params['packageId']!);
        const overrides = { ...options.policy, ...policyFromQuery(request) };
        const result = lint(pkg.environment, ALL_RULES, {
          package: pkg.opc,
          ...(Object.keys(overrides).length > 0 ? { policy: overrides } : {}),
        });
        const detail = request.query['detail'] === 'true';
        return json(200, {
          ...lintSummary(result),
          findings: detail
            ? result.findings
            : result.findings.filter((f: Finding) => f.severity === 'error'),
        });
      },
    },
    {
      /** 검증 결과서 — 브라우저에서 열어 그대로 인쇄하면 PDF가 된다(기획서 Phase 3 산출물) */
      method: 'GET',
      pattern: '/packages/:packageId/report',
      async handle({ params, request }) {
        const packageId = params['packageId']!;
        const record = await store.getPackage(packageId);
        if (!record) throw new ApiError(404, 'NotFound', '패키지를 찾을 수 없습니다.');
        const pkg = await snapshot(store, packageId);
        // 🔴 /lint와 같은 정책으로 판정해야 한다. 한때 여기만 DEFAULT_POLICY로 고정돼
        //    화면은 위반 10건인데 결과서는 합격으로 찍혔다(2026-09-03 검토에서 발견).
        //    결과서는 제출 첨부물이라 화면과 다르면 어느 쪽도 못 믿는다
        const overrides = { ...options.policy, ...policyFromQuery(request) };
        const policy = { ...DEFAULT_POLICY, ...overrides };
        const result = lint(pkg.environment, ALL_RULES, {
          package: pkg.opc,
          ...(Object.keys(overrides).length > 0 ? { policy: overrides } : {}),
        });
        const html = formatHtmlReport(result, {
          title: record.name,
          generatedAt: localTimestamp(new Date()),
          policy,
          relocations: await readLedger(store, packageId),
        });
        return {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
          body: new TextEncoder().encode(html),
        };
      },
    },
    {
      method: 'POST',
      pattern: '/packages/:packageId/fix',
      async handle({ params, request }) {
        const packageId = params['packageId']!;
        const overrides = { ...options.policy, ...policyFromQuery(request) };
        const includeWarnings = request.query['includeWarnings'] === '1' || request.query['includeWarnings'] === 'true';
        const body = (request.body ?? {}) as { select?: unknown };
        const select = Array.isArray(body.select)
          ? (body.select as unknown[]).filter(
              (s): s is FixSelector =>
                typeof s === 'object' && s !== null && typeof (s as FixSelector).ruleId === 'string' && typeof (s as FixSelector).pointer === 'string',
            )
          : undefined;
        const { result, counts, ledger } = await fixOne(store, packageId, overrides, includeWarnings, select);
        return json(200, {
          applied: result.applied,
          skipped: result.skipped,
          relocations: result.relocations,
          ledger,
          rounds: result.rounds,
          before: lintSummary(result.before),
          after: lintSummary(result.after),
          store: counts,
        });
      },
    },
    {
      /** 교정 미리보기 — 저장하지 않는다. 화면 팝업이 항목별 전/후를 보여 주고 체크한 것만 POST /fix로 보낸다 */
      method: 'GET',
      pattern: '/packages/:packageId/fix-preview',
      async handle({ params, request }) {
        const packageId = params['packageId']!;
        if (!(await store.getPackage(packageId))) throw new ApiError(404, 'NotFound', '패키지를 찾을 수 없습니다.');
        const overrides = { ...options.policy, ...policyFromQuery(request) };
        const includeWarnings = request.query['includeWarnings'] === '1' || request.query['includeWarnings'] === 'true';
        const result = await previewFix(store, packageId, overrides, includeWarnings);
        return json(200, {
          applied: result.applied,
          skipped: result.skipped,
          relocations: result.relocations,
          rounds: result.rounds,
          before: lintSummary(result.before),
          after: lintSummary(result.after),
        });
      },
    },
    {
      /** IRI 이관 대장 — 새 IRI → 원본 IRI */
      method: 'GET',
      pattern: '/packages/:packageId/relocations',
      async handle({ params }) {
        const packageId = params['packageId']!;
        if (!(await store.getPackage(packageId))) throw new ApiError(404, 'NotFound', '패키지를 찾을 수 없습니다.');
        return json(200, { relocations: await readLedger(store, packageId) });
      },
    },
    {
      /**
       * 원본 IRI로 되돌리기 — 규정 해석이 뒤집혔을 때. body `{ iris?: string[] }` 없으면 전부.
       * 되돌린 뒤 KOSMO 우선 정책이면 다시 위반으로 잡힌다 — 그게 맞다(사용자가 정책을 바꿔 판정한다)
       */
      method: 'POST',
      pattern: '/packages/:packageId/relocations/revert',
      async handle({ params, request }) {
        const packageId = params['packageId']!;
        if (!(await store.getPackage(packageId))) throw new ApiError(404, 'NotFound', '패키지를 찾을 수 없습니다.');
        const ledger = await readLedger(store, packageId);
        const body = (request.body ?? {}) as { iris?: unknown };
        const only = Array.isArray(body.iris) ? (body.iris as unknown[]).filter((v): v is string => typeof v === 'string') : undefined;
        const pkg = await snapshot(store, packageId);
        const outcome = revertRelocations(pkg.environment, ledger, only);
        const counts = await writeBackEnvironment(store, packageId, outcome.environment);
        await writeLedger(store, packageId, outcome.remaining);
        return json(200, { reverted: outcome.reverted, remaining: outcome.remaining, store: counts });
      },
    },
  ];
}
