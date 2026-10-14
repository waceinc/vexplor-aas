/** English dictionary — integration store (owned by WP1, docs/design/integration-v1.md §13). Key = the original Korean text verbatim */
export const EN_INTEGRATION_STORE: Record<string, string> = {
  // ── workspace layer (packages/store/src/scoped.ts) ──
  '연동 구독·전달·이벤트 기록은 서버 관리 쪽에서만 다룰 수 있습니다.':
    'Integration subscriptions, deliveries and the event log can only be managed on the server side.',
  '다른 작업 공간의 파일': 'a file in another workspace',
};
