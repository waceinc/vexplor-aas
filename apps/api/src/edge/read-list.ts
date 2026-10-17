/**
 * The edge's read list (docs/edge-contract.md §4): what to read and where, resolved from the AID submodels of the files
 * the device's workspace shows. The edge gets plain addresses and never sees the AAS.
 *
 * Important: ids are stable. `tagId` and `interfaceId` are derived from (package, interface, property), so re-reading
 *    the same files gives the same ids and an unchanged list keeps its revision — the edge's `If-None-Match` then
 *    answers 304 and nothing restarts on the factory side.
 * Important: only what can be read goes out — an interface with no endpoint or a protocol the server cannot name, and
 *    a property with no address, are left out. Supporting the contract is not full AID support (contract §8).
 * Important: only files the device's workspace **owns**. Shared (ownerless) files are readable in a workspace but not
 *    writable, so values for them could never be stored — listing them made every batch fail (review H1).
 * Important: no secrets. Credentials stay on the edge machine; the list can only name one (`credentialRef`), which
 *    this server does not do yet.
 */
import { createHash } from 'node:crypto';

import { canonicalJson } from '@aas/core';
import { parseAid, type AidInterface } from '@aas/collector';
import type { AasStore } from '@aas/store';
import { assetInformationOf, shellsOf } from '../integration/exports/elements.js';
import { allPackages } from '../integration/exports/store.js';

import type { EdgeProtocol, ReadListInterface, ReadListTag, TagLimit, TagRole } from '../integration/bundle-types.js';
import { tagHintsOf } from './tag-hints.js';

export type { EdgeProtocol, ReadListInterface, ReadListTag, TagLimit, TagRole };
const EDGE_PROTOCOLS: ReadonlySet<string> = new Set<EdgeProtocol>(['OPCUA', 'MODBUS', 'MQTT', 'HTTP']);

const short = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16);

/** The id a tag keeps as long as package, interface and property keep their names */
export const tagIdOf = (packageId: string, interfaceName: string, propertyName: string): string =>
  `tag_${short(`${packageId}\0${interfaceName}\0${propertyName}`)}`;

/** The tag without its hints (semanticId · suggestedRole · limits) */
function withoutHints(tag: ReadListTag): ReadListTag {
  const copy: ReadListTag = { ...tag };
  delete copy.semanticId;
  delete copy.suggestedRole;
  delete copy.limits;
  return copy;
}

/**
 * Revision of a list — the same interfaces give the same string.
 * Important: hints are left out. They only help a person approve; a new or changed hint (a server update, a longer
 *    role table) must not mark every approved device as changed and make each site approve again.
 */
export const revisionOf = (interfaces: readonly ReadListInterface[]): string =>
  short(canonicalJson(interfaces.map((iface) => ({ ...iface, tags: iface.tags.map(withoutHints) }))));

/**
 * Security of one interface for the edge. OPC UA takes what the AID states (`uav_securityMode`, `uav_securityPolicy`);
 * when it asks for a user name, `credentialRef` is the endpoint — the name of the entry the installer stored on the edge.
 */
function securityOf(descriptor: AidInterface): ReadListInterface['security'] {
  const base = descriptor.base ?? '';
  if (descriptor.protocol === 'OPCUA') {
    const stated = descriptor.security;
    const mode = stated?.mode ?? 'None';
    return {
      mode,
      ...(mode !== 'None' && stated?.policy ? { policy: stated.policy } : {}),
      ...(stated?.userIdentityToken === 'UserName' ? { credentialRef: base } : {}),
    };
  }
  return { mode: /^(https|mqtts|wss):/i.test(base) ? 'TLS' : 'None' };
}

/** The interfaces of one file that the edge can read */
export function interfacesOf(packageId: string, environment: Parameters<typeof parseAid>[0], intervalMs: number): ReadListInterface[] {
  const shell = shellsOf(environment)[0];
  const aasId = typeof shell?.['id'] === 'string' ? shell['id'] : null;
  const globalAssetId = assetInformationOf(shell)['globalAssetId'];
  const out: ReadListInterface[] = [];
  const hintsOf = tagHintsOf(environment as Parameters<typeof tagHintsOf>[0]);
  for (const descriptor of parseAid(environment)) {
    // Only protocols the contract names — BACnet is recognised by the AID but not collected yet
    if (!EDGE_PROTOCOLS.has(descriptor.protocol) || !descriptor.base) continue;
    const tags: ReadListTag[] = [];
    for (const property of descriptor.properties) {
      if (property.href === undefined) continue;
      tags.push({
        tagId: tagIdOf(packageId, descriptor.name, property.name),
        propertyName: property.name,
        address: property.href,
        ...(property.key !== undefined ? { key: property.key } : {}),
        ...(property.type !== undefined ? { type: property.type } : {}),
        ...(property.unit !== undefined ? { unit: property.unit } : {}),
        fields: { ...property.formFields },
        ...hintsOf(property.name),
      });
    }
    if (tags.length === 0) continue;
    out.push({
      interfaceId: `${packageId}:${descriptor.name}`,
      packageId,
      aasId,
      globalAssetId: typeof globalAssetId === 'string' && globalAssetId !== '' ? globalAssetId : null,
      interfaceName: descriptor.name,
      protocol: descriptor.protocol as EdgeProtocol,
      endpoint: descriptor.base,
      security: securityOf(descriptor),
      intervalMs,
      tags,
    });
  }
  return out;
}

/** Whether a device of this workspace may store values for the package: it owns it (every package on a server that does not partition) */
export const ownedBy = (workspace: string | null, record: { owner?: string | null } | undefined): boolean =>
  record !== undefined && (workspace === null || record.owner === workspace);

/** The files the device's workspace owns, in package order. The caller runs it inside the device's workspace */
export async function currentInterfaces(store: AasStore, intervalMs: number, workspace: string | null): Promise<ReadListInterface[]> {
  const out: ReadListInterface[] = [];
  for (const record of await allPackages(store)) {
    if (ownedBy(workspace, record)) out.push(...interfacesOf(record.id, await store.getEnvironment(record.id), intervalMs));
  }
  return out;
}
