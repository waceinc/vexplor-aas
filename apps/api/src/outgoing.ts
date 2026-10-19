/**
 * Files that leave the server — the AASX download, the Part 2 package serialization and the reference bundle — are
 * written as a chosen metamodel version (2026-10-19).
 *
 * The version defaults to **the one the package came in as** (the store remembers it): a 3.1 file goes out as 3.1,
 * a 3.0 file as 3.0, a model made here as 3.1. Writing a lower version reports what that version cannot hold; a value
 * it has no way to say stops the write (422 with the report) unless the caller asks to keep it as it is.
 *
 * Important: internal round trips — the snapshot the checks read, sameness checks, the undo stack — keep using the
 *    version-less `writeAasx`. They must never lose a field, and none of their bytes reach a person.
 * Important: for V3.1 and V3.2 the paths of attachments are percent-encoded and their parts renamed with them
 *    (`encodePaths`) — those versions accept only URIs, and Korean file names are common. V3.0 output is unchanged.
 */
import {
  convertEnvironment,
  fill,
  METAMODEL_VERSIONS,
  tr,
  type DowngradeReport,
  type MetamodelVersion,
} from '@aas/core';
import { encodePackagePaths, writeAasxWithReport, type AasxPackage, type RenamedPath } from '@aas/aasx';
import type { PackageMetamodel, PackageRecord } from '@aas/store';
import { ApiError, type ApiRequest } from './http.js';

/** What the caller asked for in the query — `?metamodel=3.1&unrepresentable=keep` */
export interface OutgoingChoice {
  /** Empty means the version the package came in as */
  version?: MetamodelVersion;
  /** Keep values the version cannot express instead of refusing (the file then fails that version's schema) */
  keep?: boolean;
}

export function outgoingChoiceOf(request: ApiRequest): OutgoingChoice {
  const choice: OutgoingChoice = {};
  const wanted = request.query['metamodel'];
  if (wanted !== undefined && wanted !== '') {
    const version = wanted.replace(/^v/i, '');
    if (!(METAMODEL_VERSIONS as readonly string[]).includes(version)) {
      throw new ApiError(
        400,
        'BadRequest',
        fill(tr('metamodel은 {0} 중 하나여야 합니다: {1}'), { 0: METAMODEL_VERSIONS.join(' · '), 1: wanted }),
      );
    }
    choice.version = version as MetamodelVersion;
  }
  const policy = request.query['unrepresentable'];
  if (policy !== undefined && policy !== 'keep' && policy !== 'error') {
    throw new ApiError(400, 'BadRequest', fill(tr('unrepresentable은 keep 또는 error여야 합니다: {0}'), { 0: policy }));
  }
  if (policy === 'keep') choice.keep = true;
  return choice;
}

export interface OutgoingFile {
  data: Uint8Array;
  version: MetamodelVersion;
  report: DowngradeReport;
  renamed: RenamedPath[];
}

/**
 * Writes the package for someone else.
 * @throws DowngradeError (→ 422 with the report) when a value cannot be expressed and `keep` is not set
 */
export function writeOutgoing(pkg: AasxPackage, record: Pick<PackageRecord, 'metamodel'>, choice: OutgoingChoice = {}): OutgoingFile {
  const version = choice.version ?? record.metamodel.version;
  const { data, report, renamed } = writeAasxWithReport(pkg, {
    version,
    encodePaths: true,
    ...(choice.keep ? { unrepresentable: 'keep' as const } : {}),
  });
  return { data, version, report, renamed };
}

/** What writing a version would do, without writing it — the screen shows this before the download */
export interface OutgoingPreview {
  version: MetamodelVersion;
  /** The version the package came in as — the default */
  stored: PackageMetamodel;
  /** True when the file says exactly what the model says (only percent-encoded names may differ) */
  lossless: boolean;
  /** True when a value cannot be expressed — the download is refused unless kept as it is */
  blocked: boolean;
  entries: DowngradeReport['entries'];
  renamed: RenamedPath[];
}

export function previewOutgoing(pkg: AasxPackage, record: Pick<PackageRecord, 'metamodel'>, choice: OutgoingChoice = {}): OutgoingPreview {
  const version = choice.version ?? record.metamodel.version;
  // Same steps as writeAasxWithReport, minus the ZIP — attachments can be large and nothing is sent here
  const encoded = version === '3.0' ? { pkg, renamed: [] } : encodePackagePaths(pkg);
  const { report } = convertEnvironment(encoded.pkg.environment, { to: version, unrepresentable: 'keep' });
  return {
    version,
    stored: { ...record.metamodel },
    lossless: report.lossless,
    blocked: report.entries.some((entry) => entry.kind === 'unrepresentable'),
    entries: report.entries,
    renamed: encoded.renamed,
  };
}
