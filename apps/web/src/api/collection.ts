/**
 * API 클라이언트 — 수집 — 연결(AID) · 수집값 · 표준 API 내보내기 · 자동 수집 · OPC UA 내주기 · 가상 PLC
 * src/api.ts 에서 떼어 냈다(2026-10-13 컴포넌트화) — 코드와 주석은 옮기기 전 글자 그대로다. 밖에서는 api.ts 로 쓴다.
 */
import type { AidInterfaceView, CollectedValueView, LiveMapping, CycleReportView } from './types.js';
import { request } from './http.js';

export const collectionApi = {
  interfaces: (packageId: string): Promise<{ source: string; interfaces: AidInterfaceView[] }> =>
    request(`/packages/${packageId}/interfaces`),
  values: (packageId: string, limit = 200): Promise<{ result: CollectedValueView[] }> =>
    request(`/packages/${packageId}/values?limit=${limit}`),
  /** 한 태그의 기간 값 — 하루 상태 막대가 쓴다. from 포함 · to 미포함(ISO), 수신 시각 기준(값이 일정한 태그도 잡힌다) */
  valuesBetween: (
    packageId: string,
    query: { property: string; from: string; to: string; limit?: number },
  ): Promise<{ result: CollectedValueView[] }> =>
    request(
      `/packages/${packageId}/values?property=${encodeURIComponent(query.property)}&from=${encodeURIComponent(query.from)}` +
        `&to=${encodeURIComponent(query.to)}&limit=${query.limit ?? 20000}&basis=received`,
    ),
  /**
   * 수집값이 모델의 어느 요소에 얹히는지 — 연결 상태 점검.
   * BaSyx DataBridge와 달리 우리는 모델에 되쓰지 않으므로, **이름이 맞는지**가 관건이다.
   */
  liveMapping: (
    packageId: string,
  ): Promise<LiveMapping> => request(`/packages/${packageId}/live`),
  /**
   * 수집 연결(AID) 만들기 — 접속 주소와 태그 목록으로 규격대로 짓는다.
   * 응답의 nameMisses는 모델 요소와 이름이 안 맞는 태그다(live 내보내기가 안 되는 것).
   */
  createAid: (
    packageId: string,
    input: {
      endpoint: string;
      title?: string;
      tags: { name: string; href: string; key?: string; type?: string; unit?: string; form?: Record<string, string> }[];
      /** 모델에 없는 태그의 자리를 OperationalData에 함께 세운다. 없으면 만들지 않는다 */
      createMissing?: { group: string; subgroup: string };
    },
  ): Promise<{
    submodelId: string;
    replaced: boolean;
    nameMatches: number;
    nameMisses: string[];
    elementsAdded: string[];
    /** 다른 서브모델에 같은 이름이 있어 만들지 않은 것 — 만들면 값이 어디에도 안 얹힌다 */
    elementsConflicted?: string[];
  }> =>
    request(`/packages/${packageId}/aid`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }),
  /** 자동 수집 상태 — 돌고는 있는 건가 */
  collectStatus: (): Promise<{
    /** 수집(과 가상 PLC)을 쓸 수 있는 서버인가 */
    collect?: boolean;
    running: boolean;
    intervalMs?: number;
    sweeping?: boolean;
    reason?: string;
    lastSweep?: {
      startedAt: string;
      collected: number;
      packages: number;
      results?: { packageId: string; collected: number; errors: string[] }[];
    };
  }> => request('/collect-status'),
  /**
   * 설비를 훑어 태그 목록을 가져온다 — NodeId를 손으로 치지 않게 하는 자리.
   * 못 붙으면 502와 사유가 온다.
   */
  browseDevice: (
    endpoint: string,
  ): Promise<{
    endpoint: string;
    truncated: boolean;
    nodes: {
      nodeId: string;
      name: string;
      path: string;
      type: 'float' | 'integer' | 'boolean' | 'string';
      value?: string;
      error?: string;
    }[];
  }> =>
    request('/opcua/browse', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ endpoint }),
    }),
  /**
   * OPC UA 노출 상태(M6·M7) — 우리가 지금 밖으로 무엇을 내주고 있는가.
   * 꺼져 있으면 running:false와 사유가 온다(오류가 아니다).
   */
  opcuaStatus: (): Promise<{
    running: boolean;
    endpoint?: string;
    packages: number;
    variables: number;
    lastRefresh?: string;
    lastError?: string;
    reason?: string;
  }> => request('/opcua-status'),
  /** 지금 한 번 수집한다. 수집 어댑터가 없는 배포에서는 501이 온다 */
  collect: (packageId: string): Promise<CycleReportView> =>
    request(`/packages/${packageId}/collect`, { method: 'POST' }),
  /** 내장 가상 PLC(시뮬레이션)에 이 설비를 붙이고 수집 연결을 만든다 */
  simulate: (packageId: string): Promise<{ machine: string; endpoint: string; title: string; tags: number }> =>
    request(`/packages/${packageId}/simulate`, { method: 'POST' }),
};
