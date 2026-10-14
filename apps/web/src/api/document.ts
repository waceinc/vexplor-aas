/**
 * API client — file list · upload · check · auto-fix · undo · history · rules and conventions
 * Split out of src/api.ts (2026-10-13 componentization) — code and comments are verbatim from before the move. Import it via api.ts.
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
  // Include fixable warnings too (AASd-120 etc.) — every file kept showing "1 warning" (2026-09-07)
  fix: (packageId: string, select?: { ruleId: string; pointer: string }[]): Promise<FixReport> =>
    request(
      `/packages/${packageId}/fix?includeWarnings=1`,
      select
        ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ select }) }
        : { method: 'POST' },
    ),
  /** What would be fixed and how — computed only, nothing saved. The popup draws before/after per item */
  fixPreview: (packageId: string): Promise<FixReport> => request(`/packages/${packageId}/fix-preview?includeWarnings=1`),
  /** Template requirement level — per submodel, "required · optional" (only those with a template) */
  requirements: (packageId: string): Promise<{ result: SubmodelRequirement[]; templates: number }> =>
    request(`/packages/${packageId}/requirements`),
  /** IRI migration ledger (new IRI → original IRI) — accumulated in a part inside the file */
  relocations: (packageId: string): Promise<{ relocations: Record<string, string> }> =>
    request(`/packages/${packageId}/relocations`),
  /** Revert to the original IRI — when the interpretation of the regulation is reversed */
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
   * $value edit — under option A this path is an authoring edit (it persists to the file).
   * When revision is given it is sent as If-Match so an edit someone else made first is not overwritten.
   */
  /** Undo stack — most recent first. Labels are human-readable ("deleted 'SerialNumber'") */
  undoStatus: (packageId: string): Promise<UndoStatus> => request(`/packages/${packageId}/undo`),
  /** Undo the latest change. 409 when there is nothing to undo */
  undo: (packageId: string): Promise<UndoStatus & { undone: string }> =>
    request(`/packages/${packageId}/undo`, { method: 'POST' }),
  redo: (packageId: string): Promise<UndoStatus & { redone: string }> =>
    request(`/packages/${packageId}/redo`, { method: 'POST' }),
  /** Change history of a submodel — newest first. The source for reverting */
  history: (
    packageId: string,
    submodelId: string,
  ): Promise<{ result: HistoryEntry[] }> =>
    request(`/packages/${packageId}/history/${encodeIdentifier(submodelId)}`),
  /** Revert the submodel to one version from the history */
  restore: (packageId: string, submodelId: string, changedAt: string): Promise<void> =>
    request(`/packages/${packageId}/history/${encodeIdentifier(submodelId)}/restore`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ changedAt }),
    }),
  policy: (packageId: string): Promise<Policy> => request(`/packages/${packageId}/policy`),
  /** The rules and conventions this tool enforces — received exactly as currently running */
  rules: (): Promise<RuleCatalog> => request('/rules'),
  /** Conventions are needed even when there are no files — the first screen's "Create new asset" */
  globalPolicy: (): Promise<Policy> => request('/policy'),
  /** Create a new asset skeleton that follows the rules. What goes in is decided by the server (linter policy) */
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
   * Deletes one file from the list.
   * Important: irreversible. What is stored on the server is gone; .aasx files already downloaded remain.
   */
  deletePackage: (packageId: string): Promise<void> =>
    request(`/packages/${packageId}`, { method: 'DELETE' }),
};
