/**
 * The edge's read list (docs/edge-contract.md §4): what to read and where, resolved from the AID submodels of the files
 * the device's workspace shows. The edge gets plain addresses and never sees the AAS.
 *
 * Important: ids are stable. `tagId` and `interfaceId` are derived from (package, interface, property), so re-reading
 *    the same files gives the same ids and an unchanged list keeps its revision — the edge's `If-None-Match` then
 *    answers 304 and nothing restarts on the factory side.
 * Important: only what can be read goes out — an interface with no endpoint or a protocol the server cannot name, and
 *    a property with no address, are left out. Supporting the contract is not full AID support (contract §8).
 * Important: no secrets. Credentials stay on the edge machine; the list can only name one (`credentialRef`), which
 *    this server does not do yet.
 */
import { createHash } from 'node:crypto';

import { canonicalJson } from '@aas/core';
import { parseAid, type AidInterface } from '@aas/collector';
import type { AasStore } from '@aas/store';
import { assetInformationOf, shellsOf } from '../integration/exports/elements.js';
import { allPackages } from '../integration/exports/store.js';

export type EdgeProtocol = 'OPCUA' | 'MODBUS' | 'MQTT' | 'HTTP';

export interface ReadListTag {
  tagId: string;
  propertyName: string;
  address: string;
  key?: string;
  type?: string;
  unit?: string;
  fields: Record<string, string>;
}

export interface ReadListInterface {
  interfaceId: string;
  packageId: string;
  aasId: string | null;
  globalAssetId: string | null;
  interfaceName: string;
  protocol: EdgeProtocol;
  endpoint: string;
  security: { mode: 'None' | 'Sign' | 'SignAndEncrypt' | 'TLS'; policy?: string; credentialRef?: string };
  intervalMs: number;
  tags: ReadListTag[];
}

const short = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16);

/** The id a tag keeps as long as package, interface and property keep their names */
export const tagIdOf = (packageId: string, interfaceName: string, propertyName: string): string =>
  `tag_${short(`${packageId}\0${interfaceName}\0${propertyName}`)}`;

/** Revision of a list — the same interfaces give the same string */
export const revisionOf = (interfaces: readonly ReadListInterface[]): string => short(canonicalJson(interfaces));

function securityOf(descriptor: AidInterface): ReadListInterface['security'] {
  const base = descriptor.base ?? '';
  return { mode: /^(https|mqtts|wss):/i.test(base) ? 'TLS' : 'None' };
}

/** The interfaces of one file that the edge can read */
export function interfacesOf(packageId: string, environment: Parameters<typeof parseAid>[0], intervalMs: number): ReadListInterface[] {
  const shell = shellsOf(environment)[0];
  const aasId = typeof shell?.['id'] === 'string' ? shell['id'] : null;
  const globalAssetId = assetInformationOf(shell)['globalAssetId'];
  const out: ReadListInterface[] = [];
  for (const descriptor of parseAid(environment)) {
    if (descriptor.protocol === 'UNKNOWN' || !descriptor.base) continue;
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
      });
    }
    if (tags.length === 0) continue;
    out.push({
      interfaceId: `${packageId}:${descriptor.name}`,
      packageId,
      aasId,
      globalAssetId: typeof globalAssetId === 'string' && globalAssetId !== '' ? globalAssetId : null,
      interfaceName: descriptor.name,
      protocol: descriptor.protocol,
      endpoint: descriptor.base,
      security: securityOf(descriptor),
      intervalMs,
      tags,
    });
  }
  return out;
}

/** Everything the store (scoped to the device's workspace by the caller) shows, in package order */
export async function currentInterfaces(store: AasStore, intervalMs: number): Promise<ReadListInterface[]> {
  const out: ReadListInterface[] = [];
  for (const record of await allPackages(store)) out.push(...interfacesOf(record.id, await store.getEnvironment(record.id), intervalMs));
  return out;
}
