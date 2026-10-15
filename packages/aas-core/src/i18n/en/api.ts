/** English dictionary - api. Key = the Korean source text verbatim, value = English. Placeholders ({0}, <b>) must match the source exactly */
export const EN_API: Record<string, string> = {
  '되돌릴 변경이 없습니다.': 'There is no change to undo.',
  '다시 할 변경이 없습니다.': 'There is no change to redo.',
  '경로가 없습니다: {0} {1}': 'No such route: {0} {1}',

  // ── api.ts · auth.ts · security.ts · session.ts — request handling · authentication ─────────
  '허용되지 않는 메서드입니다: {0}': 'Method not allowed: {0}',
  '패키지 {0}을(를) 찾을 수 없습니다.': 'Package {0} not found.',
  '데모 계정으로는 파일을 내려받을 수 없습니다. 「회원가입」으로 계정을 만들면 받을 수 있습니다.':
    'The demo account cannot download files. Create an account with "Sign up" to download.',
  '보기 전용 계정으로는 고칠 수 없습니다.': 'A view-only account cannot make changes.',
  '로그인이 필요합니다. 기계라면 Authorization: Bearer <API 키> 헤더를 주십시오.':
    'Sign-in required. Machines should send an Authorization: Bearer <API key> header.',
  '읽기 전용 토큰으로는 고칠 수 없습니다.': 'A read-only token cannot make changes.',
  '토큰이 올바르지 않습니다.': 'The token is not valid.',
  '체험판에서는 도구 안의 가상 PLC에만 연결할 수 있습니다. 실제 설비 연결은 직접 설치한 서버에서 하십시오.':
    'On the trial server you can only connect to the built-in virtual PLC. Connect real equipment from a server you install yourself.',
  '다른 사이트에서 보낸 요청은 받지 않습니다. 브라우저 주소창의 주소로 직접 접속하십시오.':
    'Requests sent from another site are not accepted. Open this server directly from the browser address bar.',
  '지금은 가입을 받을 수 없습니다 — 잠시 뒤에 다시 시도하십시오.': 'Sign-up is not available right now — try again shortly.',
  '같은 곳에서 가입을 너무 많이 시도했습니다 — 한 시간 뒤에 다시 시도하십시오.':
    'Too many sign-up attempts from the same place — try again in an hour.',
  '비밀번호는 10자 이상이어야 합니다.': 'The password must be at least 10 characters.',
  '비밀번호가 너무 깁니다(200자 이하).': 'The password is too long (200 characters or fewer).',
  '비밀번호 앞뒤의 빈칸은 빼 주십시오 — 나중에 못 맞춥니다.':
    'Remove spaces at the start or end of the password — otherwise it will not match later.',
  'base64url이 아닙니다: {0}': 'base64url decoding failed: {0}',

  // ── routes/auth.ts — login · sign-up · account management ─────────────────────────────
  '데모 계정은 바꾸거나 지울 수 없습니다 — 여럿이 함께 쓰는 계정입니다. 「회원가입」으로 자기 계정을 만드십시오.':
    'The demo account cannot be changed or deleted — it is shared by many people. Create your own account with "Sign up".',
  '로그인 이름과 비밀번호를 모두 주십시오.': 'Provide both a login name and a password.',
  '로그인 시도가 많습니다. 5분 뒤에 다시 해 주십시오.': 'Too many sign-in attempts. Try again in 5 minutes.',
  '로그인하지 못했습니다 — 이름이나 비밀번호를 확인하십시오.': 'Sign-in failed — check the name or password.',
  '이 서버는 가입을 받지 않습니다 — 관리자에게 계정을 받으십시오.':
    'This server does not accept sign-ups — ask an administrator for an account.',
  '로그인 이름은 영문으로 시작하고 영문·숫자·_ . - 만 씁니다(2~41자).':
    'A login name starts with a letter and uses only letters, digits and _ . - (2–41 characters).',
  '이 서버는 연락처를 받지 않습니다 — 비워 두고 가입하십시오.':
    'This server does not collect contact details — leave them empty and sign up.',
  '이름 · 이메일을 적어 주십시오.': 'Enter a name and an email address.',
  '입력이 너무 깁니다.': 'The input is too long.',
  '이메일 형식이 올바르지 않습니다.': 'The email address is not valid.',
  '개인정보 수집·이용에 동의해야 가입할 수 있습니다.':
    'You must agree to the collection and use of personal information to sign up.',
  '이미 쓰이는 로그인 이름입니다 — 다른 이름을 고르십시오.': 'That login name is already taken — choose another.',
  '로그인이 필요합니다.': 'Sign-in required.',
  '마지막 관리자는 탈퇴할 수 없습니다 — 다른 관리자를 먼저 만드십시오.':
    'The last administrator cannot delete their account — create another administrator first.',
  '이미 계정이 있습니다 — 관리자에게 받으십시오.': 'Accounts already exist — ask an administrator for one.',
  '설치 코드가 필요합니다 — 서버를 띄운 화면(기동 로그)에 적혀 있습니다.':
    'A setup code is required — it is printed where the server was started (startup log).',
  '역할은 admin · editor · viewer 중 하나입니다.': 'The role must be one of admin · editor · viewer.',
  '그런 계정이 없습니다.': 'No such account.',
  '자기 계정은 여기서 지울 수 없습니다 — 「설정 → 탈퇴」를 쓰십시오.':
    'You cannot delete your own account here — use "Settings → Delete my account".',
  '데모 계정은 지울 수 없습니다 — 지우면 공개 서버에 아무도 들어오지 못합니다.':
    'The demo account cannot be deleted — without it nobody can get into the public server.',
  '마지막 관리자는 지울 수 없습니다 — 다른 관리자를 먼저 만드십시오.':
    'The last administrator cannot be deleted — create another administrator first.',
  '데모 계정은 바꿀 수 없습니다 — 공개 서버의 입구입니다.':
    'The demo account cannot be changed — it is the way into the public server.',
  '마지막 관리자입니다 — 다른 관리자를 먼저 만드십시오. 아무도 계정을 다룰 수 없게 됩니다.':
    'This is the last administrator — create another administrator first. Otherwise nobody could manage accounts.',
  '표시 이름은 1~40자로 적어 주십시오.': 'The display name must be 1–40 characters.',
  '회사명이 너무 깁니다.': 'The company name is too long.',
  '바꿀 내용이 없습니다.': 'Nothing to change.',
  '지금 비밀번호가 맞지 않습니다.': 'The current password is not correct.',
  '관리자만 계정을 다룰 수 있습니다.': 'Only administrators can manage accounts.',

  // ── multipart.ts · elements.ts — body parsing · $value ────────────────────────
  'multipart 경계(boundary)가 없습니다.': 'The multipart boundary is missing.',
  'multipart 본문에서 경계를 찾지 못했습니다.': 'No boundary was found in the multipart body.',
  '닫히지 않은 multipart 조각이 있습니다.': 'A multipart part is not closed.',
  'multipart 머리말이 없습니다.': 'A multipart part has no headers.',
  '이름 없는 multipart 조각이 있습니다.': 'A multipart part has no name.',
  '{0}의 값은 스칼라여야 합니다.': 'The value of {0} must be a scalar.',
  'MultiLanguageProperty의 값은 [{"ko":"…"}] 형태의 배열이어야 합니다.':
    'The value of a MultiLanguageProperty must be an array like [{"en":"…"}].',
  '언어 항목은 {"언어코드":"내용"} 하나이거나 {language,text}여야 합니다.':
    'A language entry must be a single {"languageCode":"text"} or {language,text}.',
  'Range의 값은 {min,max}여야 합니다.': 'The value of a Range must be {min,max}.',
  '{0}은 $value 쓰기를 지원하지 않습니다. 요소 전체를 PUT하십시오.':
    '{0} does not support writing $value. PUT the whole element instead.',

  // ── routes/part2.ts — IDTA Part 2 ─────────────────────────────────────────
  'limit이 양의 정수가 아닙니다: {0}': 'limit is not a positive integer: {0}',
  'If-Match가 리비전 숫자가 아닙니다: {0}': 'If-Match is not a revision number: {0}',
  '본문이 JSON 객체가 아닙니다.': 'The body is not a JSON object.',
  '이 경로에는 {0}만 만들 수 있습니다: {1}': 'Only {0} can be created at this path: {1}',
  'AAS를 찾을 수 없습니다.': 'AAS not found.',
  '이 AAS가 참조하지 않는 Submodel입니다.': 'This AAS does not reference that Submodel.',
  'multipart 본문을 읽지 못했습니다.': 'Could not read the multipart body.',
  'file 조각이 없습니다.': 'There is no file part.',
  '본문이 파일 바이트가 아닙니다.': 'The body is not file bytes.',
  'Submodel을 찾을 수 없습니다.': 'Submodel not found.',
  'SubmodelElementList의 자식에는 idShort를 붙일 수 없습니다(AASd-120). 리스트 자식은 순서로 가리킵니다.':
    'Children of a SubmodelElementList cannot have an idShort (AASd-120). List children are addressed by index.',
  '같은 자리에 이미 「{0}」이(가) 있습니다. 형제끼리 이름이 겹치면 안 됩니다(AASd-022).':
    '"{0}" already exists at the same level. Siblings must not share a name (AASd-022).',
  '요소를 찾을 수 없습니다: {0}': 'Element not found: {0}',
  '부모 요소를 찾을 수 없습니다: {0}': 'Parent element not found: {0}',
  'offset은 -1(위)·1(아래), to는 0 이상의 정수여야 합니다.':
    'offset must be -1 (up) or 1 (down), and to must be an integer of 0 or more.',
  '자리는 0~{0} 사이여야 합니다.': 'The position must be between 0 and {0}.',
  '이미 맨 위입니다.': 'Already at the top.',
  '이미 맨 아래입니다.': 'Already at the bottom.',
  '첨부 경로가 없습니다.': 'There is no attachment path.',
  '첨부 파트가 패키지에 없습니다: {0}': 'The attachment part is not in the package: {0}',
  '첨부는 File·Blob 요소에만 붙습니다.': 'Attachments can only be set on File and Blob elements.',
  '썸네일이 없습니다.': 'There is no thumbnail.',
  '지금은 로그인 요청이 많습니다. 잠시 뒤에 다시 해 주십시오.':
    'There are too many sign-in requests right now. Please try again shortly.',
  '이 서버는 작업 공간을 사람마다 나눕니다(AAS_WORKSPACE=private) — 먼저 첫 관리자 계정을 만드십시오.':
    'This server separates workspaces per person (AAS_WORKSPACE=private) — create the first administrator account first.',
  '지금은 큰 파일을 올리는 사람이 많습니다. 잠시 뒤에 다시 올려 주십시오.':
    'Too many large uploads are in progress right now. Please upload again shortly.',
  'JSON 본문을 읽지 못했습니다: {0}':
    'Could not read the JSON body: {0}',
  'JSON 본문이 너무 깊게 겹쳐 있습니다 — {0}단계까지 받습니다.':
    'The JSON body is nested too deeply — up to {0} levels are accepted.',
  '썸네일은 PNG · JPEG · GIF · WebP 그림 파일만 올릴 수 있습니다.':
    'A thumbnail must be a PNG, JPEG, GIF or WebP image.',
  '그 Submodel 참조가 없습니다.': 'There is no such Submodel reference.',

  // ── routes/packages.ts — packages · composition · import · collection ────────────────────
  '본문이 AASX 바이트가 아닙니다.': 'The body is not AASX bytes.',
  'multipart/form-data로 보내거나(규격), name 질의 인자를 함께 주십시오(확장).':
    'Send multipart/form-data (standard), or include the name query parameter (extension).',
  '패키지를 찾을 수 없습니다.': 'Package not found.',
  '이 파일에는 {0} 서브모델이 없습니다 — 공정 파일이 아닙니다.':
    'This file has no {0} submodel — it is not a process file.',
  '넣으려는 파일이 (직접 또는 몇 단계 건너) 이 파일을 이미 담고 있습니다 — 순환이 됩니다.':
    'The file you are adding already contains this file (directly or through several levels) — that would be a cycle.',
  '가상 PLC는 수집이 켜진 서버(COLLECT=on)에서만 씁니다.':
    'The virtual PLC is only available on a server with collection enabled (COLLECT=on).',
  '가상 PLC는 설비 파일에 붙입니다 — 공정(묶음) 파일에는 수집할 값이 없습니다.':
    'The virtual PLC attaches to equipment files — a process (group) file has no values to collect.',
  '가상 PLC 포트(14850)를 이미 다른 프로그램이 쓰고 있습니다 — 가상PLC_시작.bat 창이 떠 있으면 닫고 다시 누르십시오.':
    'Another program is already using the virtual PLC port (14850) — if the virtual PLC start window (.bat) is open, close it and try again.',
  '가상 PLC를 띄우지 못했습니다: {0}': 'Could not start the virtual PLC: {0}',
  '운전 데이터(OperationalData)에 Property가 없어 흉내 낼 태그가 없습니다.':
    'OperationalData has no Property, so there are no tags to simulate.',
  '이미 다른 주소({0})로 수집 연결이 있습니다 — 가상 PLC로 바꾸지 않았습니다. 시연은 「호기별로 나누기」로 만든 호기에서 하십시오.':
    'A collection link to another address ({0}) already exists — it was not switched to the virtual PLC. For a demo, use a unit made with "Split per unit".',
  '장비명은 영문으로 시작하고 영문·숫자·밑줄만 씁니다. 예: RollFormingMachine':
    'An equipment name starts with a letter and uses only letters, digits and underscores. e.g. RollFormingMachine',
  '이름은 영문으로 시작하고 영문·숫자·밑줄만 씁니다. 예: RollFormingMachine_1':
    'A name starts with a letter and uses only letters, digits and underscores. e.g. RollFormingMachine_1',
  '그 시각의 이력이 없습니다.': 'There is no history entry at that time.',
  '그룹 이름이 비었습니다.': 'The group name is empty.',
  '자기 자신을 매달 수 없습니다.': 'A file cannot be attached to itself.',
  '고른 파일에 AAS가 없습니다.': 'The selected file has no AAS.',
  '고른 파일에 Asset 주소(globalAssetId)가 없습니다 — 그 파일을 먼저 고치십시오.':
    'The selected file has no asset address (globalAssetId) — fix that file first.',
  '가져올 대상 패키지가 없습니다.': 'The target package to import into does not exist.',
  '원본 Submodel을 찾을 수 없습니다.': 'Source Submodel not found.',
  '이미 「{0}」 서브모델이 있습니다. 바꾸거나 나란히 둘지 정해 주십시오.':
    'A "{0}" submodel already exists. Choose whether to replace it or keep both.',
  '가져오는 쪽 AAS의 idShort와 원본 Submodel의 idShort가 모두 있어야 id를 다시 지을 수 있습니다.':
    'The id can only be regenerated when both the target AAS and the source Submodel have an idShort.',
  '이미 같은 id의 Submodel이 있습니다: {0}': 'A Submodel with the same id already exists: {0}',
  '이 서버에는 수집 어댑터가 없습니다. OPC UA 스택을 올린 배포에서 쓰십시오.':
    'This server has no collection adapter. Use a deployment with the OPC UA stack.',
  'AssetInterfacesDescription 서브모델이 없습니다. 수집할 주소를 알 수 없습니다.':
    'There is no AssetInterfacesDescription submodel, so the addresses to collect from are unknown.',
  '서브모델을 찾을 수 없습니다: {0}': 'Submodel not found: {0}',
  'submodel을 지정하십시오.': 'Specify submodel.',
  '{0}은(는) 표를 만들지 않습니다. {1}': '{0} does not produce a table. {1}',
  '이 배포에는 수집 어댑터가 없습니다.': 'This deployment has no collection adapter.',
  '접속 주소는 opc.tcp:// 로 시작해야 합니다: {0}': 'The endpoint must start with opc.tcp://: {0}',
  'AAS의 idShort(장비명)가 있어야 AID id를 지을 수 있습니다.':
    'The AAS needs an idShort (equipment name) to generate the AID id.',

  // ── routes/derivation.ts — type file linking ─────────────────────────────────
  '이 파일은 형식 파일과 연결되어 있지 않습니다.': 'This file is not linked to a type file.',
  '형식 파일이 보관함에 없습니다 — 다시 연결하십시오.': 'The type file is not in the store — link it again.',
  '자기 자신을 형식 파일로 연결할 수 없습니다.': 'A file cannot be linked to itself as its type file.',
  '형식 파일을 찾을 수 없습니다.': 'Type file not found.',
  '연결이 없습니다.': 'There is no link.',

  // ── routes/registry.ts — registry ───────────────────────────────────────
  'assetIds를 해석하지 못했습니다: {0}': 'Could not decode assetIds: {0}',
  'assetIds가 SpecificAssetId 모양이 아닙니다: {0}': 'assetIds is not shaped like a SpecificAssetId: {0}',
  '등록된 AAS가 없습니다: {0}': 'No registered AAS: {0}',
  '그 AAS에 매달린 서브모델이 아닙니다: {0}': 'That submodel is not attached to the AAS: {0}',
  '등록된 서브모델이 없습니다: {0}': 'No registered submodel: {0}',

  // ── undo.ts — change descriptions kept in the undo list (stored in the language at capture time) ────────
  '자동 고치기': 'Auto-fix',
  '형식 변경 반영': 'Apply type file changes',
  '이력에서 되돌리기': 'Restore from history',
  '수집 연결 만들기': 'Create collection link',
  '구성 편집': 'Edit structure',
  '다른 파일에서 가져오기': 'Import from another file',
  '「{0}」': '"{0}"',
  요소: 'element',
  '{0} 순서 바꾸기': 'Reorder {0}',
  '{0} 복제': 'Duplicate {0}',
  '{0} 첨부 바꾸기': 'Replace attachment of {0}',
  '{0} 지움': 'Delete {0}',
  '{0} 밑에 요소 추가': 'Add element under {0}',
  '요소 추가': 'Add element',
  '{0} 고침': 'Edit {0}',
  '서브모델 지움': 'Delete submodel',
  '서브모델 추가': 'Add submodel',
  '서브모델 고침': 'Edit submodel',
  '개념 설명 지움': 'Delete concept description',
  '개념 설명 추가': 'Add concept description',
  '개념 설명 고침': 'Edit concept description',
  'AAS 고침': 'Edit AAS',
  '파일 다시 올림': 'Re-upload file',

  // ── server.ts · pg.ts · demo.ts · retention.ts — collection · startup logs (AAS_LANG) ──
  '정책 파일을 읽지 못했습니다: {0} — {1}': 'Could not read the policy file: {0} — {1}',
  '정책 파일: {0} — {1}': 'Policy file: {0} — {1}',
  '기본값과 같음': 'same as defaults',
  '바꾼 항목 {0}': 'changed: {0}',
  '본문이 상한({0} 바이트)을 넘었습니다.': 'The body exceeds the limit ({0} bytes).',
  '아직 지원하지 않는 프로토콜입니다: {0}': 'Protocol not supported yet: {0}',
  '체험판(DEMO_MODE=on)에서는 OPC UA 노출을 켜지 않습니다 — 그 포트에는 인증이 없습니다.':
    'OPC UA exposure is not enabled on the trial server (DEMO_MODE=on) — that port has no authentication.',
  'OPC UA 서버를 띄우지 못했습니다: {0}': 'Could not start the OPC UA server: {0}',
  'OPC UA 서버를 띄우는 중입니다.': 'Starting the OPC UA server.',
  'OPCUA_SERVER=on이 아닙니다.': 'OPCUA_SERVER is not on.',
  'COLLECT_INTERVAL이 설정되지 않았습니다 (수동 수집만).': 'COLLECT_INTERVAL is not set (manual collection only).',
  'postgres{0} · 수집값 {1}': 'postgres{0} · collected values {1}',
  '수집값 정리 실패: {0}': 'Pruning collected values failed: {0}',
  '수집값 정리 실패:': 'Pruning collected values failed:',
  '일반 PostgreSQL (timescaledb 확장 없음)': 'plain PostgreSQL (no timescaledb extension)',
  'TimescaleDB 하이퍼테이블': 'TimescaleDB hypertable',
  '일반 표로 둔다 ({0})': 'kept as a plain table ({0})',
  끔: 'off',
  '{0} · 스키마 {1}판': '{0} · schema v{1}',
  '체험 서버 정리 — {0}분 넘게 안 쓴 방문자 파일 {1}개를 지웠습니다.':
    'Trial server cleanup — deleted {1} visitor file(s) unused for over {0} min.',
  '체험 서버 정리 실패: {0}': 'Trial server cleanup failed: {0}',
  'AAS API가 http://localhost:{0} 에서 대기합니다.': 'AAS API listening on http://localhost:{0}.',
  'Part 2 기저 경로: /packages/{packageId}/api/v3.0': 'Part 2 base path: /packages/{packageId}/api/v3.0',
  '저장소: {0}': 'Store: {0}',
  '서버를 끄면 올린 파일이 사라집니다.': 'Uploaded files are lost when the server stops.',
  '남기려면 AAS_DATA_DIR=<폴더> (혼자 쓸 때) 또는 DATABASE_URL (여럿이 쓸 때).':
    'To keep them, set AAS_DATA_DIR=<DIR> (single user) or DATABASE_URL (shared).',
  '껐다 켜도 남습니다. 그 폴더를 통째로 복사하면 그대로 옮겨집니다.':
    'Files survive restarts. Copy the whole folder to move them.',
  '저작 UI: 같은 포트에서 내줍니다 ({0})': 'Authoring UI: served on the same port ({0})',
  '저작 UI: 없음 (API만)': 'Authoring UI: none (API only)',
  '교차 출처(CORS) 허용: {0}': 'Cross-origin (CORS) allowed: {0}',
  '모든 출처에 열려 있습니다 — 사내 배포면 도메인을 적으십시오.':
    'Open to all origins — for an internal deployment, list the domains.',
  '템플릿 폴더: {0} — 새로 올림 {1} · 이미 있음 {2}': 'Template folder: {0} — added {1} · already present {2}',
  '수집(M8) 켜짐 — {0}초마다 자동 수집 · GET /collect-status':
    'Collection (M8) on — automatic collection every {0} s · GET /collect-status',
  '수집(M8) 켜짐 — POST /packages/{id}/collect (수동). 자동은 COLLECT_INTERVAL=<초>':
    'Collection (M8) on — POST /packages/{id}/collect (manual). For automatic, COLLECT_INTERVAL=<SECONDS>',
  '보존 기간 {0}일 — 기동 때 {1}개 정리 · 한 시간마다 반복':
    'Retention {0} days — pruned {1} at startup · repeats every hour',
  '보존 기간 없음(영구 보관) — 오래된 값을 지우려면 COLLECT_RETENTION_DAYS=<일>':
    'No retention period (kept forever) — to delete old values, COLLECT_RETENTION_DAYS=<DAYS>',
  '수집값 보존 기간 {0}일 — 기동 때 {1}개 정리': 'Collected value retention {0} days — pruned {1} at startup',
  'OPC UA 노출(M6·M7) — 🔴 **켜지 않았습니다.** 체험판에서는 띄우지 않습니다(인증이 없는 포트입니다).':
    'OPC UA exposure (M6·M7) — **not enabled.** It is not started on the trial server (the port has no authentication).',
  'OPC UA 노출(M6·M7) 켜짐 — opc.tcp://<이 서버>:{0}/UA/AAS · {1}초마다 갱신':
    'OPC UA exposure (M6·M7) on — opc.tcp://<this server>:{0}/UA/AAS · refreshed every {1} s',
  '상위 앱(MES·SCADA)이 구독으로 값을 받아 갑니다 · GET /opcua-status':
    'Upstream apps (MES, SCADA) receive values by subscription · GET /opcua-status',
  '이 포트에는 인증이 없습니다. 사내망 밖으로 열지 마십시오.':
    'This port has no authentication. Do not expose it outside the internal network.',
  '체험판(DEMO_MODE=on)으로 떴습니다 — 공개해 두고 눌러 보게 하는 구성입니다.':
    'Started as a trial server (DEMO_MODE=on) — a public setup for people to try out.',
  '데모 계정: {0} / {1}  ({2})': 'Demo account: {0} / {1}  ({2})',
  '지금 만들었습니다': 'just created',
  '설정에 맞춰 고쳤습니다': 'updated to match the settings',
  '이미 있습니다': 'already exists',
  '이 계정으로는 **파일을 내려받을 수 없습니다.** 가입한 계정은 받을 수 있습니다.':
    'This account **cannot download files.** Signed-up accounts can.',
  '작업 공간은 **로그인마다 따로**입니다 — 같은 데모 계정으로 들어와도 서로의 파일을 못 봅니다.':
    'Each **sign-in gets its own workspace** — people on the same demo account cannot see each other\'s files.',
  '방문자가 {0}분 넘게 손대지 않은 파일은 지웁니다(가입한 사람의 파일은 남깁니다).':
    'Visitor files untouched for over {0} min are deleted (files of signed-up users are kept).',
  '자동 정리가 꺼져 있습니다(AAS_DEMO_RESET_MINUTES=0) — 떠난 방문자의 파일이 계속 쌓입니다.':
    'Automatic cleanup is off (AAS_DEMO_RESET_MINUTES=0) — files of departed visitors keep piling up.',
  '작업 공간을 사람마다 나눕니다(AAS_WORKSPACE=private) — 저마다 자기가 올린 것만 봅니다.':
    'Workspaces are separated per person (AAS_WORKSPACE=private) — everyone sees only what they uploaded.',
  '관리자와 API 키는 전부 봅니다. 그 전에 올려 둔 파일은 모두에게 읽기 전용으로 보입니다.':
    'Administrators and API keys see everything. Files uploaded before this are read-only for everyone.',
  'OPC UA 노출이 켜져 있습니다 — 그 포트로는 **모든 사람의 값**이 인증 없이 나갑니다.':
    'OPC UA exposure is on — **everyone\'s values** go out on that port without authentication.',
  '계정도 API 키도 없어 사람을 가를 수 없습니다 — 첫 관리자를 만들기 전까지 파일 요청을 받지 않습니다.':
    'No accounts and no API keys, so people cannot be told apart — file requests are refused until the first administrator is created.',
  '스스로 가입할 수 있습니다 — 새 계정의 역할: {0}': 'Self sign-up is open — role of new accounts: {0}',
  'AAS_SIGNUP_ROLE=admin은 받지 않습니다 — 가입하면 누구나 관리자가 됩니다. editor로 둡니다.':
    'AAS_SIGNUP_ROLE=admin is not accepted — anyone signing up would become an administrator. Using editor.',
  '첫 관리자 설치 코드: {0}': 'First administrator setup code: {0}',
  '계정이 하나도 없을 때 「첫 관리자 만들기」 화면이 이 값을 묻습니다.':
    'While there are no accounts, the "Create the first administrator" screen asks for this value.',
  '계정을 만들고 나면 쓰이지 않습니다. 직접 정하려면 AAS_SETUP_CODE=<값>.':
    'It is not used once an account exists. To set it yourself, AAS_SETUP_CODE=<VALUE>.',
  '보호 모드 — 토큰이 없어 **이 컴퓨터에서만** 열었습니다 (127.0.0.1).':
    'Protected mode — no token, so it is open **on this computer only** (127.0.0.1).',
  '다른 사람도 쓰게 하려면 AAS_TOKEN=<토큰>을 주고 다시 띄우십시오.':
    'To let others use it, restart with AAS_TOKEN=<TOKEN>.',
  '토큰 없이 밖으로 열려면 AAS_ALLOW_OPEN=1 (권하지 않습니다).':
    'To open it to the network without a token, AAS_ALLOW_OPEN=1 (not recommended).',
  '토큰 없이 열었습니다 (AAS_ALLOW_OPEN=1) — 같은 망의 누구나 열고 고칠 수 있습니다.':
    'Opened without a token (AAS_ALLOW_OPEN=1) — anyone on the same network can open and edit.',
  '특정 사람만 쓰게 하려면 AAS_TOKEN=<토큰>을 주고 다시 띄우십시오.':
    'To restrict it to specific people, restart with AAS_TOKEN=<TOKEN>.',
  '인증이 꺼진 채 밖으로 열려 있습니다 — 주소를 아는 누구나 파일을 읽고 지울 수 있습니다.':
    'Open to the network with authentication off — anyone who knows the address can read and delete files.',
  'AAS_TOKEN=<토큰>으로 띄우십시오.': 'Start with AAS_TOKEN=<TOKEN>.',
  '읽기 전용만 줄 때는 AAS_READONLY_TOKEN=<토큰>.': 'For read-only access only, AAS_READONLY_TOKEN=<TOKEN>.',
  '인증 켜짐 — 전체 토큰 {0}개 · 읽기 전용 {1}개': 'Authentication on — {0} full token(s) · {1} read-only',
  '토큰 {0}개에 ASCII 밖 문자가 있습니다 — 영문·숫자·기호로 바꾸기를 권합니다.':
    '{0} token(s) contain non-ASCII characters — letters, digits and symbols are recommended.',
};
