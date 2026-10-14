/**
 * Reference bundle **attachments** — keeps documents and evidence added by people alongside the process file.
 *
 * A bundle is revised and resubmitted over months (implementation plan §6 — start in November → sync to the final model in January → re-verify in February).
 * Yet opening a bundle and exporting it again made the Use-Case docs, guidance, reference material and collection records
 * **all disappear** (verified 2026-09-30, 6 of 6). Only what the tool generates was regenerated.
 *
 * So files in a bundle are split in two.
 *  - **Tool-generated** — README, manifest, process/reference-model AASX, pre-check, integration draft, authoring guide.
 *    Regenerated on every export (they must follow model changes)
 *  - **Added by people** — every other file. Stored in the process file with role `bundle` and restored as-is.
 *    Important: not put into the AASX (store/convert.ts) — if the process file hash changes, bundle verification breaks
 *
 * Collection records (collected-values CSV · collection record HTML) are kept like people-added files, but are **replaced wholesale when a new collection record exists**
 * — mixing old CSVs with a new record blurs which is evidence for what.
 */
import { isSafeEntryName } from '@aas/aasx';
import { fill, tr } from '@aas/core';
import type { AasStore, PackageFileRecord } from '@aas/store';
import { ApiError } from '../http.js';

/**
 * The uploaded AASX's **original bytes** — role `bundle`, so they are left out when re-exporting as AASX.
 * Important: the bundle's reference model must be **the very file** that passed the operator's Validator to match by hash. When the tool repackaged it,
 *    the bytes changed even with the same model content and the hash mismatched (submitted-bundle verification 2026-09-30 — all 3).
 *    So we keep the original on upload, and if the model was not edited, put the original into the bundle unchanged
 */
export const ORIGINAL_PART = '/.original/source.aasx';

/** Original carried in importPackage's keep — must be added within the import itself so the revision stays at 1 */
export const originalFile = (data: Uint8Array): PackageFileRecord => ({
  part: ORIGINAL_PART,
  role: 'bundle',
  contentType: 'application/asset-administration-shell-package',
  data,
});

/** Prefix of the part path where bundle attachments live */
export const BUNDLE_PART_PREFIX = '/bundle/';
/** Evidence summary from the previous bundle manifest — inherited when there is no new collection. Not emitted as a bundle file */
export const CARRIED_EVIDENCE_PART = `${BUNDLE_PART_PREFIX}.carried-evidence.json`;

/** Folders people may add to — bundle structure (implementation plan §2.1) */
export const ATTACHMENT_FOLDERS = [
  '01_UseCase문서', // i18n-ignore — submission bundle folder/file name (spec structure)
  '03_가이던스',
  '04_데이터연계정의', // i18n-ignore — submission bundle folder/file name (spec structure)
  '05_샘플데이터',
  '06_검증결과', // i18n-ignore — submission bundle folder/file name (spec structure)
] as const;

/** Collection records — replaced wholesale when a new record exists */
export const isEvidencePath = (path: string): boolean =>
  /^05_샘플데이터\/수집값_[^/]+\.csv$/.test(path) || path === '06_검증결과/수집기록.html';

/** Files the tool regenerates every time — not stored */
export function isGeneratedPath(path: string): boolean {
  return (
    path === 'README.md' ||
    path === 'bundle-manifest.json' ||
    path.startsWith('00_공정구성/') || // i18n-ignore — submission bundle folder/file name (spec structure)
    path.startsWith('02_참조모델/') ||
    /^06_검증결과\/사전점검_[^/]+\.html$/.test(path) ||
    path === '04_데이터연계정의/연계항목_초안.csv' ||
    path === '04_데이터연계정의/연계_확인사항.md' ||
    /^0[1-6]_[^/]+\/_작성안내\.md$/.test(path)
  );
}

const MIME: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  hwpx: 'application/hwp+zip',
  hwp: 'application/x-hwp',
  html: 'text/html',
  htm: 'text/html',
  csv: 'text/csv',
  md: 'text/markdown',
  txt: 'text/plain',
  json: 'application/json',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  zip: 'application/zip',
};

export const contentTypeOf = (path: string): string =>
  MIME[path.slice(path.lastIndexOf('.') + 1).toLowerCase()] ?? 'application/octet-stream';

/**
 * Validate a path people add to — inside the bundle folders, a safe name, and not a tool-generated file.
 * Important: path escape (`..`) and absolute paths are blocked by the same check as AASX (isSafeEntryName)
 */
export function checkAttachmentPath(path: string): string {
  const clean = path.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!clean || !isSafeEntryName(clean) || clean.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) {
    throw new ApiError(400, 'BadRequest', fill(tr('쓸 수 없는 경로입니다: {0}'), { 0: path }));
  }
  if (!ATTACHMENT_FOLDERS.some((folder) => clean.startsWith(`${folder}/`))) {
    throw new ApiError(400, 'BadRequest', fill(tr('첨부는 {0} 폴더 안에만 둡니다.'), { 0: ATTACHMENT_FOLDERS.join(' · ') }));
  }
  if (isGeneratedPath(clean)) {
    throw new ApiError(400, 'BadRequest', fill(tr('{0}은(는) 도구가 내보낼 때마다 새로 만드는 파일입니다.'), { 0: clean }));
  }
  return clean;
}

export interface Attachment {
  path: string;
  size: number;
  contentType: string;
  data: Uint8Array;
}

/** Attachments stored in the process file — sorted by path */
export async function listAttachments(store: AasStore, packageId: string): Promise<Attachment[]> {
  const files = await store.packageFiles(packageId);
  return files
    // Also filter by prefix — role bundle holds not only attachments but also the uploaded original (/.original/) and the format copy (/.derivation/)
    .filter((file) => file.role === 'bundle' && file.part.startsWith(BUNDLE_PART_PREFIX) && file.part !== CARRIED_EVIDENCE_PART)
    .map((file) => ({
      path: file.part.slice(BUNDLE_PART_PREFIX.length),
      size: file.data.length,
      contentType: file.contentType,
      data: file.data,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

export async function saveAttachment(store: AasStore, packageId: string, path: string, data: Uint8Array): Promise<void> {
  await store.putPackageFile(packageId, {
    part: `${BUNDLE_PART_PREFIX}${path}`,
    role: 'bundle',
    contentType: contentTypeOf(path),
    data,
  });
}

export async function removeAttachment(store: AasStore, packageId: string, path: string): Promise<void> {
  await store.deletePackageFile(packageId, `${BUNDLE_PART_PREFIX}${path}`);
}

/** Evidence summary inherited from the previous bundle */
export interface CarriedEvidence {
  level: string | null;
  entries: Record<string, unknown>[];
  /** Which bundle it came from */
  from: { code?: string; version?: string; createdAt?: string };
}

export async function readCarried(store: AasStore, packageId: string): Promise<CarriedEvidence | undefined> {
  const file = (await store.packageFiles(packageId)).find((f) => f.part === CARRIED_EVIDENCE_PART);
  if (!file) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(file.data)) as CarriedEvidence;
  } catch {
    return undefined;
  }
}

export async function writeCarried(store: AasStore, packageId: string, carried: CarriedEvidence): Promise<void> {
  await store.putPackageFile(packageId, {
    part: CARRIED_EVIDENCE_PART,
    role: 'bundle',
    contentType: 'application/json',
    data: new TextEncoder().encode(JSON.stringify(carried)),
  });
}
