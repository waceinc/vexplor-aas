/**
 * API client — downloads · reference bundles · validation report
 * Split out of src/api.ts (2026-10-13 componentization) — code and comments are verbatim from before the move. Import it via api.ts.
 */
import type { BundleView, BundleImportView, ExportPreview, MetamodelVersion } from './types.js';
import { withAuth, request, toError, filenameOf, saveBlob } from './http.js';

export const bundleApi = {
  /**
   * Downloads and reports are fetched, not linked.
   * `<a href>` cannot carry headers, so with auth enabled it gets 401, and putting the token in the URL
   * leaves it verbatim in server logs and browser history.
   */
  download: async (packageId: string, options: { metamodel?: MetamodelVersion; keep?: boolean } = {}): Promise<void> => {
    const query = new URLSearchParams({
      ...(options.metamodel ? { metamodel: options.metamodel } : {}),
      ...(options.keep ? { unrepresentable: 'keep' } : {}),
    }).toString();
    const response = await fetch(`/packages/${packageId}${query ? `?${query}` : ''}`, withAuth());
    if (!response.ok) throw await toError(response);
    saveBlob(await response.blob(), filenameOf(response) ?? 'download.aasx');
  },
  /** What a download as `metamodel` would drop, refuse or rename — shown before downloading */
  exportPreview: (packageId: string, metamodel: MetamodelVersion): Promise<ExportPreview> =>
    request(`/packages/${packageId}/export-report?metamodel=${metamodel}`),
  /** Reference bundle — composition · readiness · linked items */
  bundle: (packageId: string, evidenceMinutes = ''): Promise<BundleView> =>
    request(`/packages/${packageId}/bundle/linkage${evidenceMinutes ? `?evidenceMinutes=${evidenceMinutes}` : ''}`),
  /** Upload a bundle attachment — path is folder/filename */
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
  /** Opens a bundle ZIP — processes and assets are uploaded in one go and hashes are checked */
  openBundle: (file: File, options: { metamodel?: MetamodelVersion } = {}): Promise<BundleImportView> =>
    request(`/bundles${options.metamodel ? `?metamodel=${options.metamodel}` : ''}`, {
      method: 'POST',
      headers: { 'content-type': 'application/zip' },
      body: file,
    }),
  openReport: async (packageId: string): Promise<void> => {
    const response = await fetch(`/packages/${packageId}/report`, withAuth());
    if (!response.ok) throw await toError(response);
    const url = URL.createObjectURL(await response.blob());
    globalThis.open(url, '_blank', 'noreferrer');
    // Release once the new tab has finished reading
    globalThis.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  },
};
