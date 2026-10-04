/**
 * 레퍼런스 번들 **첨부** — 사람이 넣은 문서·증빙을 공정 파일에 딸려 보관한다.
 *
 * 번들은 몇 달에 걸쳐 고쳐 가며 낸다(추진방안 §6 — 11월 착수 → 1월 최종 모델로 동기화 → 2월 재검증).
 * 그런데 번들을 열었다 다시 내보내면 Use-Case 문서·가이던스·참고 자료·수집 기록이
 * **전부 사라졌다**(2026-09-30 검증, 6개 중 6개). 도구가 만드는 것만 다시 만들었기 때문이다.
 *
 * 그래서 번들 안의 파일을 둘로 나눈다.
 *  - **도구가 만드는 것** — README·manifest·공정/참조모델 AASX·사전점검·연계 초안·작성 안내.
 *    내보낼 때마다 새로 만든다(모델이 바뀌면 따라 바뀌어야 한다)
 *  - **사람이 넣은 것** — 그 밖의 모든 파일. 공정 파일에 role `bundle`로 보관하고 그대로 되살린다.
 *    🔴 AASX에는 넣지 않는다(store/convert.ts) — 공정 파일 해시가 바뀌면 번들 대조가 깨진다
 *
 * 수집 기록(수집값 CSV · 수집기록.html)은 사람이 넣은 것처럼 보관하되, **새 수집 기록이 있으면 통째로 갈아 끼운다**
 * — 옛 CSV와 새 기록서가 섞이면 무엇이 무엇의 증빙인지 흐려진다.
 */
import { isSafeEntryName } from '@aas/aasx';
import type { AasStore, PackageFileRecord } from '@aas/store';
import { ApiError } from '../http.js';

/**
 * 올린 AASX **원본 바이트** — role `bundle`이라 AASX로 다시 내보낼 때는 빠진다.
 * 🔴 번들의 참조모델은 운영기관 Validator를 통과한 **그 파일**이어야 해시로 대조된다. 도구가 다시 포장하면
 *    모델 내용은 같아도 바이트가 달라져 해시가 어긋났다(2026-09-30 제출 번들 검증 — 3종 모두).
 *    그래서 올릴 때 원본을 보관하고, 모델을 고치지 않았으면 번들에 원본 그대로 넣는다
 */
export const ORIGINAL_PART = '/.original/source.aasx';

/** importPackage의 keep에 싣는 원본 — 담는 동작 안에서 넣어야 리비전이 1로 남는다 */
export const originalFile = (data: Uint8Array): PackageFileRecord => ({
  part: ORIGINAL_PART,
  role: 'bundle',
  contentType: 'application/asset-administration-shell-package',
  data,
});

/** 번들 첨부가 사는 파트 경로의 머리 */
export const BUNDLE_PART_PREFIX = '/bundle/';
/** 이전 번들 manifest의 증빙 요약 — 새 수집이 없을 때 이어받는다. 번들 파일로 나가지 않는다 */
export const CARRIED_EVIDENCE_PART = `${BUNDLE_PART_PREFIX}.carried-evidence.json`;

/** 사람이 넣을 수 있는 폴더 — 번들 구조(추진방안 §2.1) */
export const ATTACHMENT_FOLDERS = [
  '01_UseCase문서',
  '03_가이던스',
  '04_데이터연계정의',
  '05_샘플데이터',
  '06_검증결과',
] as const;

/** 수집 기록 — 새 기록이 있으면 통째로 갈아 끼운다 */
export const isEvidencePath = (path: string): boolean =>
  /^05_샘플데이터\/수집값_[^/]+\.csv$/.test(path) || path === '06_검증결과/수집기록.html';

/** 도구가 매번 새로 만드는 파일 — 보관하지 않는다 */
export function isGeneratedPath(path: string): boolean {
  return (
    path === 'README.md' ||
    path === 'bundle-manifest.json' ||
    path.startsWith('00_공정구성/') ||
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
 * 사람이 넣는 경로를 검사한다 — 번들 폴더 안, 안전한 이름, 도구가 만드는 파일이 아닐 것.
 * 🔴 경로 탈출(`..`)·절대경로는 AASX와 같은 검사(isSafeEntryName)로 막는다
 */
export function checkAttachmentPath(path: string): string {
  const clean = path.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!clean || !isSafeEntryName(clean) || clean.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) {
    throw new ApiError(400, 'BadRequest', `쓸 수 없는 경로입니다: ${path}`);
  }
  if (!ATTACHMENT_FOLDERS.some((folder) => clean.startsWith(`${folder}/`))) {
    throw new ApiError(400, 'BadRequest', `첨부는 ${ATTACHMENT_FOLDERS.join(' · ')} 폴더 안에만 둡니다.`);
  }
  if (isGeneratedPath(clean)) {
    throw new ApiError(400, 'BadRequest', `${clean}은(는) 도구가 내보낼 때마다 새로 만드는 파일입니다.`);
  }
  return clean;
}

export interface Attachment {
  path: string;
  size: number;
  contentType: string;
  data: Uint8Array;
}

/** 공정 파일에 보관된 첨부 — 경로순 */
export async function listAttachments(store: AasStore, packageId: string): Promise<Attachment[]> {
  const files = await store.packageFiles(packageId);
  return files
    .filter((file) => file.role === 'bundle' && file.part !== CARRIED_EVIDENCE_PART)
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

/** 이전 번들에서 이어받은 증빙 요약 */
export interface CarriedEvidence {
  level: string | null;
  entries: Record<string, unknown>[];
  /** 어느 번들에서 왔나 */
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
