/** In-memory model of an AASX package */
import type { Environment } from '@aas/core';

export interface AasxFile {
  /** Absolute part name (e.g. '/aasx/suppl/manual.pdf') */
  part: string;
  contentType: string;
  data: Uint8Array;
}

export interface AasxPackage {
  environment: Environment;
  /** AAS body part name. Default '/aasx/data.json' */
  specPart: string;
  /** Package thumbnail. Its path must match AssetInformation.defaultThumbnail.path (KOSMO-AAS-1) */
  thumbnail?: AasxFile;
  /** Attachments (manuals, etc.) linked to data.json via the aas-suppl relationship */
  supplementaryFiles: AasxFile[];
  /**
   * Remaining ZIP entries that we do not manage.
   * Kept exactly as read and written back, for lossless round-tripping.
   */
  extraParts: Map<string, Uint8Array>;
}

export const DEFAULT_SPEC_PART = '/aasx/data.json';
export const ORIGIN_PART = '/aasx/aasx-origin';
