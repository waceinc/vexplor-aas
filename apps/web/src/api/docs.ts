/**
 * API client — document data — UML diagrams · component tables
 * Split out of src/api.ts (2026-10-13 componentization) — code and comments are verbatim from before the move. Import it via api.ts.
 */
import type { DocPlan, TableRow, SmtTable, SubmodelInfo } from './types.js';
import { withAuth, request, toError, filenameOf, saveBlob } from './http.js';

export const docsApi = {
  /**
   * Upload an attachment — the **actual file** a File/Blob element points to (manual PDF, drawing, etc.).
   *
   * The server creates the part inside the package and updates `File.value` as well. The browser only uploads bytes.
   * Important: the filename goes in a query parameter — because the body must be the raw file bytes.
   */
  /**
   * UML diagram (SVG string) to attach to the guidance.
   * Without `submodel`, the whole-AAS composition diagram.
   */
  diagram: async (packageId: string, submodel?: string): Promise<string> => {
    const query = submodel ? `?submodel=${encodeURIComponent(submodel)}` : '';
    const response = await fetch(`/packages/${packageId}/diagram.svg${query}`, withAuth());
    if (!response.ok) throw await toError(response);
    return await response.text();
  },
  /** Per submodel, whether to build a table or write info (regulation §13 caution 5) */
  docPlan: (packageId: string): Promise<{ result: DocPlan[] }> =>
    request(`/packages/${packageId}/doc-plan`),
  /** Detailed info table (for the screen). For non-table targets, info comes back */
  table: (
    packageId: string,
    submodel: string,
  ): Promise<{
    plan: DocPlan;
    rows?: TableRow[];
    tables?: SmtTable[];
    info?: SubmodelInfo;
    tableCount?: number;
  }> =>
    request(`/packages/${packageId}/table?submodel=${encodeURIComponent(submodel)}`),
  /** HTML table for pasting. `from` is the starting table number (must continue across the whole document) */
  tableHtml: async (packageId: string, submodel: string, from?: number): Promise<string> => {
    const response = await fetch(
      `/packages/${packageId}/table?submodel=${encodeURIComponent(submodel)}&format=html` +
        (from === undefined ? '' : `&from=${from}`),
      withAuth(),
    );
    if (!response.ok) throw await toError(response);
    return await response.text();
  },
  downloadTableCsv: async (packageId: string, submodel: string): Promise<void> => {
    const response = await fetch(
      `/packages/${packageId}/table?submodel=${encodeURIComponent(submodel)}&format=csv`,
      withAuth(),
    );
    if (!response.ok) throw await toError(response);
    saveBlob(await response.blob(), filenameOf(response) ?? `${submodel}.csv`);
  },
};
