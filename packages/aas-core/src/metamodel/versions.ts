/**
 * AAS metamodel versions this code reads and writes — IDTA-01001 V3.0, V3.1 and V3.2.
 *
 * The in-memory model (types/*) is the **superset up to V3.2**; a file of any of the three versions loads into it
 * without losing a field. Which version a file *is* is decided on reading (XML namespace, or content for JSON) and
 * which version to *write* is chosen on saving (metamodel/convert.ts lowers and reports what a lower version cannot
 * hold).
 *
 * Sources: the official schemas of admin-shell-io/aas-specs-metamodel, tags IDTA-01001-3-0-1_schemasV3.0.9 · v3.1.2 ·
 * v3.2.0, and the change notes of IDTA-01001 V3.2 (Annex "Change notes").
 */

export const METAMODEL_VERSIONS = ['3.0', '3.1', '3.2'] as const;
export type MetamodelVersion = (typeof METAMODEL_VERSIONS)[number];

/**
 * Version written when the caller does not choose one.
 * Important: stays 3.0 — the KOSMO Validator, the Part 2 API and every file this product has written so far are 3.0.
 *    Changing it changes what every download contains.
 */
export const DEFAULT_METAMODEL_VERSION: MetamodelVersion = '3.0';

/** XML target namespace of each version (AAS.xsd `targetNamespace`) */
export const METAMODEL_XML_NAMESPACES: Readonly<Record<MetamodelVersion, string>> = {
  '3.0': 'https://admin-shell.io/aas/3/0',
  '3.1': 'https://admin-shell.io/aas/3/1',
  '3.2': 'https://admin-shell.io/aas/3/2',
};

/** The version a namespace names, or undefined for anything else (an unknown future version included) */
export function versionFromNamespace(namespace: string): MetamodelVersion | undefined {
  for (const version of METAMODEL_VERSIONS) {
    if (METAMODEL_XML_NAMESPACES[version] === namespace.trim()) return version;
  }
  return undefined;
}

/** Negative if a is older than b, 0 if equal, positive if newer */
export function compareVersions(a: MetamodelVersion, b: MetamodelVersion): number {
  return METAMODEL_VERSIONS.indexOf(a) - METAMODEL_VERSIONS.indexOf(b);
}

/** AssetKind values allowed in each version (Role since 3.1, Batch since 3.2) */
export const ASSET_KINDS_BY_VERSION: Readonly<Record<MetamodelVersion, readonly string[]>> = {
  '3.0': ['Type', 'Instance', 'NotApplicable'],
  '3.1': ['Type', 'Instance', 'NotApplicable', 'Role'],
  '3.2': ['Type', 'Instance', 'NotApplicable', 'Role', 'Batch'],
};

/**
 * Longest Identifier (and the other text types that grew with it — PathType, ValueDataType of a SpecificAssetId,
 * a ValueReferencePair or an IEC 61360 value) per version: 2000 in 3.0, 2048 from 3.1.
 */
export const MAX_IDENTIFIER_LENGTH: Readonly<Record<MetamodelVersion, number>> = { '3.0': 2000, '3.1': 2048, '3.2': 2048 };

/** Longest ContentType per version: 100 in 3.0, 128 from 3.1 */
export const MAX_CONTENT_TYPE_LENGTH: Readonly<Record<MetamodelVersion, number>> = { '3.0': 100, '3.1': 128, '3.2': 128 };

/** How a version was determined when reading */
export interface MetamodelDetection {
  /**
   * The version of the file. From an XML namespace it is the declared version; from content (JSON has no version
   * marker) it is the **lowest version that can hold the content** — a file with no 3.1/3.2 construct reads as 3.0
   * even if its author used a 3.2 tool.
   */
  version: MetamodelVersion;
  source: 'namespace' | 'content';
  /** True when the version was guessed from content rather than declared */
  inferred: boolean;
  /**
   * Versions whose schema can hold this content, oldest first — usually from `version` up to 3.2. Empty when the
   * content mixes a newer construct with a value only 3.0 allows (a 3.2 Batch next to a one-letter idShort).
   */
  fits: MetamodelVersion[];
  /** Constructs that need a version above 3.0, in document order — empty for plain 3.0 content */
  evidence: VersionEvidence[];
}

export interface VersionEvidence {
  /** JSON Pointer into the environment */
  pointer: string;
  /** Stable code of the difference (see metamodel/features.ts) */
  feature: string;
  /** First version that allows it */
  since: MetamodelVersion;
  /** Last version that allows it — set for 3.0 values the 3.1 / 3.2 schemas reject */
  until?: MetamodelVersion;
}
