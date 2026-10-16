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
