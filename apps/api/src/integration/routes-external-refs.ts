/**
 * External reference routes (design §4.5). Read = any reader; PUT and import = edit level (the generic authorisation
 * in api.ts already refuses writes from viewers and read-only keys).
 *
 *   GET  /packages/:packageId/external-refs        sidecar doc + revision (ETag)
 *   PUT  /packages/:packageId/external-refs        replace (If-Match required) → projection of published refs
 *   POST /integrations/external-refs/import        CSV / JSON rows, `?dryRun=1` shows the diff without writing
 */
import { randomUUID } from 'node:crypto';
import { EVENT_TYPES, fill, tr, type IntegrationAuditData } from '@aas/core';
import { ConflictError, currentActor, ExternalRefConflictError, ForbiddenError, type AasStore, type IntegrationStore } from '@aas/store';
import { ApiError, errorResponse, json, type ApiRequest, type ApiResponse } from '../http.js';
import type { Route } from '../router.js';
import type { IntegrationRouteDeps } from './deps.js';
import { integrationStore, requirePackage } from './exports/store.js';
import { emptyExternalRefs, parseExternalRefsDoc, saveExternalRefs, saveExternalRefsBatch, type SaveResult } from './external-refs.js';
import { importRows, planImport } from './external-refs-import.js';

/** `If-Match: "3"` → 3. Missing → 428, unreadable → 400 (design §4.5) */
export function ifMatchRevision(request: ApiRequest): number {
  const raw = request.headers['if-match'];
  if (raw === undefined || raw.trim() === '') {
    throw new ApiError(428, 'PreconditionRequired', tr('If-Match 헤더에 리비전을 주십시오 (처음 저장은 "0").'));
  }
  const match = /^\s*(?:W\/)?"?(\d+)"?\s*$/.exec(raw);
  if (!match) throw new ApiError(400, 'BadRequest', fill(tr('If-Match 값을 읽지 못했습니다: {0}'), { 0: raw }));
  return Number(match[1]);
}

function conflictResponse(error: ExternalRefConflictError): ApiResponse {
  const body = errorResponse(409, 'ExternalRefConflict', error.message).body as Record<string, unknown>;
  return json(409, { ...body, code: 'ExternalRefConflict', claims: error.claims });
}

/** Maps the store's revision and uniqueness errors of a save */
async function guardedSave<T extends SaveResult | SaveResult[]>(run: () => Promise<T>): Promise<T | ApiResponse> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof ExternalRefConflictError) return conflictResponse(error);
    if (error instanceof ConflictError) return errorResponse(412, 'PreconditionFailed', error.message);
    throw error;
  }
}

function isResponse(value: SaveResult | SaveResult[] | ApiResponse): value is ApiResponse {
  return !Array.isArray(value) && 'status' in value && 'headers' in value;
}

async function afterChange(deps: IntegrationRouteDeps, packageIds: readonly string[]): Promise<void> {
  deps.runtime?.join?.invalidate();
  for (const packageId of packageIds) {
    // The projector re-reads the package; a failure there must not turn a saved change into an error response
    await deps.runtime?.flushProjection?.(packageId).catch(() => undefined);
  }
}

/** `integration.audit` row. A workspace user may not append to the server log (ScopedStore) — the audit is then skipped */
async function audit(writer: Pick<IntegrationStore, 'appendEvents'>, target: string, details: Record<string, unknown>): Promise<void> {
  const actor = currentActor();
  const data: IntegrationAuditData = {
    action: 'external-refs.imported',
    target,
    ...(actor ? { actor: { id: actor.id, name: actor.name } } : {}),
    details,
  };
  try {
    await writer.appendEvents([
      {
        id: randomUUID(),
        type: EVENT_TYPES.integrationAudit,
        time: new Date().toISOString(),
        ...(actor ? { actorId: actor.id, actorName: actor.name } : {}),
        data,
      },
    ]);
  } catch (error) {
    if (!(error instanceof ForbiddenError)) throw error;
  }
}

export function externalRefRoutes(store: AasStore, deps: IntegrationRouteDeps): Route[] {
  return [
    {
      method: 'GET',
      pattern: '/packages/:packageId/external-refs',
      async handle({ params }) {
        const packageId = params['packageId']!;
        await requirePackage(store, packageId);
        const stored = await integrationStore(store).getExternalRefs(packageId);
        const revision = stored?.revision ?? 0;
        const response = json(200, { value: stored?.value ?? emptyExternalRefs(), revision });
        response.headers['etag'] = `"${revision}"`;
        return response;
      },
    },
    {
      method: 'PUT',
      pattern: '/packages/:packageId/external-refs',
      async handle({ params, request }) {
        const packageId = params['packageId']!;
        await requirePackage(store, packageId);
        const expected = ifMatchRevision(request);
        const parsed = parseExternalRefsDoc(request.body);
        if (!parsed.ok) {
          const body = errorResponse(400, 'BadRequest', parsed.errors.map((e) => `${e.path}: ${e.message}`).join('; ')).body as Record<string, unknown>;
          return json(400, { ...body, errors: parsed.errors });
        }
        // afterChange runs inside the save once the doc is stored — also if the shell projection then fails
        const saved = await guardedSave(() => saveExternalRefs(store, packageId, parsed.value, expected, (written) => afterChange(deps, written)));
        if (isResponse(saved)) return saved;
        const response = json(200, saved);
        response.headers['etag'] = `"${saved.revision}"`;
        return response;
      },
    },
    {
      method: 'POST',
      pattern: '/integrations/external-refs/import',
      async handle({ request }) {
        const dryRun = request.query['dryRun'] === '1' || request.query['dryRun'] === 'true';
        const rows = importRows(request.body);
        const source = request.body instanceof Uint8Array || typeof request.body === 'string' ? 'import:csv' : 'import:json';
        const plan = await planImport(store, rows, new Date().toISOString(), source);
        const report = { changes: plan.changes, errors: plan.errors, conflicts: plan.conflicts };
        if (dryRun) return json(200, report);
        // Nothing is written while any row is wrong — a half-applied ERP file is harder to repair than a refused one
        if (plan.errors.length > 0 || plan.conflicts.length > 0) {
          return json(422, { ...report, code: 'ImportRejected', message: tr('오류나 충돌이 있는 행이 있어 아무것도 적용하지 않았습니다.') });
        }
        // One store batch: every package or none (a stale revision or a key taken meanwhile aborts the whole file)
        const items = [...plan.docs].map(([packageId, { doc, revision }]) => ({ packageId, doc, expectedRevision: revision }));
        const written = async (packageIds: string[]): Promise<void> => {
          await audit(deps.auditStore ?? integrationStore(store), packageIds.join(','), {
            packages: packageIds.length,
            added: plan.changes.reduce((sum, change) => sum + change.add.length, 0),
            replaced: plan.changes.reduce((sum, change) => sum + change.remove.length, 0),
            source,
          });
          await afterChange(deps, packageIds);
        };
        const saved = items.length === 0 ? [] : await guardedSave(() => saveExternalRefsBatch(store, items, written));
        if (isResponse(saved)) return saved;
        const revisions = Object.fromEntries(items.map((item, i) => [item.packageId, saved[i]!.revision]));
        return json(200, { ...report, revisions });
      },
    },
  ];
}
