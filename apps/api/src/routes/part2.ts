/**
 * REST API conforming to IDTA Part 2 (IDTA-01002-3-0).
 *
 * The base path is `/packages/{packageId}/api/v3.0`.
 * The spec assumes a single repository, but we work per AASX file, so the package is placed in front and
 * **everything below it follows the spec as-is**. Part 2 clients (BaSyx etc.) only need to point their base URL at this address.
 *
 * Implementation scope (MVP)
 *  [done] /shells, /submodels, /concept-descriptions CRUD + pagination (limit, cursor)
 *  [done] /submodels/{id}/submodel-elements/{idShortPath} CRUD, $value read and update
 *  [done] base64url identifier encoding, Result/Message error bodies
 *  [not yet] $metadata, level, extent modifiers, /lookup (asset search), descriptors (Part 2 Registry)
 *     — to be added when the authoring UI (M3) needs them
 *
 * Status codes follow the spec — POST is 201 + body, PUT/PATCH/DELETE are 204 (no body).
 * The authoring UI needs the new revision to continue optimistic locking, so **ETag is attached even to 204**.
 * Important: we have not yet obtained the IDTA-01002-3-0 original text (docs/PROGRESS.md §7). Once it arrives,
 * cross-check status codes and error bodies once.
 */
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
import { METAMODEL_HEADER } from '../metamodel-hint.js';
import { outgoingChoiceOf, writeOutgoing } from '../outgoing.js';
import { fieldValues, fileOf, parseMultipart } from '../multipart.js';
import type { Route, RouteContext } from '../router.js';
import { rasterTypeOf, userFileResponse } from '../user-file.js';
import { fill, tr } from '@aas/core';

const BASE = '/packages/:packageId/api/v3.0';

/**
 * Reads the spec's query parameters — limit, cursor, idShort, semanticId, assetKind.
 * Per the spec, semanticId arrives base64url-encoded.
 * (level, extent, assetIds and assetType are not supported yet — noted in PROGRESS §4)
 */
function pageOf(request: ApiRequest): ListQuery {
  const page: ListQuery = {};
  const limit = request.query['limit'];
  if (limit !== undefined) {
    const parsed = Number(limit);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      throw new ApiError(400, 'BadRequest', fill(tr('limit이 양의 정수가 아닙니다: {0}'), { 0: limit }));
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
 * Uses the If-Match header for optimistic locking.
 * Part 2 doesn't define it, but following HTTP convention as-is feels natural to clients.
 * The value is the revision number (paired with the response's ETag).
 */
function writeOptionsOf(request: ApiRequest): WriteOptions {
  const ifMatch = request.headers['if-match'];
  if (!ifMatch || ifMatch === '*') return {};
  const revision = Number(ifMatch.replace(/"/g, ''));
  if (!Number.isInteger(revision)) {
    throw new ApiError(400, 'BadRequest', fill(tr('If-Match가 리비전 숫자가 아닙니다: {0}'), { 0: ifMatch }));
  }
  return { expectedRevision: revision };
}

function bodyObject(request: ApiRequest): Record<string, unknown> {
  const body = request.body;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new ApiError(400, 'BadRequest', tr('본문이 JSON 객체가 아닙니다.'));
  }
  return body as Record<string, unknown>;
}

function withEtag(response: ApiResponse, revision: number): ApiResponse {
  return { ...response, headers: { ...response.headers, etag: `"${revision}"` } };
}

/**
 * CRUD set common to the three Identifiables.
 *
 * Important: PATCH exists **only for Submodel**. The spec does not define PATCH on `/shells/{id}` or
 * `/concept-descriptions/{id}` — opening everything just because the code is shared would put non-standard methods on standard paths.
 * (It was actually opened that way once and the cross-check script caught it)
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
            fill(tr('이 경로에는 {0}만 만들 수 있습니다: {1}'), { 0: modelType, 1: String(content['modelType']) }),
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
        if (!record) throw new ApiError(404, 'NotFound', fill(tr('{0}을(를) 찾을 수 없습니다.'), { 0: modelType }));
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
       * PATCH — partial update. Overwrites only the fields present in the body.
       * PUT replaces wholesale, wiping values too. A separate path is needed for changing just one property.
       */
      method: 'PATCH',
      pattern: item,
      success: [204],
      async handle(ctx) {
        const packageId = ctx.params['packageId']!;
        const id = idOf(ctx);
        const current = await store.getIdentifiable(packageId, modelType, id);
        if (!current) throw new ApiError(404, 'NotFound', fill(tr('{0}을(를) 찾을 수 없습니다.'), { 0: modelType }));
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
 * Determines the target Submodel's id from the path.
 *
 * The spec points to the same submodel in two ways —
 *   flat:   `/submodels/{smId}`            (Submodel Repository)
 *   nested: `/shells/{aasId}/submodels/{smId}` (AAS Repository)
 * The latter must check **whether that AAS actually references the submodel**. Otherwise it would expose someone else's.
 */
export type SubmodelLocator = (store: AasStore, ctx: RouteContext) => Promise<string>;

const flatLocator: SubmodelLocator = async (_store, ctx) =>
  decodeIdentifier(ctx.params['identifier']!);

const nestedLocator: SubmodelLocator = async (store, ctx) => {
  const packageId = ctx.params['packageId']!;
  const aasId = decodeIdentifier(ctx.params['identifier']!);
  const submodelId = decodeIdentifier(ctx.params['submodelIdentifier']!);

  const shell = await store.getIdentifiable(packageId, 'AssetAdministrationShell', aasId);
  if (!shell) throw new ApiError(404, 'NotFound', tr('AAS를 찾을 수 없습니다.'));

  const referenced = ((shell.content as { submodels?: { keys?: { value?: string }[] }[] }).submodels ?? [])
    .flatMap((reference) => reference.keys ?? [])
    .some((key) => key.value === submodelId);
  if (!referenced) {
    throw new ApiError(404, 'NotFound', tr('이 AAS가 참조하지 않는 Submodel입니다.'));
  }
  return submodelId;
};

/** Fetch the AAS the path points to. 404 if absent */
async function requireShell(store: AasStore, ctx: RouteContext) {
  const record = await store.getIdentifiable(
    ctx.params['packageId']!,
    'AssetAdministrationShell',
    decodeIdentifier(ctx.params['identifier']!),
  );
  if (!record) throw new ApiError(404, 'NotFound', tr('AAS를 찾을 수 없습니다.'));
  return record;
}

/** Find the thumbnail part the model points to in the package */
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

/** Package part name a File/Blob element points to (`file:///x` -> `/x`) */
function attachmentPartOf(node: SubmodelElement): string | undefined {
  const raw = (node as unknown as Record<string, unknown>)['value'];
  const value = typeof raw === 'string' ? raw : undefined;
  if (!value) return undefined;
  const withoutScheme = value.replace(/^file:\/\//i, '');
  return withoutScheme.startsWith('/') ? withoutScheme : `/${withoutScheme}`;
}

/** Reads a multipart (fileName, file) or raw-bytes upload */
function uploadedFile(request: ApiRequest): { name: string; contentType: string; data: Uint8Array } {
  const contentType = request.headers['content-type'] ?? '';
  const body = request.body;

  if (contentType.includes('multipart/form-data')) {
    if (!(body instanceof Uint8Array)) {
      throw new ApiError(400, 'BadRequest', tr('multipart 본문을 읽지 못했습니다.'));
    }
    let parts;
    try {
      parts = parseMultipart(body, contentType);
    } catch (error) {
      throw new ApiError(400, 'BadRequest', error instanceof Error ? error.message : String(error));
    }
    const file = fileOf(parts, 'file');
    if (!file) throw new ApiError(400, 'BadRequest', tr('file 조각이 없습니다.'));
    const name = fieldValues(parts, 'fileName')[0] ?? file.filename ?? 'thumbnail.png';
    return { name, contentType: file.contentType ?? guessImageType(name), data: file.data };
  }

  if (!(body instanceof Uint8Array)) {
    throw new ApiError(400, 'BadRequest', tr('본문이 파일 바이트가 아닙니다.'));
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

/** Common flow for fetching one Submodel, editing it, and writing it back */
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
  if (!record) throw new ApiError(404, 'NotFound', tr('Submodel을 찾을 수 없습니다.'));

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
 * Submodel for reading.
 *
 * Important: with `?live=true`, **the latest collected values are overlaid on the response only** (same appearance as BaSyx DataBridge).
 *    The file is not touched — exactly value sync option A. It is off by default,
 *    so file values and field values never get mixed without any indication.
 * Important: **never used on the write path (editSubmodel).** Saving is always based on file values —
 *    saving overlaid values would break option A at that moment.
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
  if (!record) throw new ApiError(404, 'NotFound', tr('Submodel을 찾을 수 없습니다.'));
  const submodel = record.content as unknown as Submodel;

  if (ctx.request.query['live'] !== 'true') return submodel;
  const samples = await store.readValues(packageId, { limit: 500 });
  if (samples.length === 0) return submodel;
  return overlaySubmodel(submodel, samples).content;
}

/**
 * Two things that must hold when renaming (idShort). Blocked **at save time**.
 *
 * 1. Siblings must not share a name (AASd-022). The linter catches it too, but by then it's too late —
 *    with two identical names, what `idShortPath` points to becomes ambiguous and **the wrong element gets silently modified.**
 * 2. Direct children of a SubmodelElementList must not have an idShort (AASd-120).
 *    List children are addressed by position. If named, basyx loses that whole branch.
 */
function guardIdShort(
  path: string,
  found: { list: SubmodelElement[]; index: number; node: SubmodelElement },
  next: SubmodelElement,
): void {
  const nextName = (next as unknown as Record<string, unknown>)['idShort'];
  const currentName = (found.node as unknown as Record<string, unknown>)['idShort'];
  if (nextName === currentName) return; // Nothing to check if the name isn't changing

  // If the last segment ends with `[n]`, it is a list child — addressed by position
  const lastSegment = path.split('.').at(-1) ?? '';
  if (/\]$/.test(lastSegment)) {
    if (typeof nextName === 'string' && nextName !== '') {
      throw new ApiError(
        400,
        'BadRequest',
        tr('SubmodelElementList의 자식에는 idShort를 붙일 수 없습니다(AASd-120). 리스트 자식은 순서로 가리킵니다.'),
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
      fill(tr('같은 자리에 이미 「{0}」이(가) 있습니다. 형제끼리 이름이 겹치면 안 됩니다(AASd-022).'), { 0: nextName }),
    );
  }
}

function locate(submodel: Submodel, path: string): ReturnType<typeof resolveIdShortPath> {
  const found = resolveIdShortPath(submodel, path);
  if (!found) throw new ApiError(404, 'NotFound', fill(tr('요소를 찾을 수 없습니다: {0}'), { 0: path }));
  return found;
}

/**
 * Serialization modifiers — `$value`, `$metadata`, `$reference`, `$path`.
 *
 * These are paths standard clients (BaSyx etc.) actually use. Exchanging whole JSON means the entire submodel
 * travels even when only values are needed — one piece of equipment has 175 elements.
 *  $value    values only (ValueOnly)
 *  $metadata everything except values — for viewing structure and semantics only
 *  $reference a ModelReference pointing to that resource
 *  $path     list of idShortPaths — for scanning positions without fetching the tree
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
          // Takes child idShorts as keys and swaps only values. Unknown names are reported, not ignored
          for (const [idShort, value] of Object.entries(body)) {
            const found = resolveIdShortPath(submodel, idShort);
            if (!found) throw new ApiError(404, 'NotFound', fill(tr('요소를 찾을 수 없습니다: {0}'), { 0: idShort }));
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
        locate(submodel, ctx.params['path']!); // 404 if absent
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
              throw new ApiError(404, 'NotFound', fill(tr('부모 요소를 찾을 수 없습니다: {0}'), { 0: path }));
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
      /** PATCH element — partial update (PUT replaces wholesale) */
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
       * POST move element (non-spec) — one position up/down among siblings.
       * Part 2 has no operation to reorder (PUT only replaces wholesale). But AAS element order is
       * **document order** — guidance tables and the Package Explorer UI show things in that order. To avoid making people delete
       * and recreate a wrongly ordered element, this one operation is needed (2026-09-04 expert review).
       * body `{ offset: -1 | 1 }` (one position) or `{ to: n }` (to the n-th position among siblings — drag and drop in the tree).
       * 400 if moving past the end or out of range.
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
          throw new ApiError(400, 'BadRequest', tr('offset은 -1(위)·1(아래), to는 0 이상의 정수여야 합니다.'));
        const path = ctx.params['path']!;
        return editSubmodel(store, ctx, resolveSubmodel, (submodel) => {
          const found = locate(submodel, path)!;
          const to = hasTo ? toIndex : found.index + offset;
          if (to < 0 || to >= found.list.length)
            throw new ApiError(
              400,
              'BadRequest',
              hasTo ? fill(tr('자리는 0~{0} 사이여야 합니다.'), { 0: found.list.length - 1 }) : offset < 0 ? tr('이미 맨 위입니다.') : tr('이미 맨 아래입니다.'),
            );
          if (to === found.index) return;
          const [node] = found.list.splice(found.index, 1);
          found.list.splice(to, 0, node!);
        });
      },
    },
    {
      /**
       * POST duplicate element (non-spec) — a copy placed right below. Named `X_2` (from the first free number).
       * Removes rebuilding from scratch when filling **multiple copies of the same structure**, like HandoverDocumentation
       * document entries or Markings. List children (`[n]`) have no idShort, so they are duplicated as-is.
       * Response 201 with the created element — the UI positions itself by that idShort.
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
       * GET attachment — the **actual file** a File element points to.
       * HandoverDocumentation manual PDFs travel through here (spec VIII large files).
       */
      method: 'GET',
      pattern: `${elements}/:path/attachment`,
      success: [200],
      fileDownload: true,
      async handle(ctx) {
        const packageId = ctx.params['packageId']!;
        const submodel = await readSubmodel(store, ctx, resolveSubmodel);
        const found = locate(submodel, ctx.params['path']!)!;
        const part = attachmentPartOf(found.node);
        if (!part) throw new ApiError(404, 'NotFound', tr('첨부 경로가 없습니다.'));

        const file = (await store.packageFiles(packageId)).find((f) => f.part === part);
        if (!file) throw new ApiError(404, 'NotFound', fill(tr('첨부 파트가 패키지에 없습니다: {0}'), { 0: part }));
        // Important: never echo the stored type — the uploader chose it (user-file.ts)
        return userFileResponse(file.data, part.split('/').pop());
      },
    },
    {
      /** PUT attachment — updates the file and the model (File.value) together */
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
            throw new ApiError(400, 'BadRequest', tr('첨부는 File·Blob 요소에만 붙습니다.'));
          }
          const target = found.node as unknown as Record<string, unknown>;
          // File.value must be a URI (PKG-FILE-URI). Leaving it as a relative path violates the schema
          target['value'] = `file://${part}`;
          target['contentType'] = upload.contentType;
        });
      },
    },
    {
      /** DELETE attachment — 200 per the spec */
      method: 'DELETE',
      pattern: `${elements}/:path/attachment`,
      success: [200],
      async handle(ctx) {
        const packageId = ctx.params['packageId']!;
        const submodel = await readSubmodel(store, ctx, resolveSubmodel);
        const found = locate(submodel, ctx.params['path']!)!;
        const part = attachmentPartOf(found.node);
        if (!part) throw new ApiError(404, 'NotFound', tr('첨부 경로가 없습니다.'));
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
        // Accepts both a scalar body and a {"value": ...} envelope — conventions differ between clients
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
 * `/shells/{aasId}/submodels/{smId}/...` — the path reaching a submodel via an AAS.
 *
 * Uses **the same handlers** as the flat path, swapping only the locator. Keeping two implementations
 * just because the spec defines two paths means they will diverge someday.
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
        if (!current) throw new ApiError(404, 'NotFound', tr('Submodel을 찾을 수 없습니다.'));
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
    // Flat path — Submodel Repository
    ...submodelModifierRoutes(store, `${BASE}/submodels/:identifier`, flatLocator),
    ...submodelElementRoutes(store, `${BASE}/submodels/:identifier`, flatLocator),
    // Nested path — AAS Repository. Points to the same submodel via the AAS (spec SSP-001)
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
      /** GET /shells/$reference — list as references only */
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
      /** GET /shells/{aasId}/asset-information — assetKind, globalAssetId, thumbnail path */
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
       * KOSMO-AAS-5/6 (globalAssetId, assetKind=Type) point to this place —
       * besides the "Fix" action, there must also be a way for people to edit it directly.
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
      /** GET .../thumbnail — returns the actual part in the package (it is a file, not the model) */
      method: 'GET',
      pattern: `${BASE}/shells/:identifier/asset-information/thumbnail`,
      success: [200],
      async handle(ctx) {
        const packageId = ctx.params['packageId']!;
        const record = await requireShell(store, ctx);
        const thumbnail = await findThumbnail(store, packageId, record.content);
        if (!thumbnail) throw new ApiError(404, 'NotFound', tr('썸네일이 없습니다.'));
        // Important: never echo the stored type — the uploader chose it (user-file.ts)
        return userFileResponse(thumbnail.data);
      },
    },
    {
      /**
       * PUT .../thumbnail — multipart(fileName·file).
       * Updates the file and the model **together**. Changing only one triggers PKG-THUMB-PART
       * (the part, relationship and Content_Types must all match — M2 writeAasx aligns the rest).
       */
      method: 'PUT',
      pattern: `${BASE}/shells/:identifier/asset-information/thumbnail`,
      success: [204],
      async handle(ctx) {
        const packageId = ctx.params['packageId']!;
        const record = await requireShell(store, ctx);
        const upload = uploadedFile(ctx.request);
        // Important: a thumbnail is a picture — only raster images whose bytes prove it. SVG, HTML and scripts are refused
        //    here, before anything is stored, so a hostile "thumbnail" never exists in the package (red-team H1)
        const raster = rasterTypeOf(upload.data);
        if (!raster) {
          throw new ApiError(400, 'BadRequest', tr('썸네일은 PNG · JPEG · GIF · WebP 그림 파일만 올릴 수 있습니다.'));
        }

        const part = upload.name.startsWith('/') ? upload.name : `/${upload.name}`;
        await store.putPackageFile(packageId, {
          part,
          role: 'thumbnail',
          contentType: raster,
          data: upload.data,
        });

        const content = JSON.parse(JSON.stringify(record.content)) as {
          assetInformation?: Record<string, unknown>;
        };
        const info = (content.assetInformation ??= {});
        // If the previous thumbnail part had a different name, delete it — leaving it creates an orphan part in the package
        const previous = (info['defaultThumbnail'] as { path?: string } | undefined)?.path;
        if (previous && previous !== part) {
          await store.deletePackageFile(packageId, previous).catch(() => undefined);
        }
        info['defaultThumbnail'] = { path: part, contentType: raster };

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
      /** DELETE .../thumbnail — 200 per the spec (not 204) */
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
        if (!path) throw new ApiError(404, 'NotFound', tr('썸네일이 없습니다.'));

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
        if (!record) throw new ApiError(404, 'NotFound', tr('AAS를 찾을 수 없습니다.'));

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
        if (!record) throw new ApiError(404, 'NotFound', tr('AAS를 찾을 수 없습니다.'));

        const content = JSON.parse(JSON.stringify(record.content)) as {
          submodels?: { keys?: { value: string }[] }[];
        };
        const before = content.submodels?.length ?? 0;
        content.submodels = (content.submodels ?? []).filter(
          (ref) => ref.keys?.[0]?.value !== submodelId,
        );
        if (content.submodels.length === before) {
          throw new ApiError(404, 'NotFound', tr('그 Submodel 참조가 없습니다.'));
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
        if (!record) throw new ApiError(404, 'NotFound', tr('AAS를 찾을 수 없습니다.'));
        const refs = (record.content as { submodels?: unknown[] }).submodels ?? [];
        return pagedResponse(refs);
      },
    },
  ];
}

/**
 * Profiles we **claim to fully satisfy**.
 *
 * The spec requires `/description` to list at least one profile. Listing an unfinished profile here would make
 * clients assume it exists and break when calling it — so `scripts/part2-coverage.mjs`
 * checks every time that all operations of the profiles listed here are actually open.
 */
export const PART2_PROFILES = [
  'https://admin-shell.io/aas/API/3/0/ConceptDescriptionServiceSpecification/SSP-001',
] as const;

export const AASX_FILE_SERVER_PROFILES = [
  'https://admin-shell.io/aas/API/3/0/AasxFileServerServiceSpecification/SSP-001',
] as const;

/** GET /description — tells clients what the server implements */
export function descriptionRoute(pattern: string, profiles: readonly string[]): Route {
  return {
    method: 'GET',
    pattern,
    success: [200],
    handle: async () => json(200, { profiles: [...profiles] }),
  };
}

/**
 * GET /serialization — exports only what was selected.
 * Chooses between AASX (package) and Environment JSON based on Accept.
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
        const record = await store.getPackage(packageId);
        if (!record) throw new ApiError(404, 'NotFound', tr('패키지를 찾을 수 없습니다.'));
        // Leaves the server — the version the file came in as, or `?metamodel=` (a non-spec extension, outgoing.ts)
        const file = writeOutgoing({ ...pkg, environment }, record, outgoingChoiceOf(request));
        const response = bytes(200, file.data, AASX_MEDIA_TYPE);
        response.headers[METAMODEL_HEADER] = file.version;
        return response;
      }
      return json(200, environment);
    },
  };
}
