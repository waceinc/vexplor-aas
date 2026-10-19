/** English dictionary — packages. Key = the original Korean text verbatim, value = English. Placeholders ({0} · <b>) must match the original exactly */
export const EN_PACKAGES: Record<string, string> = {
  // ── aasx — AASX reading · limits · XML ──
  'AASX ZIP을 열 수 없습니다: {0}': 'Cannot open the AASX ZIP: {0}',
  '[Content_Types].xml이 없습니다.': '[Content_Types].xml is missing.',
  '_rels/.rels가 없거나 비어 있습니다.': '_rels/.rels is missing or empty.',
  'aasx-origin 관계가 없습니다.': 'The aasx-origin relationship is missing.',
  'aas-spec 관계가 없습니다. {0}로 가정합니다.': 'The aas-spec relationship is missing. Assuming {0}.',
  'AAS 본문 파트를 찾을 수 없습니다: {0}': 'Cannot find the AAS spec part: {0}',
  'XML 버전을 읽었습니다({0}). 저장할 때는 JSON({1})으로 씁니다.': 'Read the XML version ({0}). Saving writes JSON ({1}).',
  '{0}의 XML 네임스페이스로 메타모델 버전을 알 수 없어 내용으로 추정했습니다(V{1}).':
    'The XML namespace of {0} does not name a known metamodel version — inferred from the content (V{1}).',
  '알 수 없는 본문 형식입니다: {0} (.json 또는 .xml)': 'Unknown spec format: {0} (.json or .xml)',
  '썸네일 관계는 있으나 파트가 없습니다: {0}': 'The thumbnail relationship exists but the part is missing: {0}',
  '첨부 파일 관계는 있으나 파트가 없습니다: {0}': 'The supplementary file relationship exists but the part is missing: {0}',
  '안전하지 않은 파트 경로입니다: {0}': 'Unsafe part path: {0}',
  '파트 개수가 상한({0}개)을 넘었습니다.': 'The number of parts exceeds the limit ({0}).',
  '파트 하나가 상한을 넘었습니다: {0} — {1}바이트 (상한 {2})': 'A part exceeds the limit: {0} — {1} bytes (limit {2})',
  '풀었을 때 크기가 상한({0}바이트)을 넘었습니다. 압축 폭탄일 수 있습니다.':
    'The uncompressed size exceeds the limit ({0} bytes). This may be a zip bomb.',
  'XML을 해석하지 못했습니다: {0}': 'Could not parse the XML: {0}',
  '<environment> 요소가 없습니다.': 'The <environment> element is missing.',
  'ZIP을 열 수 없습니다: {0}': 'Cannot open the ZIP: {0}',

  // ── store — store errors ──
  '{0}을(를) 찾을 수 없습니다.': '{0} not found.',
  '패키지 {0}': 'Package {0}',
  '파트 {0}': 'Part {0}',
  '패키지를 만들지 못했습니다.': 'Could not create the package.',
  '이미 있는 id입니다: {0}': 'This id already exists: {0}',
  '이미 있는 패키지 id입니다: {0}': 'This package id already exists: {0}',
  '본문의 modelType·id가 경로와 다릅니다: {0} {1}. id를 바꾸려면 참조 무결성 때문에 Quick Fix의 교정 경로를 쓰십시오.':
    'The modelType/id in the body differs from the path: {0} {1}. To change an id, use the Quick Fix correction path to keep references intact.',
  '로그인 이름이 비어 있습니다.': 'The login name is empty.',
  '이미 있는 로그인 이름입니다: {0}': 'This login name already exists: {0}',
  '패키지 id로 쓸 수 없는 값입니다: {0}':
    'This value cannot be used as a package id: {0}',
  '{0} 파트를 읽지 못했습니다: {1}':
    'Could not read the {0} part: {1}',
  '함께 쓰는 파일이라 고칠 수 없습니다 — 「다른 파일에서 가져오기」로 내 파일에 가져와 고치십시오.':
    'This is a shared file and cannot be edited — use "Import from another file" to bring it into your own file and edit it there.',
  '파일은 한 사람당 {0}개까지 올릴 수 있습니다 — 안 쓰는 파일을 지우고 다시 하십시오.':
    'Each person can upload up to {0} files — delete files you no longer use and try again.',
  '수집값 정리는 서버만 할 수 있습니다.': 'Only the server can prune collected values.',
  'modelType이 Identifiable 3종({0}) 중 하나여야 합니다: {1}': 'modelType must be one of the three Identifiable types ({0}): {1}',
  없음: 'none',
  'Identifiable에는 id가 있어야 합니다.': 'An Identifiable must have an id.',
  '리비전이 어긋납니다: 기대 {0}, 현재 {1}. 다시 읽고 편집하십시오.': 'Revision mismatch: expected {0}, current {1}. Reload and edit again.',

  // ── collector — building collection connections (AID) · collection ──
  '접속 주소는 opc.tcp:// · modbus+tcp:// · mqtt:// · s7:// · melsec:// 중 하나로 시작해야 합니다: {0}':
    'The endpoint must start with opc.tcp:// · modbus+tcp:// · mqtt:// · s7:// · melsec://: {0}',
  '태그가 하나도 없습니다.': 'There are no tags.',
  '태그 이름은 영문으로 시작하고 영문·숫자·밑줄만 씁니다: {0}':
    'A tag name must start with a letter and use only letters, digits and underscores: {0}',
  '태그 이름이 겹칩니다: {0}': 'Duplicate tag name: {0}',
  '{0}의 읽을 주소(NodeId)가 비었습니다.': 'The read address (NodeId) of {0} is empty.',
  '{0}의 Modbus 주소가 이상합니다: {1} — 예: 40 · 1/40 · 1/40?quantity=2':
    'The Modbus address of {0} is invalid: {1} — e.g. 40 · 1/40 · 1/40?quantity=2',
  '{0}의 MQTT 토픽에 와일드카드(+ #)를 쓸 수 없습니다: {1}': 'The MQTT topic of {0} cannot contain wildcards (+ #): {1}',
  '{0}에 쓸 수 없는 폼 항목입니다: {1}': 'This form field cannot be used on {0}: {1}',
  '{0}의 {1} 값이 이상합니다: {2} — 쓸 수 있는 것: {3}': 'The {1} value of {0} is invalid: {2} — allowed: {3}',
  '{0}의 타입이 이상합니다: {1} — 쓸 수 있는 것: {2}': 'The type of {0} is invalid: {1} — allowed: {2}',
  '{0} 제어반 ({1})': '{0} control panel ({1})',
  대분류: 'Category',
  소분류: 'Subcategory',
  '{0} 이름은 영문으로 시작하고 영문·숫자·밑줄만 씁니다: {1}':
    'The {0} name must start with a letter and use only letters, digits and underscores: {1}',
  '태그 이름이 요소 이름으로 쓸 수 없습니다: {0}': 'The tag name cannot be used as an element name: {0}',
  '(이름 없음)': '(no name)',
  '값 대기': 'Awaiting value',

  // ── opcua — browse · read · expose ──
  '[{0}개]': '[{0} items]',
  '(구조체)': '(structure)',
  '이 주소는 지금 이 저작도구가 값을 내주는 OPC UA 서버입니다. 여기서 보이는 것은 설비 태그가 아니라 열려 있는 AAS 파일의 내용입니다. 수집할 곳은 설비(PLC)의 주소여야 합니다.':
    'This address is the OPC UA server through which this authoring tool itself serves values. What you see here are not machine tags but the contents of the open AAS files. The collection source must be the address of the machine (PLC).',
  '이 주소는 다른 컴퓨터에서 도는 같은 VEXPLOR AAS Studio입니다(AAS를 내주는 서버). 수집할 곳은 설비(PLC)의 주소여야 합니다.':
    'This address is another VEXPLOR AAS Studio running on a different computer (a server that serves AAS). The collection source must be the address of the machine (PLC).',
  '{0} 훑기 실패: {1}': 'Browsing {0} failed: {1}',
  '{0}이(가) {1}ms 안에 끝나지 않았습니다.': '{0} did not finish within {1} ms.',
  '나쁜 상태': 'Bad status',
  접속: 'Connect',
  '세션 열기': 'Open session',
  '{0} 접속 실패: {1}': 'Connecting to {0} failed: {1}',
  '읽기 실패: {0}': 'Read failed: {0}',
  '응답이 없습니다.': 'No response.',
  '주소공간을 만들지 못했습니다.': 'Could not create the address space.',

  // ── fieldbus — Modbus · MQTT ──
  'EndpointMetadata.base가 없습니다.': 'EndpointMetadata.base is missing.',
  'MQTT 브로커에 붙지 못했습니다(시간 초과): {0}:{1}': 'Could not connect to the MQTT broker (timeout): {0}:{1}',
  '아직 받은 메시지 없음': 'No message received yet',
  'MQTT 연결 응답이 없습니다(시간 초과).': 'No MQTT connection response (timeout).',
  '연결이 끊겼습니다.': 'The connection was closed.',
  'MQTT 브로커가 연결을 거절했습니다(코드 {0}).': 'The MQTT broker refused the connection (code {0}).',
  'Modbus 장치에 붙지 못했습니다(시간 초과): {0}:{1}': 'Could not connect to the Modbus device (timeout): {0}:{1}',
  '기대하지 않은 응답 기능 번호: {0}': 'Unexpected response function code: {0}',
  '닫았습니다.': 'Closed.',
  '닫힌 연결입니다.': 'The connection is closed.',
  'Modbus 접속 주소(base)가 없습니다.': 'The Modbus endpoint (base) is missing.',
  'unitID 가 잘못됐습니다: {0}': 'Invalid unitID: {0}',
  'Modbus 주소가 잘못됐습니다: {0}': 'Invalid Modbus address: {0}',
  'quantity 가 잘못됐습니다: {0}': 'Invalid quantity: {0}',
  '잘못된 MQTT 길이': 'Invalid MQTT length',
  '가상 PLC (시뮬레이션)': 'Virtual PLC (simulation)',
  'DB 스키마가 버전 {0}인데 이 프로그램은 버전 {1}까지만 압니다 — 프로그램 버전을 올리십시오. 옛 프로그램이 새 표를 읽으면 조용히 잃을 수 있어 기동하지 않습니다.':
    'The database schema is version {0}, but this program only knows up to version {1} — upgrade the program. It does not start, because an older program reading newer tables could silently lose data.',
  '{0}을(를) 읽지 못했습니다 — 손으로 고치거나 지운 뒤 다시 띄우십시오: {1}':
    'Could not read {0} — fix it by hand or delete it, then start again: {1}',
  // ── fieldbus — S7 · MC protocol (VEXPLOR extension bindings, read only) ──
  "태그 {0}: {1}":
    "Tag {0}: {1}",
  "S7 · MC 프로토콜 읽기에는 로그인이 없습니다.":
    "Reading over S7 or the MC protocol has no login.",
  "PLC 주소가 이상합니다: {0}":
    "Invalid PLC address: {0}",
  "PLC 자료형을 모릅니다: {0} — 쓸 수 있는 것: {1}":
    "Unknown PLC data type: {0} — allowed: {1}",
  "접속 주소는 {0}://호스트[:포트] 꼴이어야 합니다: {1}":
    "The endpoint must look like {0}://host[:port]: {1}",
  "접속 주소의 {0} 값이 이상합니다: {1} — 0 ~ {2}":
    "Invalid {0} in the endpoint: {1} — 0 to {2}",
  "S7 주소가 이상합니다: {0} — 예: DB10.DBD4:REAL · DB1.DBX0.3 · M10.3 · MW20:INT · IB0":
    "Invalid S7 address: {0} — e.g. DB10.DBD4:REAL · DB1.DBX0.3 · M10.3 · MW20:INT · IB0",
  "S7 주소 {0} 의 크기 글자와 자료형 {1} 이 맞지 않습니다 — X 는 BOOL, B 는 1바이트 · STRING · 8바이트, W 는 2바이트, D 는 4 · 8바이트":
    "The size letter of S7 address {0} does not fit data type {1} — X is BOOL, B is 1 byte · STRING · 8 bytes, W is 2 bytes, D is 4 · 8 bytes",
  "MC 프로토콜은 정해진 포트가 없습니다 — PLC 이더넷 설정의 포트를 주소에 적으십시오: {0}":
    "The MC protocol has no fixed port — put the port from the PLC Ethernet settings in the address: {0}",
  "접속 주소의 series 값이 이상합니다: {0} — 쓸 수 있는 것: Q · L · iQ-R · iQ-F":
    "Invalid series in the endpoint: {0} — allowed: Q · L · iQ-R · iQ-F",
  "MC 주소가 이상합니다: {0} — 예: D100 · D200:REAL · D10.3 · M50 · X1F · W1A:DINT":
    "Invalid MC address: {0} — e.g. D100 · D200:REAL · D10.3 · M50 · X1F · W1A:DINT",
  "MC 주소 {0} 는 비트입니다 — 자료형은 BOOL 만 됩니다":
    "MC address {0} is a bit — only BOOL is allowed",
  "MC 워드 디바이스 {0} 에는 {1} 을 쓸 수 없습니다 — 비트는 D10.3 처럼 적습니다":
    "MC word device {0} cannot hold {1} — write a bit as D10.3",
  "MC 장치의 응답 형식이 이상합니다.":
    "The MC device sent an answer in an unexpected format.",
  "{0} (종료 코드 0x{1})":
    "{0} (end code 0x{1})",
  "{0} 장치에 붙지 못했습니다(시간 초과): {1}:{2}":
    "Could not connect to the {0} device (timeout): {1}:{2}",
  "장치가 형식이 깨진 응답을 보냈습니다.":
    "The device sent a malformed answer.",
  "S7 장치가 연결을 받지 않았습니다 — rack {0} · slot {1} 이 맞는지 확인하십시오.":
    "The S7 device did not accept the connection — check that rack {0} · slot {1} are right.",
  "S7 장치의 응답 형식이 이상합니다.":
    "The S7 device sent an answer in an unexpected format.",
  "S7 장치가 요청을 거절했습니다(오류 {0}) — S7-1200 · 1500 은 CPU 설정에서 「PUT/GET 통신 허용」을 켜고, 읽을 DB 의 「최적화된 블록 액세스」를 꺼야 읽힙니다.":
    "The S7 device refused the request (error {0}) — on S7-1200 · 1500, turn on \"Permit access with PUT/GET communication\" in the CPU settings and turn off \"Optimized block access\" for the DBs to read.",
};
