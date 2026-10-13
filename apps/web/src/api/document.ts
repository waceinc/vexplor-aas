/**
 * API 클라이언트 — 파일 목록 · 올리기 · 검사 · 자동 고치기 · 되돌리기 · 이력 · 규칙과 규약
 * src/api.ts 에서 떼어 냈다(2026-10-13 컴포넌트화) — 코드와 주석은 옮기기 전 글자 그대로다. 밖에서는 api.ts 로 쓴다.
 */
import type { PackageDescription, UndoStatus, HistoryEntry, LintReport, FixReport, RuleCatalog, Policy, SubmodelRequirement } from './types.js';
import { encodeIdentifier, request } from './http.js';
import type { Submodel } from '../model.js';

export const documentApi = {
  listPackages: (): Promise<{ result: PackageDescription[] }> => request('/packages'),
  upload: (file: File): Promise<PackageDescription> =>
    request(`/packages?name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: file,
    }),
  remove: (packageId: string): Promise<void> =>
    request(`/packages/${packageId}`, { method: 'DELETE' }),
  submodels: (packageId: string): Promise<{ result: Submodel[] }> =>
    request(`/packages/${packageId}/api/v3.0/submodels?limit=1000`),
  lint: (packageId: string): Promise<LintReport> =>
    request(`/packages/${packageId}/lint?detail=true`),
  // 고칠 수 있는 경고(AASd-120 등)도 함께 — 파일마다 늘 「경고 1건」이 남아 있었다(2026-09-07)
  fix: (packageId: string, select?: { ruleId: string; pointer: string }[]): Promise<FixReport> =>
    request(
      `/packages/${packageId}/fix?includeWarnings=1`,
      select
        ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ select }) }
        : { method: 'POST' },
    ),
  /** 무엇을 어떻게 고칠지 — 저장하지 않고 계산만. 팝업이 항목별 전/후를 그린다 */
  fixPreview: (packageId: string): Promise<FixReport> => request(`/packages/${packageId}/fix-preview?includeWarnings=1`),
  /** IRI 이관 대장(새 IRI → 원본 IRI) — 파일 안 파트에 쌓인 것 */
  /** 템플릿 요구 수준 — 서브모델마다 「필수 · 선택」(템플릿이 있는 것만) */
  requirements: (packageId: string): Promise<{ result: SubmodelRequirement[]; templates: number }> =>
    request(`/packages/${packageId}/requirements`),
  relocations: (packageId: string): Promise<{ relocations: Record<string, string> }> =>
    request(`/packages/${packageId}/relocations`),
  /** 원본 IRI로 되돌리기 — 규정 해석이 뒤집혔을 때 */
  revertRelocations: (
    packageId: string,
  ): Promise<{ reverted: { iri: string; original: string; how: string }[]; remaining: Record<string, string> }> =>
    request(`/packages/${packageId}/relocations/revert`, { method: 'POST' }),
  revisions: (
    packageId: string,
  ): Promise<{
    package: number;
    Submodel: Record<string, number>;
    AssetAdministrationShell: Record<string, number>;
  }> => request(`/packages/${packageId}/revisions`),
  /**
   * $value 수정 — A안에서 이 경로는 저작 편집이다(파일까지 남는다).
   * revision을 주면 If-Match로 보내 다른 사람이 먼저 고친 것을 덮어쓰지 않는다.
   */
  /** 되돌리기 스택 — 최근 것이 앞. 라벨은 사람 말("「SerialNumber」 지움") */
  undoStatus: (packageId: string): Promise<UndoStatus> => request(`/packages/${packageId}/undo`),
  /** 방금 변경을 되돌린다. 돌릴 것이 없으면 409 */
  undo: (packageId: string): Promise<UndoStatus & { undone: string }> =>
    request(`/packages/${packageId}/undo`, { method: 'POST' }),
  redo: (packageId: string): Promise<UndoStatus & { redone: string }> =>
    request(`/packages/${packageId}/redo`, { method: 'POST' }),
  /** 서브모델의 변경 이력 — 최신이 앞. 되돌리기의 재료다 */
  history: (
    packageId: string,
    submodelId: string,
  ): Promise<{ result: HistoryEntry[] }> =>
    request(`/packages/${packageId}/history/${encodeIdentifier(submodelId)}`),
  /** 이력의 한 판으로 서브모델을 되돌린다 */
  restore: (packageId: string, submodelId: string, changedAt: string): Promise<void> =>
    request(`/packages/${packageId}/history/${encodeIdentifier(submodelId)}/restore`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ changedAt }),
    }),
  policy: (packageId: string): Promise<Policy> => request(`/packages/${packageId}/policy`),
  /** 이 도구가 지키는 규칙과 규약 — 지금 도는 것을 그대로 받는다 */
  rules: (): Promise<RuleCatalog> => request('/rules'),
  /** 파일이 하나도 없을 때도 규약이 필요하다 — 첫 화면의 「새 설비 만들기」 */
  globalPolicy: (): Promise<Policy> => request('/policy'),
  /** 규칙대로 된 새 설비 뼈대를 만든다. 무엇이 들어가는지는 서버(린터 정책)가 정한다 */
  createPackage: (
    assetName: string,
    extraSubmodels: string[],
    unit: 'equipment' | 'composite' = 'equipment',
  ): Promise<PackageDescription> =>
    request('/packages/new', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ assetName, extraSubmodels, unit }),
    }),
  /**
   * 목록에서 파일 하나를 지운다.
   * 🔴 되돌릴 수 없다. 서버에 보관된 것이 사라지는 것이며, 내려받아 둔 .aasx는 남는다.
   */
  deletePackage: (packageId: string): Promise<void> =>
    request(`/packages/${packageId}`, { method: 'DELETE' }),
};
