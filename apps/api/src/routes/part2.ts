/**
 * IDTA Part 2 (IDTA-01002-3-0) 정합 REST API.
 *
 * 기저 경로는 `/packages/{packageId}/api/v3.0` 이다.
 * 규격은 저장소 하나를 전제하지만 우리는 AASX 파일 단위로 작업하므로, 패키지를 앞에 두고
 * **그 아래를 규격 그대로** 뒀다. Part 2 클라이언트(BaSyx 등)는 기저 URL만 이 주소로 잡으면 된다.
 *
 * 구현 범위 (MVP)
 *  ✅ /shells · /submodels · /concept-descriptions CRUD + 페이지네이션(limit·cursor)
 *  ✅ /submodels/{id}/submodel-elements/{idShortPath} CRUD, $value 조회·수정
 *  ✅ 식별자 base64url 인코딩, Result/Message 오류 본문
 *  ⬜ $metadata · level · extent 수식자, /lookup(자산 검색), 디스크립터(Part 2 Registry)
 *     — 저작 UI(M3)에 필요해지는 시점에 붙인다
 *
 * 상태 코드는 규격을 따른다 — POST는 201 + 본문, PUT·PATCH·DELETE는 204(본문 없음).
 * 저작 UI가 낙관적 잠금을 이어가려면 새 리비전을 알아야 하므로 **204에도 ETag를 붙인다**.
 * 🔴 IDTA-01002-3-0 원문을 아직 손에 넣지 못했다(docs/PROGRESS.md §7). 원문을 받으면
 * 상태 코드와 오류 본문을 한 번 대조할 것.
 */
import { writeAasx } from '@aas/aasx';
import { overlaySubmodel } from '@aas/collector';
import type { Environment, Submodel, SubmodelElement } from '@aas/core';
import {
  type AasStore,
  type IdentifiableModelType,
  type ListQuery,
  type WriteOptions,
} from '@aas/store';
import { decodeIdentifier } from '../base64url.js';
import {
  applyMetadata,
  applyValueOnly,
  collectPaths,
  containerFor,
  pathsUnder,
  referenceOf,
  resolveIdShortPath,
  submodelValueOnly,
  toMetadata,
  toValueOnly,
} from '../elements.js';
import { ApiError, bytes, json, noContent, pagedResponse, type ApiRequest, type ApiResponse } from '../http.js';
import { AASX_MEDIA_TYPE } from './packages.js';
import { fieldValues, fileOf, parseMultipart } from '../multipart.js';
import type { Route, RouteContext } from '../router.js';

const BASE = '/packages/:packageId/api/v3.0';

/**
 * 규격의 질의 인자를 읽는다 — limit · cursor · idShort · semanticId · assetKind.
 * semanticId는 규격상 base64url로 인코딩돼 온다.
 * (level · extent · assetIds · assetType은 아직 지원하지 않는다 — PROGRESS §4에 남겼다)
 */
function pageOf(request: ApiRequest): ListQuery {
  const page: ListQuery = {};
  const limit = request.query['limit'];
  if (limit !== undefined) {
    const parsed = Number(limit);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new ApiError(400, 'BadRequest', `limit이 양의 정수가 아닙니다: ${limit}`);
    }
    page.limit = parsed;
  }
  const cursor = request.query['cursor'];
  if (cursor !== undefined) page.cursor = cursor;

  const idShort = request.query['idShort'];
  if (idShort !== undefined) page.idShort = idShort;

  const semanticId = request.query['semanticId'];
  if (semanticId !== undefined) page.semanticId = decodeIdentifier(semanticId);

  const assetKind = request.query['assetKind'];
  if (assetKind !== undefined) page.assetKind = assetKind;

  return page;
}

/**
 * If-Match 헤더를 낙관적 잠금에 쓴다.
 * Part 2가 정한 것은 아니지만 HTTP 관례를 그대로 따르는 편이 클라이언트에 자연스럽다.
 * 값은 리비전 숫자다(응답의 ETag와 짝).
 */
function writeOptionsOf(request: ApiRequest): WriteOptions {
  const ifMatch = request.headers['if-match'];
  if (!ifMatch || ifMatch === '*') return {};
  const revision = Number(ifMatch.replace(/"/g, ''));
  if (!Number.isInteger(revision)) {
    throw new ApiError(400, 'BadRequest', `If-Match가 리비전 숫자가 아닙니다: ${ifMatch}`);
  }
  return { expectedRevision: revision };
}

function bodyObject(request: ApiRequest): Record<string, unknown> {
  const body = request.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ApiError(400, 'BadRequest', '본문이 JSON 객체가 아닙니다.');
  }
  return body as Record<string, unknown>;
}

function withEtag(response: ApiResponse, revision: number): ApiResponse {
  return { ...response, headers: { ...response.headers, etag: `"${revision}"` } };
}

/**
 * Identifiable 3종에 공통인 CRUD 묶음.
 *
 * 🔴 PATCH는 **Submodel에만** 있다. 규격은 `/shells/{id}`·`/concept-descriptions/{id}`에
 * PATCH를 정의하지 않는다 — 공유 코드라고 다 열어 주면 표준 경로에 비표준 메서드가 생긴다.
 * (실제로 한 번 그렇게 열렸다가 대조 스크립트가 잡아냈다)
 */
function identifiableRoutes(
  store: AasStore,
  segment: string,
  modelType: IdentifiableModelType,
): Route[] {
  const patchable = modelType === 'Submodel';
  const collection = `${BASE}/${segment}`;
  const item = `${collection}/:identifier`;

  const idOf = (ctx: RouteContext): string => decodeIdentifier(ctx.params['identifier']!);

  return [
    {
      method: 'GET',
      pattern: collection,
      success: [200],
      async handle({ request, params }) {
        const page = await store.listIdentifiables(params['packageId']!, modelType, pageOf(request));
        return pagedResponse(
          page.items.map((r) => r.content),
          page.cursor,
        );
      },
    },
    {
      method: 'POST',
      pattern: collection,
      success: [201],
      async handle({ request, params }) {
        const content = bodyObject(request);
        if (content['modelType'] !== modelType) {
          throw new ApiError(
            400,
            'BadRequest',
            `이 경로에는 ${modelType}만 만들 수 있습니다: ${String(content['modelType'])}`,
          );
        }
        const created = await store.createIdentifiable(params['packageId']!, content);
        return withEtag(json(201, created.content), created.revision);
      },
    },
    {
      method: 'GET',
      pattern: item,
      success: [200],
      async handle(ctx) {
        const record = await store.getIdentifiable(ctx.params['packageId']!, modelType, idOf(ctx));
        if (!record) throw new ApiError(404, 'NotFound', `${modelType}을(를) 찾을 수 없습니다.`);
        return withEtag(json(200, record.content), record.revision);
      },
    },
    {
      method: 'PUT',
      pattern: item,
      success: [204],
      async handle(ctx) {
        const updated = await store.updateIdentifiable(
          ctx.params['packageId']!,
          modelType,
          idOf(ctx),
          bodyObject(ctx.request),
          writeOptionsOf(ctx.request),
        );
        return withEtag(noContent(), updated.revision);
      },
    },
    ...(patchable
      ? [{
      /**
       * PATCH — 부분 갱신. 본문에 온 필드만 덮어쓴다.
       * PUT은 통째 교체라 값까지 날아간다. 한 속성만 고칠 때 쓰는 길이 따로 있어야 한다.
       */
      method: 'PATCH',
      pattern: item,
      success: [204],
      async handle(ctx) {
        const packageId = ctx.params['packageId']!;
        const id = idOf(ctx);
        const current = await store.getIdentifiable(packageId, modelType, id);
        if (!current) throw new ApiError(404, 'NotFound', `${modelType}을(를) 찾을 수 없습니다.`);
        const merged = { ...current.content, ...bodyObject(ctx.request), modelType, id };
        const updated = await store.updateIdentifiable(
          packageId,
          modelType,
          id,
          merged,
          writeOptionsOf(ctx.request),
        );
        return withEtag(noContent(), updated.revision);
      },
    }] satisfies Route[]
      : []),
    {
      method: 'DELETE',
      pattern: item,
      success: [204],
      async handle(ctx) {
        await store.deleteIdentifiable(
          ctx.params['packageId']!,
          modelType,
          idOf(ctx),
          writeOptionsOf(ctx.request),
        );
        return noContent();
      },
    },
  ];
}

/**
 * 경로에서 대상 Submodel의 id를 정한다.
 *
 * 규격에는 같은 서브모델을 두 갈래로 가리킨다 —
 *   평면: `/submodels/{smId}`            (Submodel Repository)
 *   중첩: `/shells/{aasId}/submodels/{smId}` (AAS Repository)
 * 뒤엣것은 **그 AAS가 실제로 참조하는 서브모델인지** 확인해야 한다. 아니면 남의 것을 열어 준다.
 */
export type SubmodelLocator = (store: AasStore, ctx: RouteContext) => Promise<string>;

const flatLocator: SubmodelLocator = async (_store, ctx) =>
  decodeIdentifier(ctx.params['identifier']!);

const nestedLocator: SubmodelLocator = async (store, ctx) => {
  const packageId = ctx.params['packageId']!;
  const aasId = decodeIdentifier(ctx.params['identifier']!);
  const submodelId = decodeIdentifier(ctx.params['submodelIdentifier']!);

  const shell = await store.getIdentifiable(packageId, 'AssetAdministrationShell', aasId);
  if (!shell) throw new ApiError(404, 'NotFound', 'AAS를 찾을 수 없습니다.');

  const referenced = ((shell.content as { submodels?: { keys?: { value?: string }[] }[] }).submodels ?? [])
    .flatMap((reference) => reference.keys ?? [])
    .some((key) => key.value === submodelId);
  if (!referenced) {
    throw new ApiError(404, 'NotFound', '이 AAS가 참조하지 않는 Submodel입니다.');
  }
  return submodelId;
};

/** 경로가 가리키는 AAS를 꺼낸다. 없으면 404 */
async function requireShell(store: AasStore, ctx: RouteContext) {
  const record = await store.getIdentifiable(
    ctx.params['packageId']!,
    'AssetAdministrationShell',
    decodeIdentifier(ctx.params['identifier']!),
  );
  if (!record) throw new ApiError(404, 'NotFound', 'AAS를 찾을 수 없습니다.');
  return record;
}

/** 모델이 가리키는 썸네일 파트를 패키지에서 찾는다 */
async function findThumbnail(
  store: AasStore,
  packageId: string,
  shell: Record<string, unknown>,
): Promise<{ data: Uint8Array; contentType: string } | undefined> {
  const path = (
    (shell['assetInformation'] as { defaultThumbnail?: { path?: string } } | undefined)
      ?.defaultThumbnail
  )?.path;
  const files = await store.packageFiles(packageId);
  const file = path ? files.find((f) => f.part === path) : files.find((f) => f.role === 'thumbnail');
  return file ? { data: file.data, contentType: file.contentType } : undefined;
}

/** File·Blob 요소가 가리키는 패키지 파트 이름 (`file:///x` → `/x`) */
function attachmentPartOf(node: SubmodelElement): string | undefined {
  const raw = (node as unknown as Record<string, unknown>)['value'];
  const value = typeof raw === 'string' ? raw : undefined;
  if (!value) return undefined;
  const withoutScheme = value.replace(/^file:\/\//i, '');
  return withoutScheme.startsWith('/') ? withoutScheme : `/${withoutScheme}`;
}

/** multipart(fileName·file) 또는 원본 바이트 업로드를 읽는다 */
function uploadedFile(request: ApiRequest): { name: string; contentType: string; data: Uint8Array } {
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
      throw new ApiError(400, 'BadRequest', error instanceof Error ? error.message : String(error));
    }
    const file = fileOf(parts, 'file');
    if (!file) throw new ApiError(400, 'BadRequest', 'file 조각이 없습니다.');
    const name = fieldValues(parts, 'fileName')[0] ?? file.filename ?? 'thumbnail.png';
    return { name, contentType: file.contentType ?? guessImageType(name), data: file.data };
  }

  if (!(body instanceof Uint8Array)) {
    throw new ApiError(400, 'BadRequest', '본문이 파일 바이트가 아닙니다.');
  }
  const name = request.query['fileName'] ?? 'thumbnail.png';
  return { name, contentType: contentType || guessImageType(name), data: body };
}

function guessImageType(name: string): string {
  const extension = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  const known: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    svg: 'image/svg+xml',
  };
  return known[extension] ?? 'application/octet-stream';
}

/** Submodel 하나를 꺼내 편집하고 되쓰는 공통 흐름 */
async function editSubmodel(
  store: AasStore,
  ctx: RouteContext,
  resolveSubmodel: SubmodelLocator,
  edit: (submodel: Submodel) => ApiResponse | void,
  respond: (revision: number, submodel: Submodel) => ApiResponse = (revision) =>
    withEtag(noContent(), revision),
): Promise<ApiResponse> {
  const packageId = ctx.params['packageId']!;
  const id = await resolveSubmodel(store, ctx);
  const record = await store.getIdentifiable(packageId, 'Submodel', id);
  if (!record) throw new ApiError(404, 'NotFound', 'Submodel을 찾을 수 없습니다.');

  const submodel = JSON.parse(JSON.stringify(record.content)) as Submodel;
  const early = edit(submodel);
  if (early) return early;

  const updated = await store.updateIdentifiable(
    packageId,
    'Submodel',
    id,
    submodel as unknown as Record<string, unknown>,
    writeOptionsOf(ctx.request),
  );
  return respond(updated.revision, updated.content as unknown as Submodel);
}

/**
 * 읽기용 서브모델.
 *
 * 🔴 `?live=true`면 **최신 수집값을 응답에만 얹는다**(BaSyx DataBridge와 같은 겉모습).
 *    파일은 건드리지 않는다 — 값 동기화 A안 그대로다. 기본은 꺼져 있어,
 *    아무 표시 없이 파일 값과 현장 값이 섞이는 일은 없다.
 * 🔴 **쓰기 경로(editSubmodel)에는 절대 쓰지 않는다.** 저장은 언제나 파일 값을 바탕으로 한다 —
 *    덧씌운 값을 저장하면 그 순간 A안이 깨진다.
 */
async function readSubmodel(
  store: AasStore,
  ctx: RouteContext,
  resolveSubmodel: SubmodelLocator,
): Promise<Submodel> {
  const packageId = ctx.params['packageId']!;
  const record = await store.getIdentifiable(
    packageId,
    'Submodel',
    await resolveSubmodel(store, ctx),
  );
  if (!record) throw new ApiError(404, 'NotFound', 'Submodel을 찾을 수 없습니다.');
  const submodel = record.content as unknown as Submodel;

  if (ctx.request.query['live'] !== 'true') return submodel;
  const samples = await store.readValues(packageId, { limit: 500 });
  if (samples.length === 0) return submodel;
  return overlaySubmodel(submodel, samples).content;
}

/**
 * 이름(idShort)을 바꿀 때 지켜야 하는 두 가지. **저장 시점에** 막는다.
 *
 * ① 형제끼리 같은 이름이면 안 된다(AASd-022). 린터도 잡지만 그때는 이미 늦다 —
 *    같은 이름이 둘이면 `idShortPath`가 가리키는 곳이 애매해져서 **엉뚱한 요소가 조용히 고쳐진다.**
 * ② SubmodelElementList의 직계 자식은 idShort를 가지면 안 된다(AASd-120).
 *    리스트 자식은 순서로 가리키기 때문이다. 이름을 붙이면 basyx가 그 가지를 통째로 잃는다.
 */
function guardIdShort(
  path: string,
  found: { list: SubmodelElement[]; index: number; node: SubmodelElement },
  next: SubmodelElement,
): void {
  const nextName = (next as unknown as Record<string, unknown>)['idShort'];
  const currentName = (found.node as unknown as Record<string, unknown>)['idShort'];
  if (nextName === currentName) return; // 이름을 안 바꾼다면 볼 것 없다

  // 마지막 마디가 `[n]`으로 끝나면 리스트 자식이다 — 순서로 가리키는 자리다
  const lastSegment = path.split('.').at(-1) ?? '';
  if (/\]$/.test(lastSegment)) {
    if (typeof nextName === 'string' && nextName !== '') {
      throw new ApiError(
        400,
        'BadRequest',
        'SubmodelElementList의 자식에는 idShort를 붙일 수 없습니다(AASd-120). 리스트 자식은 순서로 가리킵니다.',
      );
    }
    return;
  }

  if (typeof nextName !== 'string' || nextName === '') return;
  const taken = found.list.some(
    (sibling, index) =>
      index !== found.index &&
      (sibling as unknown as Record<string, unknown>)['idShort'] === nextName,
  );
  if (taken) {
    throw new ApiError(
      400,
      'BadRequest',
      `같은 자리에 이미 「${nextName}」이(가) 있습니다. 형제끼리 이름이 겹치면 안 됩니다(AASd-022).`,
    );
  }
}

function locate(submodel: Submodel, path: string): ReturnType<typeof resolveIdShortPath> {
  const found = resolveIdShortPath(submodel, path);
  if (!found) throw new ApiError(404, 'NotFound', `요소를 찾을 수 없습니다: ${path}`);
  return found;
}

/**
 * 직렬화 수식자 — `$value` · `$metadata` · `$reference` · `$path`.
 *
 * 표준 클라이언트(BaSyx 등)가 실제로 쓰는 경로다. 통짜 JSON을 주고받으면 값만 필요할 때도
 * 서브모델 전체가 오간다 — 설비 하나에 요소 175개다.
 *  $value    값만 (ValueOnly)
 *  $metadata 값을 뺀 나머지 — 구조·의미만 볼 때
 *  $reference 그 자원을 가리키는 ModelReference
 *  $path     idShortPath 목록 — 트리를 받지 않고 위치만 훑을 때
 */
function submodelModifierRoutes(
  store: AasStore,
  item: string,
  resolveSubmodel: SubmodelLocator,
): Route[] {
  return [
    {
      method: 'GET',
      pattern: `${item}/$value`,
      success: [200],
      async handle(ctx) {
        return json(200, submodelValueOnly(await readSubmodel(store, ctx, resolveSubmodel)));
      },
    },
    {
      method: 'PATCH',
      pattern: `${item}/$value`,
      success: [204],
      async handle(ctx) {
        const body = bodyObject(ctx.request);
        return editSubmodel(store, ctx, resolveSubmodel, (submodel) => {
          // 자식 idShort를 키로 받아 값만 갈아 끼운다. 없는 이름은 무시하지 않고 알린다
          for (const [idShort, value] of Object.entries(body)) {
            const found = resolveIdShortPath(submodel, idShort);
            if (!found) throw new ApiError(404, 'NotFound', `요소를 찾을 수 없습니다: ${idShort}`);
            applyValueOnly(found.node, value);
          }
        });
      },
    },
    {
      method: 'GET',
      pattern: `${item}/$metadata`,
      success: [200],
      async handle(ctx) {
        return json(200, toMetadata(await readSubmodel(store, ctx, resolveSubmodel) as unknown as Record<string, unknown>));
      },
    },
    {
      method: 'PATCH',
      pattern: `${item}/$metadata`,
      success: [204],
      async handle(ctx) {
        const metadata = bodyObject(ctx.request);
        return editSubmodel(store, ctx, resolveSubmodel, (submodel) => {
          applyMetadata(submodel as unknown as Record<string, unknown>, metadata);
        });
      },
    },
    {
      method: 'GET',
      pattern: `${item}/$reference`,
      success: [200],
      async handle(ctx) {
        const submodel = await readSubmodel(store, ctx, resolveSubmodel);
        return json(200, referenceOf('Submodel', submodel.id));
      },
    },
    {
      method: 'GET',
      pattern: `${item}/$path`,
      success: [200],
      async handle(ctx) {
        return json(200, collectPaths(await readSubmodel(store, ctx, resolveSubmodel)));
      },
    },
  ];
}

function submodelElementRoutes(
  store: AasStore,
  prefix: string,
  resolveSubmodel: SubmodelLocator,
): Route[] {
  const elements = `${prefix}/submodel-elements`;

  return [
    {
      method: 'GET',
      pattern: `${elements}/$value`,
      success: [200],
      async handle(ctx) {
        return json(200, submodelValueOnly(await readSubmodel(store, ctx, resolveSubmodel)));
      },
    },
    {
      method: 'GET',
      pattern: `${elements}/$metadata`,
      success: [200],
      async handle(ctx) {
        const submodel = await readSubmodel(store, ctx, resolveSubmodel);
        return json(
          200,
          (submodel.submodelElements ?? []).map((node) =>
            toMetadata(node as unknown as Record<string, unknown>),
          ),
        );
      },
    },
    {
      method: 'GET',
      pattern: `${elements}/$reference`,
      success: [200],
      async handle(ctx) {
        const submodel = await readSubmodel(store, ctx, resolveSubmodel);
        return json(
          200,
          (submodel.submodelElements ?? []).map((node) => ({
            type: 'ModelReference',
            keys: [
              { type: 'Submodel', value: submodel.id },
              { type: node.modelType, value: node.idShort ?? '' },
            ],
          })),
        );
      },
    },
    {
      method: 'GET',
      pattern: `${elements}/$path`,
      success: [200],
      async handle(ctx) {
        return json(200, collectPaths(await readSubmodel(store, ctx, resolveSubmodel)));
      },
    },
    {
      method: 'GET',
      pattern: `${elements}/:path/$metadata`,
      success: [200],
      async handle(ctx) {
        const submodel = await readSubmodel(store, ctx, resolveSubmodel);
        const found = locate(submodel, ctx.params['path']!)!;
        return json(200, toMetadata(found.node as unknown as Record<string, unknown>));
      },
    },
    {
      method: 'PATCH',
      pattern: `${elements}/:path/$metadata`,
      success: [204],
      async handle(ctx) {
        const metadata = bodyObject(ctx.request);
        const path = ctx.params['path']!;
        return editSubmodel(store, ctx, resolveSubmodel, (submodel) => {
          const found = locate(submodel, path)!;
          applyMetadata(found.node as unknown as Record<string, unknown>, metadata);
        });
      },
    },
    {
      method: 'GET',
      pattern: `${elements}/:path/$reference`,
      success: [200],
      async handle(ctx) {
        const submodel = await readSubmodel(store, ctx, resolveSubmodel);
        const found = locate(submodel, ctx.params['path']!)!;
        return json(200, {
          type: 'ModelReference',
          keys: [
            { type: 'Submodel', value: submodel.id },
            { type: found.node.modelType, value: found.node.idShort ?? ctx.params['path']! },
          ],
        });
      },
    },
    {
      method: 'GET',
      pattern: `${elements}/:path/$path`,
      success: [200],
      async handle(ctx) {
        const submodel = await readSubmodel(store, ctx, resolveSubmodel);
        locate(submodel, ctx.params['path']!); // 없으면 404
        return json(200, pathsUnder(submodel, ctx.params['path']!));
      },
    },
    {
      method: 'GET',
      pattern: elements,
      success: [200],
      async handle(ctx) {
        const submodel = await readSubmodel(store, ctx, resolveSubmodel);
        return json(200, submodel.submodelElements ?? []);
      },
    },
    {
      method: 'POST',
      pattern: elements,
      success: [201],
      async handle(ctx) {
        const element = bodyObject(ctx.request) as unknown as SubmodelElement;
        return editSubmodel(
          store,
          ctx,
          resolveSubmodel,
          (submodel) => {
            (submodel.submodelElements ??= []).push(element);
          },
          (revision) => withEtag(json(201, element), revision),
        );
      },
    },
    {
      method: 'POST',
      pattern: `${elements}/:path`,
      success: [201],
      async handle(ctx) {
        const element = bodyObject(ctx.request) as unknown as SubmodelElement;
        const path = ctx.params['path']!;
        return editSubmodel(
          store,
          ctx,
          resolveSubmodel,
          (submodel) => {
            const container = containerFor(submodel, path);
            if (!container) {
              throw new ApiError(404, 'NotFound', `부모 요소를 찾을 수 없습니다: ${path}`);
            }
            container.push(element);
          },
          (revision) => withEtag(json(201, element), revision),
        );
      },
    },
    {
      method: 'GET',
      pattern: `${elements}/:path`,
      success: [200],
      async handle(ctx) {
        const submodel = await readSubmodel(store, ctx, resolveSubmodel);
        return json(200, locate(submodel, ctx.params['path']!)!.node);
      },
    },
    {
      method: 'PUT',
      pattern: `${elements}/:path`,
      success: [204],
      async handle(ctx) {
        const element = bodyObject(ctx.request) as unknown as SubmodelElement;
        const path = ctx.params['path']!;
        return editSubmodel(store, ctx, resolveSubmodel, (submodel) => {
          const found = locate(submodel, path)!;
          guardIdShort(path, found, element);
          found.list[found.index] = element;
        });
      },
    },
    {
      method: 'DELETE',
      pattern: `${elements}/:path`,
      success: [204],
      async handle(ctx) {
        const path = ctx.params['path']!;
        return editSubmodel(store, ctx, resolveSubmodel, (submodel) => {
          const found = locate(submodel, path)!;
          found.list.splice(found.index, 1);
        });
      },
    },
    {
      /** PATCH 요소 — 부분 갱신(PUT은 통째 교체) */
      method: 'PATCH',
      pattern: `${elements}/:path`,
      success: [204],
      async handle(ctx) {
        const patch = bodyObject(ctx.request);
        const path = ctx.params['path']!;
        return editSubmodel(store, ctx, resolveSubmodel, (submodel) => {
          const found = locate(submodel, path)!;
          const merged = {
            ...(found.node as unknown as Record<string, unknown>),
            ...patch,
          } as unknown as SubmodelElement;
          guardIdShort(path, found, merged);
          found.list[found.index] = merged;
        });
      },
    },
    {
      /**
       * POST 요소 옮기기(규격 밖) — 형제 안에서 한 칸 위/아래.
       * Part 2에는 순서를 바꾸는 연산이 없다(PUT은 통째 교체뿐). 그런데 AAS의 요소 순서는
       * **문서 순서**다 — 가이던스 표·Package Explorer 화면이 그 순서로 나온다. 잘못 만든 순서를
       * 지우고 다시 만들게 하지 않으려면 이 한 연산이 필요하다(2026-09-04 전문가 검토).
       * body `{ offset: -1 | 1 }`(한 칸) 또는 `{ to: n }`(형제 중 n번째 자리로 — 트리에서 끌어다 놓기).
       * 끝에서 더 가거나 범위 밖이면 400.
       */
      method: 'POST',
      pattern: `${elements}/:path/move`,
      success: [204],
      async handle(ctx) {
        const body = bodyObject(ctx.request);
        const hasTo = body['to'] !== undefined;
        const offset = Number(body['offset']);
        const toIndex = Number(body['to']);
        if (hasTo ? !Number.isInteger(toIndex) || toIndex < 0 : offset !== -1 && offset !== 1)
          throw new ApiError(400, 'BadRequest', 'offset은 -1(위)·1(아래), to는 0 이상의 정수여야 합니다.');
        const path = ctx.params['path']!;
        return editSubmodel(store, ctx, resolveSubmodel, (submodel) => {
          const found = locate(submodel, path)!;
          const to = hasTo ? toIndex : found.index + offset;
          if (to < 0 || to >= found.list.length)
            throw new ApiError(
              400,
              'BadRequest',
              hasTo ? `자리는 0~${found.list.length - 1} 사이여야 합니다.` : offset < 0 ? '이미 맨 위입니다.' : '이미 맨 아래입니다.',
            );
          if (to === found.index) return;
          const [node] = found.list.splice(found.index, 1);
          found.list.splice(to, 0, node!);
        });
      },
    },
    {
      /**
       * POST 요소 복제(규격 밖) — 같은 자리 바로 아래에 사본. 이름은 `X_2`(빈 번호부터).
       * HandoverDocumentation의 문서 항목·Markings처럼 **같은 구조를 여러 벌** 채울 때
       * 처음부터 다시 만드는 일을 없앤다. 리스트 자식(`[n]`)은 idShort가 없으니 그대로 복제.
       * 응답 201에 만든 요소 — 화면이 그 idShort로 자리를 잡는다.
       */
      method: 'POST',
      pattern: `${elements}/:path/duplicate`,
      success: [201],
      async handle(ctx) {
        const path = ctx.params['path']!;
        let copy: SubmodelElement | undefined;
        return editSubmodel(
          store,
          ctx,
          resolveSubmodel,
          (submodel) => {
            const found = locate(submodel, path)!;
            copy = JSON.parse(JSON.stringify(found.node)) as SubmodelElement;
            const record = copy as unknown as Record<string, unknown>;
            const base = record['idShort'];
            if (typeof base === 'string' && base !== '') {
              const taken = new Set(
                found.list.map((e) => (e as unknown as Record<string, unknown>)['idShort']),
              );
              let n = 2;
              while (taken.has(`${base}_${n}`)) n += 1;
              record['idShort'] = `${base}_${n}`;
            }
            found.list.splice(found.index + 1, 0, copy);
          },
          (revision) => withEtag(json(201, copy), revision),
        );
      },
    },
    {
      /**
       * GET 첨부 — File 요소가 가리키는 **실제 파일**.
       * HandoverDocumentation의 매뉴얼 PDF가 여기로 오간다(기획서 Ⅷ 대용량 파일).
       */
      method: 'GET',
      pattern: `${elements}/:path/attachment`,
      success: [200],
      async handle(ctx) {
        const packageId = ctx.params['packageId']!;
        const submodel = await readSubmodel(store, ctx, resolveSubmodel);
        const found = locate(submodel, ctx.params['path']!)!;
        const part = attachmentPartOf(found.node);
        if (!part) throw new ApiError(404, 'NotFound', '첨부 경로가 없습니다.');

        const file = (await store.packageFiles(packageId)).find((f) => f.part === part);
        if (!file) throw new ApiError(404, 'NotFound', `첨부 파트가 패키지에 없습니다: ${part}`);
        return bytes(200, file.data, file.contentType || 'application/octet-stream');
      },
    },
    {
      /** PUT 첨부 — 파일과 모델(File.value)을 함께 갱신한다 */
      method: 'PUT',
      pattern: `${elements}/:path/attachment`,
      success: [204],
      async handle(ctx) {
        const packageId = ctx.params['packageId']!;
        const upload = uploadedFile(ctx.request);
        const path = ctx.params['path']!;
        const part = `/aasx/suppl/${upload.name.replace(/^\/+/, '')}`;

        await store.putPackageFile(packageId, {
          part,
          role: 'supplementary',
          contentType: upload.contentType,
          data: upload.data,
        });

        return editSubmodel(store, ctx, resolveSubmodel, (submodel) => {
          const found = locate(submodel, path)!;
          if (found.node.modelType !== 'File' && found.node.modelType !== 'Blob') {
            throw new ApiError(400, 'BadRequest', '첨부는 File·Blob 요소에만 붙습니다.');
          }
          const target = found.node as unknown as Record<string, unknown>;
          // File.value는 URI여야 한다(PKG-FILE-URI). 상대경로로 두면 스키마 위반이다
          target['value'] = `file://${part}`;
          target['contentType'] = upload.contentType;
        });
      },
    },
    {
      /** DELETE 첨부 — 규격상 200 */
      method: 'DELETE',
      pattern: `${elements}/:path/attachment`,
      success: [200],
      async handle(ctx) {
        const packageId = ctx.params['packageId']!;
        const submodel = await readSubmodel(store, ctx, resolveSubmodel);
        const found = locate(submodel, ctx.params['path']!)!;
        const part = attachmentPartOf(found.node);
        if (!part) throw new ApiError(404, 'NotFound', '첨부 경로가 없습니다.');
        await store.deletePackageFile(packageId, part).catch(() => undefined);

        const path = ctx.params['path']!;
        return editSubmodel(
          store,
          ctx,
          resolveSubmodel,
          (submodel2) => {
            const target = locate(submodel2, path)!.node as unknown as Record<string, unknown>;
            delete target['value'];
          },
          (revision) => withEtag(json(200, { deleted: part }), revision),
        );
      },
    },
    {
      method: 'GET',
      pattern: `${elements}/:path/$value`,
      success: [200],
      async handle(ctx) {
        const submodel = await readSubmodel(store, ctx, resolveSubmodel);
        return json(200, toValueOnly(locate(submodel, ctx.params['path']!)!.node));
      },
    },
    {
      method: 'PATCH',
      pattern: `${elements}/:path/$value`,
      success: [204],
      async handle(ctx) {
        const path = ctx.params['path']!;
        // 스칼라 본문도 받고 {"value": ...} 봉투도 받는다 — 클라이언트마다 관례가 갈린다
        const raw = ctx.request.body;
        const value =
          typeof raw === 'object' && raw !== null && !Array.isArray(raw) && 'value' in raw
            ? (raw as { value: unknown }).value
            : raw;
        return editSubmodel(store, ctx, resolveSubmodel, (submodel) => {
          applyValueOnly(locate(submodel, path)!.node, value);
        });
      },
    },
  ];
}

/**
 * `/shells/{aasId}/submodels/{smId}/...` — AAS를 거쳐 서브모델에 닿는 길.
 *
 * 평면 경로와 **같은 핸들러**를 쓰되 위치 결정자만 바꾼다. 규격이 두 갈래를 정의했다고
 * 구현을 두 벌 두면 언젠가 갈린다.
 */
function nestedSubmodelRoutes(store: AasStore): Route[] {
  const prefix = `${BASE}/shells/:identifier/submodels/:submodelIdentifier`;

  return [
    {
      method: 'GET',
      pattern: prefix,
      success: [200],
      async handle(ctx) {
        return json(200, await readSubmodel(store, ctx, nestedLocator));
      },
    },
    {
      method: 'PUT',
      pattern: prefix,
      success: [204],
      async handle(ctx) {
        const packageId = ctx.params['packageId']!;
        const id = await nestedLocator(store, ctx);
        const updated = await store.updateIdentifiable(
          packageId,
          'Submodel',
          id,
          bodyObject(ctx.request),
          writeOptionsOf(ctx.request),
        );
        return withEtag(noContent(), updated.revision);
      },
    },
    {
      method: 'PATCH',
      pattern: prefix,
      success: [204],
      async handle(ctx) {
        const packageId = ctx.params['packageId']!;
        const id = await nestedLocator(store, ctx);
        const current = await store.getIdentifiable(packageId, 'Submodel', id);
        if (!current) throw new ApiError(404, 'NotFound', 'Submodel을 찾을 수 없습니다.');
        const updated = await store.updateIdentifiable(
          packageId,
          'Submodel',
          id,
          { ...current.content, ...bodyObject(ctx.request), modelType: 'Submodel', id },
          writeOptionsOf(ctx.request),
        );
        return withEtag(noContent(), updated.revision);
      },
    },
    {
      method: 'DELETE',
      pattern: prefix,
      success: [204],
      async handle(ctx) {
        const packageId = ctx.params['packageId']!;
        const id = await nestedLocator(store, ctx);
        await store.deleteIdentifiable(packageId, 'Submodel', id, writeOptionsOf(ctx.request));
        return noContent();
      },
    },
    ...submodelModifierRoutes(store, prefix, nestedLocator),
    ...submodelElementRoutes(store, prefix, nestedLocator),
  ];
}

export function part2Routes(store: AasStore): Route[] {
  return [
    descriptionRoute(`${BASE}/description`, PART2_PROFILES),
    serializationRoute(store),
    ...identifiableRoutes(store, 'shells', 'AssetAdministrationShell'),
    ...identifiableRoutes(store, 'submodels', 'Submodel'),
    ...identifiableRoutes(store, 'concept-descriptions', 'ConceptDescription'),
    // 평면 경로 — Submodel Repository
    ...submodelModifierRoutes(store, `${BASE}/submodels/:identifier`, flatLocator),
    ...submodelElementRoutes(store, `${BASE}/submodels/:identifier`, flatLocator),
    // 중첩 경로 — AAS Repository. 같은 서브모델을 AAS를 거쳐 가리킨다(규격 SSP-001)
    ...nestedSubmodelRoutes(store),
    {
      /** GET /shells/{id}/$reference */
      method: 'GET',
      pattern: `${BASE}/shells/:identifier/$reference`,
      success: [200],
      async handle(ctx) {
        const record = await requireShell(store, ctx);
        return json(200, referenceOf('AssetAdministrationShell', record.id));
      },
    },
    {
      /** GET /shells/$reference — 목록을 참조만으로 */
      method: 'GET',
      pattern: `${BASE}/shells/$reference`,
      success: [200],
      async handle({ request, params }) {
        const page = await store.listIdentifiables(
          params['packageId']!,
          'AssetAdministrationShell',
          pageOf(request),
        );
        return pagedResponse(
          page.items.map((r) => referenceOf('AssetAdministrationShell', r.id)),
          page.cursor,
        );
      },
    },
    {
      /** GET /submodels/$reference */
      method: 'GET',
      pattern: `${BASE}/submodels/$reference`,
      success: [200],
      async handle({ request, params }) {
        const page = await store.listIdentifiables(params['packageId']!, 'Submodel', pageOf(request));
        return pagedResponse(
          page.items.map((r) => referenceOf('Submodel', r.id)),
          page.cursor,
        );
      },
    },
    {
      /** GET /submodels/$metadata */
      method: 'GET',
      pattern: `${BASE}/submodels/$metadata`,
      success: [200],
      async handle({ request, params }) {
        const page = await store.listIdentifiables(params['packageId']!, 'Submodel', pageOf(request));
        return pagedResponse(
          page.items.map((r) => toMetadata(r.content)),
          page.cursor,
        );
      },
    },
    {
      /** GET /submodels/$value */
      method: 'GET',
      pattern: `${BASE}/submodels/$value`,
      success: [200],
      async handle({ request, params }) {
        const page = await store.listIdentifiables(params['packageId']!, 'Submodel', pageOf(request));
        return pagedResponse(
          page.items.map((r) => submodelValueOnly(r.content as unknown as Submodel)),
          page.cursor,
        );
      },
    },
    {
      /** GET /submodels/$path */
      method: 'GET',
      pattern: `${BASE}/submodels/$path`,
      success: [200],
      async handle({ request, params }) {
        const page = await store.listIdentifiables(params['packageId']!, 'Submodel', pageOf(request));
        return pagedResponse(
          page.items.map((r) => collectPaths(r.content as unknown as Submodel)),
          page.cursor,
        );
      },
    },
    {
      /** GET /shells/{aasId}/asset-information — assetKind·globalAssetId·썸네일 경로 */
      method: 'GET',
      pattern: `${BASE}/shells/:identifier/asset-information`,
      success: [200],
      async handle(ctx) {
        const record = await requireShell(store, ctx);
        const info = (record.content as { assetInformation?: unknown }).assetInformation ?? {};
        return withEtag(json(200, info), record.revision);
      },
    },
    {
      /**
       * PUT /shells/{aasId}/asset-information.
       * KOSMO-AAS-5·6(globalAssetId·assetKind=Type)이 이 자리를 가리킨다 —
       * 「고치기」 말고 사람이 직접 고칠 길도 있어야 한다.
       */
      method: 'PUT',
      pattern: `${BASE}/shells/:identifier/asset-information`,
      success: [204],
      async handle(ctx) {
        const packageId = ctx.params['packageId']!;
        const record = await requireShell(store, ctx);
        const content = JSON.parse(JSON.stringify(record.content)) as Record<string, unknown>;
        content['assetInformation'] = bodyObject(ctx.request);
        const updated = await store.updateIdentifiable(
          packageId,
          'AssetAdministrationShell',
          record.id,
          content,
          writeOptionsOf(ctx.request),
        );
        return withEtag(noContent(), updated.revision);
      },
    },
    {
      /** GET .../thumbnail — 패키지 안의 실제 파트를 준다(모델이 아니라 파일이다) */
      method: 'GET',
      pattern: `${BASE}/shells/:identifier/asset-information/thumbnail`,
      success: [200],
      async handle(ctx) {
        const packageId = ctx.params['packageId']!;
        const record = await requireShell(store, ctx);
        const thumbnail = await findThumbnail(store, packageId, record.content);
        if (!thumbnail) throw new ApiError(404, 'NotFound', '썸네일이 없습니다.');
        return bytes(200, thumbnail.data, thumbnail.contentType);
      },
    },
    {
      /**
       * PUT .../thumbnail — multipart(fileName·file).
       * 파일과 모델을 **함께** 갱신한다. 하나만 바꾸면 PKG-THUMB-PART가 걸린다
       * (파트·관계·Content_Types 세 곳이 맞아야 한다 — M2 writeAasx가 나머지를 맞춰 준다).
       */
      method: 'PUT',
      pattern: `${BASE}/shells/:identifier/asset-information/thumbnail`,
      success: [204],
      async handle(ctx) {
        const packageId = ctx.params['packageId']!;
        const record = await requireShell(store, ctx);
        const upload = uploadedFile(ctx.request);

        const part = upload.name.startsWith('/') ? upload.name : `/${upload.name}`;
        await store.putPackageFile(packageId, {
          part,
          role: 'thumbnail',
          contentType: upload.contentType,
          data: upload.data,
        });

        const content = JSON.parse(JSON.stringify(record.content)) as {
          assetInformation?: Record<string, unknown>;
        };
        const info = (content.assetInformation ??= {});
        // 이전 썸네일 파트가 다른 이름이었다면 지운다 — 남겨 두면 패키지에 고아 파트가 생긴다
        const previous = (info['defaultThumbnail'] as { path?: string } | undefined)?.path;
        if (previous && previous !== part) {
          await store.deletePackageFile(packageId, previous).catch(() => undefined);
        }
        info['defaultThumbnail'] = { path: part, contentType: upload.contentType };

        const updated = await store.updateIdentifiable(
          packageId,
          'AssetAdministrationShell',
          record.id,
          content as unknown as Record<string, unknown>,
          writeOptionsOf(ctx.request),
        );
        return withEtag(noContent(), updated.revision);
      },
    },
    {
      /** DELETE .../thumbnail — 규격상 200이다(204가 아니다) */
      method: 'DELETE',
      pattern: `${BASE}/shells/:identifier/asset-information/thumbnail`,
      success: [200],
      async handle(ctx) {
        const packageId = ctx.params['packageId']!;
        const record = await requireShell(store, ctx);
        const content = JSON.parse(JSON.stringify(record.content)) as {
          assetInformation?: Record<string, unknown>;
        };
        const path = (content.assetInformation?.['defaultThumbnail'] as { path?: string } | undefined)
          ?.path;
        if (!path) throw new ApiError(404, 'NotFound', '썸네일이 없습니다.');

        await store.deletePackageFile(packageId, path).catch(() => undefined);
        delete content.assetInformation?.['defaultThumbnail'];
        const updated = await store.updateIdentifiable(
          packageId,
          'AssetAdministrationShell',
          record.id,
          content as unknown as Record<string, unknown>,
          writeOptionsOf(ctx.request),
        );
        return withEtag(json(200, { deleted: path }), updated.revision);
      },
    },
    {
      method: 'POST',
      pattern: `${BASE}/shells/:identifier/submodel-refs`,
      success: [201],
      async handle(ctx) {
        const packageId = ctx.params['packageId']!;
        const aasId = decodeIdentifier(ctx.params['identifier']!);
        const record = await store.getIdentifiable(packageId, 'AssetAdministrationShell', aasId);
        if (!record) throw new ApiError(404, 'NotFound', 'AAS를 찾을 수 없습니다.');

        const reference = bodyObject(ctx.request);
        const content = JSON.parse(JSON.stringify(record.content)) as {
          submodels?: unknown[];
        };
        (content.submodels ??= []).push(reference);
        const updated = await store.updateIdentifiable(
          packageId,
          'AssetAdministrationShell',
          aasId,
          content as unknown as Record<string, unknown>,
          writeOptionsOf(ctx.request),
        );
        return withEtag(json(201, reference), updated.revision);
      },
    },
    {
      method: 'DELETE',
      pattern: `${BASE}/shells/:identifier/submodel-refs/:submodelIdentifier`,
      success: [204],
      async handle(ctx) {
        const packageId = ctx.params['packageId']!;
        const aasId = decodeIdentifier(ctx.params['identifier']!);
        const submodelId = decodeIdentifier(ctx.params['submodelIdentifier']!);
        const record = await store.getIdentifiable(packageId, 'AssetAdministrationShell', aasId);
        if (!record) throw new ApiError(404, 'NotFound', 'AAS를 찾을 수 없습니다.');

        const content = JSON.parse(JSON.stringify(record.content)) as {
          submodels?: { keys?: { value: string }[] }[];
        };
        const before = content.submodels?.length ?? 0;
        content.submodels = (content.submodels ?? []).filter(
          (ref) => ref.keys?.[0]?.value !== submodelId,
        );
        if (content.submodels.length === before) {
          throw new ApiError(404, 'NotFound', '그 Submodel 참조가 없습니다.');
        }
        const updated = await store.updateIdentifiable(
          packageId,
          'AssetAdministrationShell',
          aasId,
          content as unknown as Record<string, unknown>,
          writeOptionsOf(ctx.request),
        );
        return withEtag(noContent(), updated.revision);
      },
    },
    {
      method: 'GET',
      pattern: `${BASE}/shells/:identifier/submodel-refs`,
      success: [200],
      async handle(ctx) {
        const record = await store.getIdentifiable(
          ctx.params['packageId']!,
          'AssetAdministrationShell',
          decodeIdentifier(ctx.params['identifier']!),
        );
        if (!record) throw new ApiError(404, 'NotFound', 'AAS를 찾을 수 없습니다.');
        const refs = (record.content as { submodels?: unknown[] }).submodels ?? [];
        return pagedResponse(refs);
      },
    },
  ];
}

/**
 * 우리가 **온전히 만족한다고 주장하는** 프로필.
 *
 * 규격은 `/description`에 최소 하나의 프로필을 싣도록 정한다. 다 만들지 않은 프로필을 여기 적으면
 * 클라이언트가 있는 줄 알고 부르다 깨진다 — 그래서 `scripts/part2-coverage.mjs`가
 * 여기 적힌 프로필의 모든 연산이 실제로 열려 있는지 매번 확인한다.
 */
export const PART2_PROFILES = [
  'https://admin-shell.io/aas/API/3/0/ConceptDescriptionServiceSpecification/SSP-001',
] as const;

export const AASX_FILE_SERVER_PROFILES = [
  'https://admin-shell.io/aas/API/3/0/AasxFileServerServiceSpecification/SSP-001',
] as const;

/** GET /description — 서버가 무엇을 구현했는지 클라이언트에게 알린다 */
export function descriptionRoute(pattern: string, profiles: readonly string[]): Route {
  return {
    method: 'GET',
    pattern,
    success: [200],
    handle: async () => json(200, { profiles: [...profiles] }),
  };
}

/**
 * GET /serialization — 고른 것만 담아 내보낸다.
 * Accept에 따라 AASX(패키지)와 Environment JSON을 가른다.
 */
export function serializationRoute(store: AasStore): Route {
  return {
    method: 'GET',
    pattern: `${BASE}/serialization`,
    success: [200],
    async handle({ request, params }) {
      const packageId = params['packageId']!;
      const multi = (name: string): string[] => {
        const all = request.queryAll?.[name];
        if (all) return all.map(decodeIdentifier);
        const single = request.query[name];
        return single === undefined ? [] : [decodeIdentifier(single)];
      };

      const aasIds = multi('aasIds');
      const submodelIds = multi('submodelIds');
      const includeCds = request.query['includeConceptDescriptions'] !== 'false';

      const full = await store.getEnvironment(packageId);
      const environment: Environment = {
        assetAdministrationShells:
          aasIds.length === 0
            ? (full.assetAdministrationShells ?? [])
            : (full.assetAdministrationShells ?? []).filter((s) => aasIds.includes(s.id)),
        submodels:
          submodelIds.length === 0
            ? (full.submodels ?? [])
            : (full.submodels ?? []).filter((s) => submodelIds.includes(s.id)),
        ...(includeCds ? { conceptDescriptions: full.conceptDescriptions ?? [] } : {}),
      };

      const accept = request.headers['accept'] ?? '';
      if (accept.includes('asset-administration-shell-package')) {
        const pkg = await store.exportPackage(packageId);
        return bytes(200, writeAasx({ ...pkg, environment }), AASX_MEDIA_TYPE);
      }
      return json(200, environment);
    },
  };
}
