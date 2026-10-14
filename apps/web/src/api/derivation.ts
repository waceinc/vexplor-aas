/**
 * API client — type → unit derivation. Files created by splitting per unit pull in changes from the type file.
 * Server side is apps/api/src/routes/derivation.ts. Import it via api.ts.
 */
import type { DerivationView } from './types.js';
import { request } from './http.js';

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export const derivationApi = {
  /** Connection status and pending changes — computed only, nothing saved */
  derivation: (packageId: string): Promise<DerivationView> => request(`/packages/${packageId}/derivation`),
  /** Apply only the selected rows (all pending changes when keys is absent) — recorded in the undo list as "Apply type changes" */
  applyDerivation: (packageId: string, keys?: readonly string[]): Promise<{ applied: number; submodels: number; skipped: number }> =>
    request(`/packages/${packageId}/derivation/apply`, json('POST', keys ? { keys } : {})),
  /** Connect to a type file — the baseline is the type as of connection time */
  linkDerivation: (packageId: string, sourcePackageId: string): Promise<DerivationView> =>
    request(`/packages/${packageId}/derivation`, json('PUT', { sourcePackageId })),
  unlinkDerivation: (packageId: string): Promise<void> => request(`/packages/${packageId}/derivation`, { method: 'DELETE' }),
};
