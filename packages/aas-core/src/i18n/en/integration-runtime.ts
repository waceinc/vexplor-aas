/** English dictionary — integration runtime (owned by WP2, docs/design/integration-v1.md §13). Key = the original Korean text verbatim */
export const EN_INTEGRATION_RUNTIME: Record<string, string> = {
  // OPC UA server security
  '보안 모드 OPC UA 서버에는 사용자 확인 함수가 필요합니다.': 'A secure-mode OPC UA server needs a user check function.',
  // MQTT publisher and wire
  'MQTT 연결이 닫혀 있습니다.': 'The MQTT connection is closed.',
  '응답을 기다리는 MQTT 메시지가 너무 많습니다.': 'Too many MQTT messages are waiting for an acknowledgement.',
  'MQTT 브로커가 {0}ms 안에 수신 확인(PUBACK)을 보내지 않았습니다.': 'The MQTT broker did not acknowledge (PUBACK) within {0} ms.',
  'MQTT 연결을 닫았습니다.': 'The MQTT connection was closed.',
  'MQTT 브로커와의 연결이 끊겼습니다.': 'The connection to the MQTT broker was lost.',
  'MQTT 주소는 mqtt:// 또는 mqtts:// 로 시작해야 합니다: {0}': 'An MQTT address must start with mqtt:// or mqtts://: {0}',
  'MQTT 주소에 사용자 정보를 넣지 마십시오. 사용자 이름과 비밀번호는 따로 줍니다.': 'Do not put user information in the MQTT address. Give the user name and password separately.',
  'QoS 1 메시지에는 1~65535 사이의 패킷 번호가 필요합니다.': 'A QoS 1 message needs a packet id between 1 and 65535.',
  '잘못된 MQTT PUBACK': 'Malformed MQTT PUBACK',
  // Integration configuration routes
  '연동 설정은 관리자 계정으로 로그인해야 바꿀 수 있습니다. 관리자 계정이 없으면 먼저 만드십시오.':
    'Integration settings can only be changed when signed in with an administrator account. If there is none, create one first.',
  '연동 설정은 관리자만 바꿀 수 있습니다.': 'Only administrators can change integration settings.',
  'If-Match 헤더는 "3"처럼 따옴표로 감싼 리비전 번호여야 합니다.': 'The If-Match header must be a revision number in quotes, such as "3".',
  'If-Match 헤더가 필요합니다. 먼저 읽은 리비전 번호를 "3"처럼 따옴표로 감싸 주십시오.': 'The If-Match header is required. Give the revision you read in quotes, such as "3".',
  '그사이에 다른 사람이 설정을 바꿨습니다. 다시 읽은 뒤 고치십시오.': 'Someone else changed the settings in the meantime. Read them again, then make your change.',
  // Runtime equipment data routes
  '{0} 값이 필요합니다.': 'A value for {0} is required.',
  '{0}은(는) ISO 8601 시각이어야 합니다: {1}': '{0} must be an ISO 8601 time: {1}',
  'to는 from보다 뒤여야 합니다.': 'to must be later than from.',
  '조회 기간은 31일 이하여야 합니다.': 'The period must be 31 days or shorter.',
  'packageId 값이 필요합니다.': 'A packageId is required.',
  '패키지 {0}의 연동 설정에 상태 태그가 없습니다. 먼저 상태 태그를 고르십시오.':
    'The integration settings of package {0} name no state tag. Choose a state tag first.',
  'day는 YYYY-MM-DD 형식이어야 합니다: {0}': 'day must have the form YYYY-MM-DD: {0}',
  '설정에 없는 교대입니다: {0}': 'No such shift in the settings: {0}',
  'counter 값이 필요합니다(카운터 ID 또는 runtime).': 'A counter is required (a counter id or runtime).',
  'period는 다음 중 하나여야 합니다: {0}': 'period must be one of: {0}',
  '교대가 설정되어 있지 않습니다.': 'No shifts are configured.',
  '연동 설정에 없는 카운터입니다: {0}': 'No such counter in the integration settings: {0}',
  // OPC UA certificate routes
  'OPC UA 서버가 꺼져 있거나 보안 없이 실행 중이라 인증서 저장소가 없습니다.':
    'There is no certificate store: the OPC UA server is off or runs without security.',
  '지문은 SHA-1 16진수 40자여야 합니다.': 'A thumbprint must be 40 hexadecimal characters (SHA-1).',
  '거부된 인증서 중에 지문 {0}인 것이 없습니다.': 'No rejected certificate has the thumbprint {0}.',
};
