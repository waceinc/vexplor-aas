/**
 * API 클라이언트 — 내려받기 · 레퍼런스 번들 · 검증 결과서
 * src/api.ts 에서 떼어 냈다(2026-10-13 컴포넌트화) — 코드와 주석은 옮기기 전 글자 그대로다. 밖에서는 api.ts 로 쓴다.
 */
import type { BundleView, BundleImportView } from './types.js';
import { withAuth, request, toError, filenameOf, saveBlob } from './http.js';

export const bundleApi = {
  /**
   * 내려받기·결과서는 링크가 아니라 fetch로 가져온다.
   * `<a href>`에는 헤더를 실을 수 없어 인증을 켜면 401이 나고, 토큰을 주소에 넣으면
   * 서버 로그와 브라우저 기록에 그대로 남는다.
   */
  download: async (packageId: string): Promise<void> => {
    const response = await fetch(`/packages/${packageId}`, withAuth());
    if (!response.ok) throw await toError(response);
    saveBlob(await response.blob(), filenameOf(response) ?? 'download.aasx');
  },
  /** 레퍼런스 번들 — 구성·준비 상태·연계 항목 */
  bundle: (packageId: string, evidenceMinutes = ''): Promise<BundleView> =>
    request(`/packages/${packageId}/bundle/linkage${evidenceMinutes ? `?evidenceMinutes=${evidenceMinutes}` : ''}`),
  /** 번들 첨부 올리기 — 경로는 폴더/파일이름 */
  putBundleFile: (packageId: string, path: string, file: Blob): Promise<void> =>
    request(`/packages/${packageId}/bundle/files?path=${encodeURIComponent(path)}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: file,
    }),
  deleteBundleFile: (packageId: string, path: string): Promise<void> =>
    request(`/packages/${packageId}/bundle/files?path=${encodeURIComponent(path)}`, { method: 'DELETE' }),
  downloadBundleFile: async (packageId: string, path: string): Promise<void> => {
    const response = await fetch(`/packages/${packageId}/bundle/files?path=${encodeURIComponent(path)}`, withAuth());
    if (!response.ok) throw await toError(response);
    saveBlob(await response.blob(), path.split('/').pop() ?? 'attachment');
  },
  downloadBundle: async (
    packageId: string,
    options: { code: string; title: string; version: string; evidence: string; evidenceMinutes?: string },
  ): Promise<void> => {
    const { evidenceMinutes, ...rest } = options;
    const query = new URLSearchParams({ ...rest, ...(evidenceMinutes ? { evidenceMinutes } : {}) }).toString();
    const response = await fetch(`/packages/${packageId}/bundle?${query}`, withAuth());
    if (!response.ok) throw await toError(response);
    saveBlob(await response.blob(), filenameOf(response) ?? `bundle-${options.code}.zip`);
  },
  /** 번들 ZIP을 연다 — 공정·설비가 한 번에 올라오고 해시를 대조한다 */
  openBundle: (file: File): Promise<BundleImportView> =>
    request('/bundles', {
      method: 'POST',
      headers: { 'content-type': 'application/zip' },
      body: file,
    }),
  openReport: async (packageId: string): Promise<void> => {
    const response = await fetch(`/packages/${packageId}/report`, withAuth());
    if (!response.ok) throw await toError(response);
    const url = URL.createObjectURL(await response.blob());
    globalThis.open(url, '_blank', 'noreferrer');
    // 새 탭이 다 읽고 나서 놓아 준다
    globalThis.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  },
};
