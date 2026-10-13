/**
 * API 클라이언트 — 첨부 파일 · 다른 파일에서 서브모델 가져오기
 * src/api.ts 에서 떼어 냈다(2026-10-13 컴포넌트화) — 코드와 주석은 옮기기 전 글자 그대로다. 밖에서는 api.ts 로 쓴다.
 */
import { encodeIdentifier, withAuth, request, toError, saveBlob } from './http.js';

export const attachmentApi = {
  putAttachment: (
    packageId: string,
    submodelId: string,
    idShortPath: string,
    file: File,
    revision?: number,
  ): Promise<void> =>
    request(
      `/packages/${packageId}/api/v3.0/submodels/${encodeIdentifier(submodelId)}` +
        `/submodel-elements/${idShortPath}/attachment?fileName=${encodeURIComponent(file.name)}`,
      {
        method: 'PUT',
        headers: {
          'content-type': file.type || 'application/octet-stream',
          ...(revision === undefined ? {} : { 'if-match': String(revision) }),
        },
        body: file,
      },
    ),
  deleteAttachment: (
    packageId: string,
    submodelId: string,
    idShortPath: string,
    revision?: number,
  ): Promise<unknown> =>
    request(
      `/packages/${packageId}/api/v3.0/submodels/${encodeIdentifier(submodelId)}` +
        `/submodel-elements/${idShortPath}/attachment`,
      {
        method: 'DELETE',
        ...(revision === undefined ? {} : { headers: { 'if-match': String(revision) } }),
      },
    ),
  /** 붙어 있는 첨부를 내려받는다. 링크가 아니라 fetch로 가져온다(토큰 때문) */
  downloadAttachment: async (
    packageId: string,
    submodelId: string,
    idShortPath: string,
    filename: string,
  ): Promise<void> => {
    const response = await fetch(
      `/packages/${packageId}/api/v3.0/submodels/${encodeIdentifier(submodelId)}` +
        `/submodel-elements/${idShortPath}/attachment`,
      withAuth(),
    );
    if (!response.ok) throw await toError(response);
    saveBlob(await response.blob(), filename);
  },
  importSubmodel: (
    packageId: string,
    sourcePackageId: string,
    submodelId: string,
    /** 같은 idShort가 이미 있을 때 — 기본은 거절(409) */
    onDuplicate: 'reject' | 'replace' | 'alongside' = 'reject',
  ): Promise<{
    submodelId: string;
    renamedFrom?: string;
    copiedConceptDescriptions: number;
    replaced?: string[];
    idShort?: string;
  }> =>
    request(`/packages/${packageId}/import-submodel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sourcePackageId, submodelId, onDuplicate }),
    }),
};
