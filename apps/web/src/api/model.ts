/**
 * API 클라이언트 — 모델 편집 — 값 · 요소 · 서브모델 · AAS · 용어 · 대표 사진 · 구성(계층)
 * src/api.ts 에서 떼어 냈다(2026-10-13 컴포넌트화) — 코드와 주석은 옮기기 전 글자 그대로다. 밖에서는 api.ts 로 쓴다.
 */
import type { PackageDescription, HierarchyView } from './types.js';
import { encodeIdentifier, withAuth, request } from './http.js';
import type { ConceptDescription, Shell } from '../model.js';

export const modelApi = {
  /** AAS의 assetInformation 교체 — assetKind·globalAssetId가 여기 산다(KOSMO-AAS-5·6) */
  /**
   * 용어(CD) 정의 저장 — 규격의 PUT(통째 교체). 먼저 지금 판의 ETag를 읽어 If-Match로 보낸다.
   * CD는 revisions 목록에 없어서 이 방법으로 남의 편집을 덮어쓰지 않는다.
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
   * 대표 사진(썸네일) 올리기 — KOSMO-AAS-1의 그 파일이다.
   * 뼈대의 임시 그림을 실제 장비 사진으로 바꾸는 자리. 서버가 defaultThumbnail 경로와
   * 이전 파트 정리까지 처리한다.
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
  /** 공정의 계층을 읽는다. 설비 파일도 부품 계층을 갖고 있어 같은 자리에서 읽힌다 */
  hierarchy: (packageId: string): Promise<HierarchyView> =>
    request(`/packages/${packageId}/hierarchy`),
  /**
   * 설비를 매단다.
   * 🔴 `sourcePackageId`를 주면 이름과 Asset 주소를 **서버가 그 파일에서 읽는다** —
   *    사람이 옮겨 적다 틀리면 두 파일을 잇는 끈이 조용히 끊긴다.
   */
  addHierarchyNode: (
    packageId: string,
    input: {
      sourcePackageId?: string;
      name?: string;
      globalAssetId?: string;
      bulkCount?: number;
      /** 파일 없는 중간 마디(공정·그룹)를 만들 때 */
      group?: boolean;
      /** 어느 마디 밑에 넣을지 — 진입점부터의 이름 경로 */
      parentPath?: string[];
    },
  ): Promise<{ name: string; globalAssetId?: string }> =>
    request(`/packages/${packageId}/hierarchy/nodes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }),
  /**
   * 파일 복제 — 호기별로 나누기의 실체. 서브모델·첨부까지 통째로 복사하고
   * id는 새 이름으로 개명된 새 파일(packageId)을 돌려받는다.
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
  /** parentPath가 없으면 서브모델 바로 아래에 붙인다 */
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
  /** 요소 전체를 바꾼다 — semanticId처럼 $value로 못 고치는 것에 쓴다 */
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
  /** 요소를 형제 안에서 옮긴다(규격 밖 연산). `{offset}` -1=위·1=아래 한 칸, `{to}` n번째 자리로 */
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
  /** 요소를 바로 아래에 복제한다(규격 밖). 이름은 서버가 `X_2`로 짓는다 */
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
  /** 서브모델 부분 갱신 — 이름(idShort) 바꾸기에 쓴다 */
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
