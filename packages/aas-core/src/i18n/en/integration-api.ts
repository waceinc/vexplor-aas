/** English dictionary — integration api (owned by WP3, docs/design/integration-v1.md §13). Key = the original Korean text verbatim */
export const EN_INTEGRATION_API: Record<string, string> = {
  // Boot and status
  'INTEGRATIONS=on이 아닙니다 — 이벤트 기록과 피드만 동작합니다.': 'INTEGRATIONS=on is not set — only event recording and the feed work.',
  '체험판(DEMO_MODE=on)에서는 연동을 켜지 않습니다.': 'Integrations are not started in trial mode (DEMO_MODE=on).',
  '이 저장소는 연동 기능을 지원하지 않습니다.': 'This store does not support integrations.',
  '웹훅 비밀값을 잠그는 키: {0} — 데이터 폴더 백업에 이 키도 들어갑니다.':
    'Key that seals webhook secrets: {0} — backups of the data folder contain this key too.',
  '연동 기록 정리 실패: {0}': 'Integration log cleanup failed: {0}',
  '{0} — 연동 작업을 정리하고 끕니다.': '{0} — finishing integration work and shutting down.',
  '연동(INTEGRATIONS=on) 켜짐 — 구독한 곳으로 웹훅·MQTT 이벤트를 보냅니다 · GET /integrations/status':
    'Integrations (INTEGRATIONS=on) on — events go to subscribers by webhook / MQTT · GET /integrations/status',
  '사내 대상 허용(AAS_INTEGRATION_ALLOW): {0}': 'Internal targets allowed (AAS_INTEGRATION_ALLOW): {0}',
  '사내 주소로는 보내지 않습니다 — 허용하려면 AAS_INTEGRATION_ALLOW=<CIDR·호스트>':
    'Nothing is sent to internal addresses — to allow some, AAS_INTEGRATION_ALLOW=<CIDR / host>',
  '연동 이벤트는 기록됩니다 · GET /integrations/events — 웹훅·MQTT 전송은 INTEGRATIONS=on':
    'Integration events are recorded · GET /integrations/events — webhook / MQTT delivery needs INTEGRATIONS=on',
  'AAS_SECRET_KEY가 없어 웹훅 구독을 만들 수 없습니다 (PostgreSQL). openssl rand -base64 32로 만든 값을 주십시오.':
    'Without AAS_SECRET_KEY no webhook subscription can be created (PostgreSQL). Provide a value made with openssl rand -base64 32.',
  '메모리 저장소 — 구독의 서명 비밀값은 서버를 끄면 쓸 수 없게 됩니다.':
    'Memory store — subscription signing secrets become unusable when the server stops.',

  // Egress policy
  'AAS_INTEGRATION_ALLOW 항목을 읽지 못했습니다: {0}': 'Could not read the AAS_INTEGRATION_ALLOW entry: {0}',
  '주소를 읽지 못했습니다: {0}': 'Could not read the address: {0}',
  '{0} 구독에는 {1} 주소만 쓸 수 있습니다.': 'A {0} subscription accepts only {1} addresses.',
  '웹훅 주소에는 사용자 이름이나 비밀번호를 넣을 수 없습니다.': 'A webhook address cannot contain a user name or password.',
  '체험판에서는 외부로 연결하지 않습니다.': 'The trial edition makes no outbound connections.',
  '{0}은(는) 이 서버 자신입니다 — 연결하지 않습니다.': '{0} is this server itself — not connecting.',
  '{0}의 주소를 찾지 못했습니다: {1}': 'Could not resolve {0}: {1}',
  '{0}({1})은(는) 루프백·링크 로컬·멀티캐스트 주소라 연결하지 않습니다.':
    '{0} ({1}) is a loopback, link-local or multicast address — not connecting.',
  '{0}({1})은(는) 사내 주소입니다 — AAS_INTEGRATION_ALLOW에 적어야 연결합니다.':
    '{0} ({1}) is an internal address — it must be listed in AAS_INTEGRATION_ALLOW.',
  '암호화하지 않은 연결({0})은 AAS_INTEGRATION_ALLOW에 적은 대상에만 씁니다.':
    'Unencrypted connections ({0}) are used only for targets listed in AAS_INTEGRATION_ALLOW.',
  '포트 {0}은(는) 다른 서비스가 쓰는 포트라 막혀 있습니다 — AAS_INTEGRATION_ALLOW에 그 포트까지 적어야 합니다.':
    'Port {0} belongs to another kind of service and is blocked — the AAS_INTEGRATION_ALLOW entry must name that port.',

  // Secrets
  '비밀 키는 {0}바이트여야 합니다.': 'The secret key must be {0} bytes.',
  '다른 비밀 키로 잠근 값입니다 (키 {0}). AAS_SECRET_KEY를 확인하십시오.':
    'This value was sealed with a different key (key {0}). Check AAS_SECRET_KEY.',
  'AAS_SECRET_KEY는 32바이트를 base64로 적은 값이어야 합니다 (예: openssl rand -base64 32).':
    'AAS_SECRET_KEY must be 32 bytes written as base64 (e.g. openssl rand -base64 32).',

  // Routes
  '연동 구독은 관리자만 다룹니다 — 먼저 관리자 계정을 만들고 로그인하십시오.':
    'Only an admin manages integration subscriptions — create an admin account first and log in.',
  '연동 구독은 관리자 계정으로 로그인해야 다룰 수 있습니다.': 'Integration subscriptions require logging in with an admin account.',
  '{0}은(는) {1}~{2} 사이의 정수여야 합니다.': '{0} must be an integer between {1} and {2}.',
  '연동이 꺼져 있습니다 — 서버를 INTEGRATIONS=on으로 띄우십시오.': 'Integrations are off — start the server with INTEGRATIONS=on.',
  '요청한 위치({0}) 이후의 이벤트 일부가 보존 기간이 지나 지워졌습니다. 가장 오래된 이벤트는 {1}번입니다 — 내보내기로 전체를 다시 받으십시오.':
    'Some events after the requested position ({0}) passed the retention period and were removed. The oldest event is number {1} — fetch everything again through the exports.',
  '알 수 없는 이벤트 종류입니다: {0}': 'Unknown event type: {0}',
  '비밀값을 잠글 키가 없습니다 — PostgreSQL을 쓸 때는 AAS_SECRET_KEY를 주고 다시 띄우십시오.':
    'There is no key to seal secrets — with PostgreSQL, set AAS_SECRET_KEY and restart.',
  '연결할 수 없는 대상입니다: {0}': 'Target not allowed: {0}',
  '구독을 찾을 수 없습니다: {0}': 'Subscription not found: {0}',
  'status는 {0} 중 하나여야 합니다.': 'status must be one of {0}.',
  '전송 기록을 찾을 수 없습니다: {0}': 'Delivery not found: {0}',
  '{0}은(는) 비어 있지 않은 문자열의 목록이어야 합니다.': '{0} must be a list of non-empty strings.',
  'options는 객체여야 합니다.': 'options must be an object.',
  'topicPrefix는 200자 이하이고 +, #, NUL 문자가 없어야 합니다.': 'topicPrefix must be at most 200 characters and contain no +, # or NUL.',
  'retainState는 true 또는 false여야 합니다.': 'retainState must be true or false.',
  '알 수 없는 항목입니다: {0}': 'Unknown field: {0}',
  '본문은 JSON 객체여야 합니다.': 'The body must be a JSON object.',
  'name은 1~200자여야 합니다.': 'name must be 1 to 200 characters.',
  'kind는 webhook 또는 mqtt여야 합니다.': 'kind must be webhook or mqtt.',
  'url이 비어 있거나 너무 깁니다.': 'url is empty or too long.',
  'types에 받을 이벤트 종류를 하나 이상 적으십시오 (모두 받으려면 "*").': 'List at least one event type in types (use "*" for all).',
  '보낼 수 있는 이벤트 종류가 아닙니다: {0}': 'Not a deliverable event type: {0}',
  'enabled는 true 또는 false여야 합니다.': 'enabled must be true or false.',
  '{0}이(가) 없습니다.': '{0} is missing.',
  'fromSeq 또는 from 중 하나만 주십시오.': 'Give exactly one of fromSeq or from.',
  'fromSeq는 1 이상의 정수여야 합니다.': 'fromSeq must be an integer of at least 1.',
  '시각을 읽지 못했습니다: {0}': 'Could not read the time: {0}',

  // Discovery fix (routes/registry.ts)
  'SpecificAssetId.name이 필요합니다.': 'SpecificAssetId.name is required.',
};
