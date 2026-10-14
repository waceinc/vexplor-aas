/**
 * API client — model editing — values · elements · submodels · AAS · terms · thumbnail · composition (hierarchy)
 * Split out of src/api.ts (2026-10-13 componentization) — code and comments are verbatim from before the move. Import it via api.ts.
 */
import type { PackageDescription, HierarchyView } from './types.js';
import { encodeIdentifier, withAuth, request } from './http.js';
import type { ConceptDescription, Shell } from '../model.js';

export const modelApi = {
  /** Replace the AAS assetInformation — assetKind and globalAssetId live here (KOSMO-AAS-5·6) */
  /**
   * Save a term (CD) definition — the spec's PUT (whole replace). First reads the current ETag and sends it as If-Match.
   * CDs are not in the revisions list, so this is how we avoid overwriting someone else's edit.
   */
  putConceptDescription: async (packageId: string, concept: Record<string, unknown>): Promise<void> => {
    const path = `/packages/${packageId}/api/v3.0/concept-descriptions/${encodeIdentifier(String(concept['id']))}`;
    const current = await fetch(path, withAuth());
    const etag = current.ok ? current.headers.get('etag') : null;
    await request(path, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', ...(etag ? { 'if-match': etag } : {}) },
      body: JSON.stringify(concept),
    });
  },
  putAssetInformation: (
    packageId: string,
    aasId: string,
    info: unknown,
    revision?: number,
  ): Promise<void> =>
    request(
      `/packages/${packageId}/api/v3.0/shells/${encodeIdentifier(aasId)}/asset-information`,
      {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          ...(revision === undefined ? {} : { 'if-match': String(revision) }),
        },
        body: JSON.stringify(info),
      },
    ),
  patchValue: (
    packageId: string,
    submodelId: string,
    idShortPath: string,
    value: unknown,
    revision?: number,
  ): Promise<void> =>
    request(
      `/packages/${packageId}/api/v3.0/submodels/${encodeIdentifier(submodelId)}` +
        `/submodel-elements/${idShortPath}/$value`,
      {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          ...(revision === undefined ? {} : { 'if-match': String(revision) }),
        },
        body: JSON.stringify(value),
      },
    ),
  /**
   * Upload the thumbnail — the very file KOSMO-AAS-1 refers to.
   * This is where the skeleton's placeholder picture is replaced with a real equipment photo. The server handles the defaultThumbnail path
   * and cleanup of the previous part.
   */
  putThumbnail: (packageId: string, shellId: string, file: File, revision?: number): Promise<void> =>
    request(
      `/packages/${packageId}/api/v3.0/shells/${encodeIdentifier(shellId)}` +
        `/asset-information/thumbnail?fileName=${encodeURIComponent(file.name)}`,
      {
        method: 'PUT',
        headers: {
          'content-type': file.type || 'application/octet-stream',
          ...(revision === undefined ? {} : { 'if-match': String(revision) }),
        },
        body: file,
      },
    ),
  /** Reads the process hierarchy. Asset files also have a parts hierarchy, so they are read the same way */
  hierarchy: (packageId: string): Promise<HierarchyView> =>
    request(`/packages/${packageId}/hierarchy`),
  /**
   * Attaches an asset.
   * Important: when `sourcePackageId` is given, **the server reads** the name and Asset address from that file —
   *    if a person copies them by hand and makes a typo, the link between the two files silently breaks.
   */
  addHierarchyNode: (
    packageId: string,
    input: {
      sourcePackageId?: string;
      name?: string;
      globalAssetId?: string;
      bulkCount?: number;
      /** When creating an intermediate node without a file (process · group) */
      group?: boolean;
      /** Whether that group is a line level — only at the top (directly under the company) */
      line?: boolean;
      /** Which node to insert under — name path from the entry point */
      parentPath?: string[];
    },
  ): Promise<{ name: string; globalAssetId?: string }> =>
    request(`/packages/${packageId}/hierarchy/nodes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }),
  /**
   * Duplicate a file — what "split per unit" actually does. Copies everything including submodels and attachments,
   * and gets back a new file (packageId) whose ids are renamed.
   */
  clonePackage: (packageId: string, assetName: string): Promise<PackageDescription> =>
    request(`/packages/${packageId}/clone`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ assetName }),
    }),
  removeHierarchyNode: (packageId: string, name: string, parentPath: string[] = []): Promise<void> =>
    request(
      `/packages/${packageId}/hierarchy/nodes/${encodeURIComponent(name)}` +
        (parentPath.length > 0 ? `?parent=${encodeURIComponent(parentPath.join('/'))}` : ''),
      { method: 'DELETE' },
    ),
  shells: (packageId: string): Promise<{ result: Shell[] }> =>
    request(`/packages/${packageId}/api/v3.0/shells`),
  addSubmodelRef: (packageId: string, aasId: string, submodelId: string): Promise<unknown> =>
    request(`/packages/${packageId}/api/v3.0/shells/${encodeIdentifier(aasId)}/submodel-refs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'ModelReference',
        keys: [{ type: 'Submodel', value: submodelId }],
      }),
    }),
  removeSubmodelRef: (packageId: string, aasId: string, submodelId: string): Promise<void> =>
    request(
      `/packages/${packageId}/api/v3.0/shells/${encodeIdentifier(aasId)}` +
        `/submodel-refs/${encodeIdentifier(submodelId)}`,
      { method: 'DELETE' },
    ),
  createSubmodel: (packageId: string, content: unknown): Promise<unknown> =>
    request(`/packages/${packageId}/api/v3.0/submodels`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(content),
    }),
  deleteSubmodel: (packageId: string, submodelId: string): Promise<void> =>
    request(`/packages/${packageId}/api/v3.0/submodels/${encodeIdentifier(submodelId)}`, {
      method: 'DELETE',
    }),
  /** Without parentPath it is attached directly under the submodel */
  createElement: (
    packageId: string,
    submodelId: string,
    parentPath: string | undefined,
    content: unknown,
  ): Promise<unknown> =>
    request(
      `/packages/${packageId}/api/v3.0/submodels/${encodeIdentifier(submodelId)}/submodel-elements` +
        (parentPath ? `/${parentPath}` : ''),
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(content),
      },
    ),
  deleteElement: (packageId: string, submodelId: string, idShortPath: string): Promise<void> =>
    request(
      `/packages/${packageId}/api/v3.0/submodels/${encodeIdentifier(submodelId)}` +
        `/submodel-elements/${idShortPath}`,
      { method: 'DELETE' },
    ),
  conceptDescriptions: (packageId: string): Promise<{ result: ConceptDescription[] }> =>
    request(`/packages/${packageId}/api/v3.0/concept-descriptions?limit=2000`),
  /** Replace the whole element — for things $value cannot change, such as semanticId */
  putElement: (
    packageId: string,
    submodelId: string,
    idShortPath: string,
    content: unknown,
    revision?: number,
  ): Promise<void> =>
    request(
      `/packages/${packageId}/api/v3.0/submodels/${encodeIdentifier(submodelId)}` +
        `/submodel-elements/${idShortPath}`,
      {
        method: 'PUT',
        headers: {
          'content-type': 'application/json',
          ...(revision === undefined ? {} : { 'if-match': String(revision) }),
        },
        body: JSON.stringify(content),
      },
    ),
  /** Moves an element among its siblings (non-spec operation). `{offset}` -1=up · 1=down one step, `{to}` to the n-th position */
  moveElement: (
    packageId: string,
    submodelId: string,
    idShortPath: string,
    move: { offset: -1 | 1 } | { to: number },
    revision?: number,
  ): Promise<void> =>
    request(
      `/packages/${packageId}/api/v3.0/submodels/${encodeIdentifier(submodelId)}` +
        `/submodel-elements/${idShortPath}/move`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(revision === undefined ? {} : { 'if-match': String(revision) }),
        },
        body: JSON.stringify(move),
      },
    ),
  /** Duplicates an element directly below it (non-spec). The server names it `X_2` */
  duplicateElement: (
    packageId: string,
    submodelId: string,
    idShortPath: string,
    revision?: number,
  ): Promise<{ idShort?: string }> =>
    request(
      `/packages/${packageId}/api/v3.0/submodels/${encodeIdentifier(submodelId)}` +
        `/submodel-elements/${idShortPath}/duplicate`,
      {
        method: 'POST',
        headers: revision === undefined ? {} : { 'if-match': String(revision) },
      },
    ),
  /** Partial submodel update — used for renaming (idShort) */
  patchSubmodel: (
    packageId: string,
    submodelId: string,
    patch: Record<string, unknown>,
    revision?: number,
  ): Promise<void> =>
    request(`/packages/${packageId}/api/v3.0/submodels/${encodeIdentifier(submodelId)}`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        ...(revision === undefined ? {} : { 'if-match': String(revision) }),
      },
      body: JSON.stringify(patch),
    }),
};
