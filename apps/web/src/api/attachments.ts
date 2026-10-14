/**
 * API client — attachments · importing submodels from another file
 * Split out of src/api.ts (2026-10-13 componentization) — code and comments are verbatim from before the move. Import it via api.ts.
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
  /** Downloads an attached file. Fetched rather than linked (because of the token) */
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
    /** When the same idShort already exists — rejected by default (409) */
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
