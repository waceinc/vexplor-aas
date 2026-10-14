/**
 * API 클라이언트 — 형식 → 호기 반영. 호기별로 나누기로 만든 파일이 형식 파일의 변경을 받아 온다.
 * 서버는 apps/api/src/routes/derivation.ts. 밖에서는 api.ts 로 쓴다.
 */
import type { DerivationView } from './types.js';
import { request } from './http.js';

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export const derivationApi = {
  /** 연결 상태와 반영할 것 — 저장하지 않고 계산만 */
  derivation: (packageId: string): Promise<DerivationView> => request(`/packages/${packageId}/derivation`),
  /** 고른 줄만 반영(keys 가 없으면 반영할 것 전부) — 되돌리기 목록에 「형식 변경 반영」으로 남는다 */
  applyDerivation: (packageId: string, keys?: readonly string[]): Promise<{ applied: number; submodels: number; skipped: number }> =>
    request(`/packages/${packageId}/derivation/apply`, json('POST', keys ? { keys } : {})),
  /** 형식 파일에 연결 — 기준은 연결하는 때의 형식이다 */
  linkDerivation: (packageId: string, sourcePackageId: string): Promise<DerivationView> =>
    request(`/packages/${packageId}/derivation`, json('PUT', { sourcePackageId })),
  unlinkDerivation: (packageId: string): Promise<void> => request(`/packages/${packageId}/derivation`, { method: 'DELETE' }),
};
