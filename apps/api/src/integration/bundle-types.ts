/**
 * Types of the integration bundle (`vexplor.integrationBundle/1`) — kept free of imports on purpose.
 *
 * Important: this file and `bundle-build.ts` are the public surface of the `@aas/bundle` release tarball, whose type
 *    declarations are shipped as emitted. A relative import here would point at a file the tarball does not carry.
 */

export const BUNDLE_SCHEMA = 'vexplor.integrationBundle/1';

/** Per-file exports, in the order they appear in the manifest */
export const PER_PACKAGE_KINDS = ['hierarchy', 'bom', 'maintenance', 'documents'] as const;
export type PerPackageKind = (typeof PER_PACKAGE_KINDS)[number];

/** Who produced an export — the same block every single export carries */
export interface ExportSource {
  tool: string;
  version: string;
  instanceId: string | null;
}

export interface BundlePart {
  path: string;
  schema: string;
  packageId: string | null;
  items: number;
  sha256: string;
}

export interface BundleManifest {
  schema: typeof BUNDLE_SCHEMA;
  exportedAt: string;
  source: ExportSource;
  language: string;
  packages: { packageId: string; name: string; revision: number }[];
  parts: BundlePart[];
  skipped: { packageId: string; kind: PerPackageKind; code: string; message: string }[];
}

/**
 * The edge read list (docs/edge-contract.md §4) — here so `@aas/bundle` can ship `aidReadList` with standalone types.
 * The server's read list (apps/api/src/edge/read-list.ts) uses exactly these.
 */
export type EdgeProtocol = 'OPCUA' | 'MODBUS' | 'MQTT' | 'HTTP' | 'S7' | 'MC' | 'XGT';

/** Role a receiver may pre-fill for a tag (docs/edge-contract.md §4.1) — a person confirms it */
export type TagRole = 'run_state' | 'counter' | 'alarm_source' | 'meter' | 'condition' | 'quality' | 'value';

/** A bound for a tag's value, taken from a property of the same file (e.g. TechnicalData `MaxSettingForce`) */
export interface TagLimit {
  /** Upper or lower specification limit */
  bound: 'usl' | 'lsl';
  value: number;
  /** semanticId of the property the value comes from */
  semanticId: string;
  /** `<submodel idShort>:<idShortPath>` of that property */
  source: string;
}

export interface ReadListTag {
  tagId: string;
  propertyName: string;
  address: string;
  key?: string;
  type?: string;
  unit?: string;
  fields: Record<string, string>;
  /** Overrides the interface's intervalMs for this tag (set at approval) */
  intervalMs?: number;
  /** Hint: semanticId of the model element the value belongs to. Advisory — not part of the list revision */
  semanticId?: string;
  /** Hint: role a receiver may pre-fill. Advisory — not part of the list revision */
  suggestedRole?: TagRole;
  /** Hint: bounds from the same file. Advisory — not part of the list revision */
  limits?: TagLimit[];
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
