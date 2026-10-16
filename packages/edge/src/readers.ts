/**
 * Reading equipment named by the approved read list — with the collector's own readers (@aas/opcua, @aas/fieldbus), so
 * the edge reads exactly as AAS Studio's server-side collector does.
 *
 * Important: read only. Only `read` is ever called on a reader; nothing here writes to a PLC.
 * Important: the read list is the whole truth about what to read. A device without an approved list reads nothing;
 *    tags are grouped by their interval (a tag's own intervalMs overrides the interface's).
 * Important: a reading that has not arrived yet (`pending`) makes no sample — no fake value in the time series.
 */
import type { AidInterface, ProtocolReader, ReadResult } from '@aas/collector';

export interface ReadListTag {
  tagId: string;
  propertyName: string;
  address: string;
  key?: string;
  type?: string;
  unit?: string;
  fields: Record<string, string>;
  intervalMs?: number;
}

export interface ReadListInterface {
  interfaceId: string;
  interfaceName: string;
  protocol: 'OPCUA' | 'MODBUS' | 'MQTT' | 'HTTP';
  endpoint: string;
  security: { mode: string; policy?: string; credentialRef?: string };
  intervalMs: number;
  tags: ReadListTag[];
}

export type Sample = { tagId: string; observedAt: string; receivedAt: string; value: number | string | boolean | null; quality?: string; error?: string };

export interface OpenOptions {
  credentials: Map<string, { userName: string; password: string }>;
  opcua: { pkiDir: string; trustFirstUse: boolean };
}

/** The read list's interface in the shape the collector's readers take */
export function toAidInterface(iface: ReadListInterface): AidInterface {
  return {
    name: iface.interfaceName,
    protocol: iface.protocol,
    base: iface.endpoint,
    properties: iface.tags.map((tag) => ({
      name: tag.propertyName,
      observable: false,
      href: tag.address,
      formFields: { ...tag.fields },
      ...(tag.key !== undefined ? { key: tag.key } : {}),
      ...(tag.type !== undefined ? { type: tag.type } : {}),
      ...(tag.unit !== undefined ? { unit: tag.unit } : {}),
    })),
  };
}

/** Opens a reader for one interface; throws with a reason the status block reports */
export async function openReader(iface: ReadListInterface, options: OpenOptions): Promise<ProtocolReader> {
  if (iface.protocol === 'OPCUA') {
    const { OpcUaReader } = await import('@aas/opcua');
    const ref = iface.security.credentialRef;
    const user = ref ? options.credentials.get(ref) : undefined;
    if (ref && !user) throw new Error(`no credential named ${ref} in the credentials file`);
    const mode = iface.security.mode as 'None' | 'Sign' | 'SignAndEncrypt';
    return OpcUaReader.connect({
      endpoint: iface.endpoint,
      ...(mode !== 'None' ? { security: { mode, ...(iface.security.policy ? { policy: iface.security.policy } : {}) } } : {}),
      ...(user ? { user } : {}),
      pkiDir: options.opcua.pkiDir,
      trustUnknownServer: options.opcua.trustFirstUse,
    });
  }
  if (iface.protocol === 'MODBUS') return (await import('@aas/fieldbus')).ModbusReader.connect(toAidInterface(iface));
  if (iface.protocol === 'MQTT') return (await import('@aas/fieldbus')).MqttReader.connect(toAidInterface(iface));
  throw new Error(`${iface.protocol} is not read by this edge yet`);
}

/** Tags of an interface grouped by their effective interval */
export function intervalGroups(iface: ReadListInterface): Map<number, ReadListTag[]> {
  const groups = new Map<number, ReadListTag[]>();
  for (const tag of iface.tags) {
    const every = tag.intervalMs ?? iface.intervalMs;
    groups.set(every, [...(groups.get(every) ?? []), tag]);
  }
  return groups;
}

/** A contract value from whatever the reader returned — numbers, text and booleans as they are, the rest as JSON */
function valueOf(value: unknown): Sample['value'] {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return Number(value);
  return JSON.stringify(value);
}

/** One reading of a group of tags as samples */
export async function readGroup(reader: ProtocolReader, tags: readonly ReadListTag[], now: () => Date = () => new Date()): Promise<Sample[]> {
  const results: ReadResult[] = await reader.read(tags.map((tag) => tag.address));
  const receivedAt = now().toISOString();
  const out: Sample[] = [];
  results.forEach((result, index) => {
    const tag = tags[index];
    if (!tag || result.pending) return;
    out.push({
      tagId: tag.tagId,
      observedAt: result.observedAt ?? receivedAt,
      receivedAt,
      value: result.error ? null : valueOf(result.value),
      ...(result.quality ? { quality: result.quality.slice(0, 64) } : {}),
      ...(result.error ? { error: result.error.slice(0, 512) } : {}),
    });
  });
  return out;
}
