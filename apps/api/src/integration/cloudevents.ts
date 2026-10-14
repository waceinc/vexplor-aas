/**
 * Renders a stored event as a CloudEvents 1.0 structured JSON envelope (docs/design/integration-v1.md §2.1).
 *
 * Important: the output depends **only** on the stored row and `ctx`. A replay a week later must be byte-identical to
 *    the first delivery (apart from the signature headers), or receivers deduplicating on content see a new event.
 *    So: no clock, no lookups, no current package state in here.
 */
import { EVENT_TYPES, type CloudEvent } from '@aas/core';
import type { StoredEvent } from '@aas/store';

import { encodeIdentifier } from '../base64url.js';

export const CLOUDEVENTS_CONTENT_TYPE = 'application/cloudevents+json; charset=utf-8';

export interface RenderContext {
  instanceId: string;
  /** `AAS_PUBLIC_URL` — when set, `dataschema` and links are absolute */
  publicBaseUrl?: string;
}

const COLLECTION_OF: Record<string, string> = {
  AssetAdministrationShell: 'shells',
  Submodel: 'submodels',
  ConceptDescription: 'concept-descriptions',
};

const PACKAGE_EVENT_TYPES = new Set<string>([
  EVENT_TYPES.modelPackageCreated,
  EVENT_TYPES.modelPackageDeleted,
  EVENT_TYPES.modelPackageFileChanged,
  // The sidecar external references belong to the package, not to one identifiable
  EVENT_TYPES.modelExternalRefsUpdated,
]);

function isIdentifiableEvent(row: StoredEvent): boolean {
  return row.type.startsWith('kr.vexplor.aas.model.') && !PACKAGE_EVENT_TYPES.has(row.type);
}

function trimBase(base: string | undefined): string {
  return base === undefined ? '' : base.replace(/\/+$/, '');
}

/** Store sequence as the CloudEvents sequence extension: a string, zero-padded to 20 digits so it also sorts as text */
export function sequenceText(seq: number): string {
  return String(seq).padStart(20, '0');
}

/** `packages/<pkg>/<shells|submodels|concept-descriptions>/<b64url id>` of an identifiable model event, or undefined */
function identifiablePath(row: StoredEvent): string | undefined {
  const packageId = (row.data['packageId'] as string | undefined) ?? row.packageId;
  const collection = COLLECTION_OF[String(row.data['modelType'])];
  const id = row.data['id'];
  if (packageId === undefined || collection === undefined || typeof id !== 'string') return undefined;
  return `packages/${packageId}/${collection}/${encodeIdentifier(id)}`;
}

function subjectOf(row: StoredEvent): string | undefined {
  if (isIdentifiableEvent(row)) return identifiablePath(row) ?? row.subject;
  if (PACKAGE_EVENT_TYPES.has(row.type)) {
    const packageId = row.packageId ?? (row.data['packageId'] as string | undefined);
    return packageId === undefined ? row.subject : `packages/${packageId}`;
  }
  return row.subject;
}

function dataOf(row: StoredEvent, ctx: RenderContext): Record<string, unknown> {
  if (!isIdentifiableEvent(row)) return row.data;
  const path = identifiablePath(row);
  if (path === undefined) return row.data;
  const [, packageId, collection, id] = path.split('/') as [string, string, string, string];
  const self = `${trimBase(ctx.publicBaseUrl)}/packages/${packageId}/api/v3.0/${collection}/${id}`;
  return { ...row.data, links: { self } };
}

export function toCloudEvent(row: StoredEvent, ctx: RenderContext): CloudEvent {
  const subject = subjectOf(row);
  const event: CloudEvent = {
    specversion: '1.0',
    id: row.id,
    source: `urn:vexplor-aas:${ctx.instanceId}`,
    type: row.type,
    time: row.time,
    ...(subject === undefined ? {} : { subject }),
    datacontenttype: 'application/json',
    ...(ctx.publicBaseUrl ? { dataschema: `${trimBase(ctx.publicBaseUrl)}/integrations/schemas/${row.type}` } : {}),
    sequence: sequenceText(row.seq),
    ...(row.packageId === undefined ? {} : { vxpackageid: row.packageId }),
    ...(row.packageRevision === undefined ? {} : { vxrevision: row.packageRevision }),
    ...(row.cause === undefined ? {} : { vxcause: row.cause }),
    ...(row.changeSetId === undefined ? {} : { vxchangeset: row.changeSetId }),
    data: dataOf(row, ctx),
  };
  return event;
}

/** The exact bytes that are signed and sent */
export function cloudEventBody(event: CloudEvent): Buffer {
  return Buffer.from(JSON.stringify(event), 'utf8');
}
