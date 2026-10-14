/**
 * Model events — the rows every store writes inside its own mutating methods (docs/design/integration-v1.md §2.3).
 *
 * One builder for all three stores: the memory store, the folder store (which extends it) and PostgreSQL gather the
 * package facts their own way (in-memory state vs. SQL inside the transaction) and hand them here, so the payload a
 * consumer receives cannot differ by store. The conformance suite compares the stores against each other.
 *
 * Important: events are **thin** (D12) — identifiers, revisions, operation, actor. Never put model content here: the
 *    event log is readable by every reader of the pull feed and is delivered outside the company.
 */
import { randomUUID } from 'node:crypto';

import {
  EVENT_TYPES,
  type ModelIdentifiableData,
  type ModelPackageCreatedData,
  type ModelPackageDeletedData,
  type ModelPackageFileChangedData,
} from '@aas/core';

import { actorFields, resolveActor } from './actor.js';
import { changeFields } from './change.js';
import type { NewEvent } from './integration-types.js';
import type { Actor, IdentifiableModelType } from './types.js';

/** What a store knows about the package at commit time, after the change */
export interface PackageFacts {
  packageId: string;
  /** Absent = shared package */
  owner?: string;
  /** Package revision after the change (for a deletion: the last revision + 1, so receivers do not skip it) */
  packageRevision: number;
  /** The package's first AAS by ordinal, after the change */
  globalAssetId: string | null;
  aasId: string | null;
}

/** A model event plus the owner the store copied from the package */
export type ModelEvent = NewEvent & { owner?: string };

export type ModelOperation = 'create' | 'update' | 'delete';

const SEGMENT: Record<IdentifiableModelType, string> = {
  AssetAdministrationShell: 'shells',
  Submodel: 'submodels',
  ConceptDescription: 'concept-descriptions',
};

const TYPES: Record<IdentifiableModelType, Record<ModelOperation, string>> = {
  AssetAdministrationShell: {
    create: EVENT_TYPES.modelShellCreated,
    update: EVENT_TYPES.modelShellUpdated,
    delete: EVENT_TYPES.modelShellDeleted,
  },
  Submodel: {
    create: EVENT_TYPES.modelSubmodelCreated,
    update: EVENT_TYPES.modelSubmodelUpdated,
    delete: EVENT_TYPES.modelSubmodelDeleted,
  },
  ConceptDescription: {
    create: EVENT_TYPES.modelConceptDescriptionCreated,
    update: EVENT_TYPES.modelConceptDescriptionUpdated,
    delete: EVENT_TYPES.modelConceptDescriptionDeleted,
  },
};

/** base64url without padding — the same form Part 2 uses in paths */
function b64url(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

/** `globalAssetId` / `aasId` of the first AAS content (callers pass shells already sorted by ordinal) */
export function firstShellFacts(shell: Record<string, unknown> | undefined): { globalAssetId: string | null; aasId: string | null } {
  if (shell === undefined) return { globalAssetId: null, aasId: null };
  const info = shell['assetInformation'];
  const globalAssetId = info !== null && typeof info === 'object' ? (info as Record<string, unknown>)['globalAssetId'] : undefined;
  const id = shell['id'];
  return {
    globalAssetId: typeof globalAssetId === 'string' && globalAssetId !== '' ? globalAssetId : null,
    aasId: typeof id === 'string' ? id : null,
  };
}

function envelope(type: string, facts: PackageFacts, subject: string, data: Record<string, unknown>, time: string, actor?: Actor): ModelEvent {
  const event: ModelEvent = {
    id: randomUUID(),
    type,
    time,
    packageId: facts.packageId,
    subject,
    packageRevision: facts.packageRevision,
    ...actorFields(actor),
    ...changeFields(),
    data,
  };
  if (facts.owner !== undefined) event.owner = facts.owner;
  return event;
}

export function packageCreatedEvent(
  facts: PackageFacts,
  name: string,
  counts: ModelPackageCreatedData['counts'],
  time: string,
): ModelEvent {
  const data: ModelPackageCreatedData = {
    packageId: facts.packageId,
    name,
    owner: facts.owner ?? null,
    globalAssetId: facts.globalAssetId,
    aasId: facts.aasId,
    counts,
  };
  return envelope(EVENT_TYPES.modelPackageCreated, facts, `packages/${facts.packageId}`, data, time);
}

export function packageDeletedEvent(facts: PackageFacts, name: string, time: string): ModelEvent {
  const data: ModelPackageDeletedData = {
    packageId: facts.packageId,
    name,
    globalAssetId: facts.globalAssetId,
    aasId: facts.aasId,
  };
  return envelope(EVENT_TYPES.modelPackageDeleted, facts, `packages/${facts.packageId}`, data, time);
}

export function packageFileEvent(facts: PackageFacts, part: string, role: string, operation: 'put' | 'delete', time: string): ModelEvent {
  const data: ModelPackageFileChangedData = { packageId: facts.packageId, part, role, operation };
  return envelope(EVENT_TYPES.modelPackageFileChanged, facts, `packages/${facts.packageId}`, data, time);
}

export function identifiableEvent(
  facts: PackageFacts,
  record: { modelType: IdentifiableModelType; id: string; idShort?: string; semanticId?: string },
  operation: ModelOperation,
  identifiableRevision: number,
  time: string,
  explicitActor?: Actor,
): ModelEvent {
  const actor = resolveActor(explicitActor);
  const data: ModelIdentifiableData = {
    packageId: facts.packageId,
    modelType: record.modelType,
    id: record.id,
    idShort: record.idShort ?? null,
    semanticId: record.semanticId ?? null,
    operation,
    identifiableRevision,
    packageRevision: facts.packageRevision,
    globalAssetId: facts.globalAssetId,
    aasId: facts.aasId,
  };
  // The key is left out when there is no actor — "nobody" and "no record" must not look alike (actor.ts)
  if (actor !== undefined) data.actor = { id: actor.id, name: actor.name };
  const subject = `packages/${facts.packageId}/${SEGMENT[record.modelType]}/${b64url(record.id)}`;
  return envelope(TYPES[record.modelType][operation], facts, subject, data, time, explicitActor);
}
