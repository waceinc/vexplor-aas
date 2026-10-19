/**
 * Language of screen text.
 *
 * Important: **both screen text and server-generated text have English** (2026-10-14). Server text (finding messages, rule descriptions,
 *    validation reports, bundle README, errors) is handled by `tr()` in `@aas/core` and the server dictionary (packages/aas-core/src/i18n/en),
 *    and the language chosen on screen is sent with every request as `Accept-Language` (api/http.ts `withAuth`).
 *    Server-side gaps are caught by `node scripts/i18n-server-scan.mjs --check`.
 *
 * Important: **when you add new Korean text to the screen, wrap it in `tr()`/`<T>` and add it to the dictionary (en.ts).** If you forget,
 *    CI stops (`node scripts/i18n-scan.mjs --check`). Missing from the dictionary, the screen still shows Korean
 *    (fallback), so nothing breaks, but that spot alone stays Korean on the English screen.
 *
 * Important: the dictionary uses **the Korean text itself as the key**, as in `t('열기')`. With separate keys
 *    (like `header.open`) the code does not show which text it is, and a missing entry shows a blank.
 *    With Korean as the key, **a miss still shows the Korean text** — the worst case is "not translated".
 */
import { lookupEn, setLangSource } from '@aas/core';
import { EN_MORE } from './en.js';
import { EN_METAMODEL } from './en-metamodel.js';

export type Lang = 'ko' | 'en';

const KEY = 'aas.lang';

/** English dictionary — missing keys go out as the Korean text */
const EN: Record<string, string> = {
  // Header — file
  파일: 'File',
  'AASX 열기': 'Open AASX',
  '새로 만들기': 'New',
  '번들 열기': 'Open bundle',
  '파일 목록': 'File list',
  '열린 파일 없음': 'No file open',
  '— 파일 고르기 —': '— choose a file —',
  // Header — edit · check
  '↶ 되돌리기': '↶ Undo',
  서브모델: 'Submodels',
  '서브모델 추가': 'Add submodel',
  '다른 파일에서 가져오기': 'Import from another file',
  '자동 고치기': 'Auto-fix',
  // Header — submit
  내보내기: 'Export',
  '검증 결과서': 'Validation report',
  '문서용 자료': 'Document assets',
  '레퍼런스 번들': 'Reference bundle',
  'AASX 내려받기': 'Download AASX',
  // Header — status · settings
  위반: 'Errors',
  경고: 'Warnings',
  '→ 내주는 중': '→ Serving',
  '규칙과 규약 보기': 'Rules and conventions',
  '토큰 지우기': 'Clear token',
  언어: 'Language',
  설정: 'Settings',
  '처리 중…': 'Working…',
  // Welcome screen
  '서버에 올려 둔 파일이 있습니다 — 아래에서 골라 이어서 작업하거나, 새 파일을 엽니다.':
    'You have files on the server — pick one below to continue, or open a new one.',
  'AASX 파일을 열면 계층 트리·규칙 지적·수집이 한 화면에 뜹니다.':
    'Open an AASX file to see its tree, rule findings and collected values on one screen.',
  'AASX 파일 열기': 'Open AASX file',
  '이어서 작업하기': 'Continue working',
  '올려 둔 파일': 'files on the server',
  건: '',
  // ── Edit pane (Inspector) — buttons and labels (2026-10-02) ──────────────────
  '언어 추가': 'Add language',
  '이름 바꾸기': 'Rename',
  '첨부 지우기': 'Remove attachment',
  내려받기: 'Download',
  'semanticId 저장': 'Save semanticId',
  '요소 추가': 'Add element',
  '사본 만들기': 'Duplicate',
  삭제: 'Delete',
  '파일 고르기': 'Choose file',
  '이름 (idShort)': 'Name (idShort)',
  '첨부 파일': 'Attachment',
  '용어 정의': 'Concept description',
  '이력·되돌리기': 'History',
  '선택 해제 (Esc)': 'Clear selection (Esc)',
  '닫기 ✕': 'Close ✕',
  값: 'Value',
  종류: 'Type',
  최소: 'Min',
  최대: 'Max',
  단위: 'Unit',
  '(없음)': '(none)',
  없음: 'None',
  // ── Collection pane (OPC UA) — 2026-10-02 ──────────────────────────────────
  '← 수집 — 설비에서 받아 오기': '← Collect — read from the equipment',
  수집: 'Collect',
  '수집 연결 만들기': 'Create collection link',
  '가상 PLC로 연결 (시뮬레이션)': 'Connect a virtual PLC (simulation)',
  연결수정: 'Edit link',
  연결삭제: 'Delete link',
  주소목록: 'Address list',
  '최근 값': 'Latest value',
  시각: 'Time',
  항목: 'Item',
  연결됨: 'Connected',
  '연결됨 (자동)': 'Connected (auto)',
  '접속 실패': 'Connection failed',
  '접속 실패 (자동)': 'Connection failed (auto)',
  '수집 전': 'Not collected yet',
  '값 대기': 'Waiting for a value',
  '읽기 실패': 'Read failed',
  '주소 없음': 'No address',
  '연결 없음': 'No link',
  '(빈 값)': '(empty)',
  시뮬레이션: 'Simulation',
  시연본: 'Demo copy',
  '표준 API로 내보내기': 'Serve through the standard API',
  '실동작 증빙': 'Evidence of real operation',
  '설비(PLC) → 이 도구': 'Equipment (PLC) → this tool',
  '수집값은 시계열에만 쌓입니다. 모델(AASX)에는 되쓰지 않습니다 — 산출물이 형식(Type)이기 때문입니다.':
    'Collected values are kept as a time series only. They are never written back into the model (AASX) — the deliverable is a Type.',
  '이 파일에는 아직 수집 연결(AID 서브모델)이 없습니다. 설비의 OPC UA 주소와 태그 목록만 있으면 바로 만들 수 있습니다.':
    'This file has no collection link (AID submodel) yet. The equipment’s OPC UA address and a tag list are all you need.',
  '실물 PLC가 없으면 — 도구 안의 가상 PLC로 바로 시험할 수 있습니다.':
    'No real PLC? Use the virtual PLC built into this tool.',
  '마지막 수집 시도의 결과입니다': 'Result of the last collection attempt',
  '이 파일을 엽니다': 'Open this file',
  '같은 파일을 다시 올리면 사본이 하나 더 생깁니다 — 하던 파일은 여기서 고르십시오.':
    'Uploading the same file again makes another copy — pick the one you were working on here.',
  // ── Edit pane — labels · hints · pickers (2026-10-02, round 2) ────────────────────
  위치: 'Location',
  이름: 'Name',
  내용: 'Text',
  '변경 이력을 보고 실수를 되돌립니다': 'See the change history and undo a mistake',

  // ── Setup code (prevents someone else claiming the first admin — 2026-10-02) ───────────────────────
  '설치 코드': 'Setup code',

  // ── Trial · sign-up (2026-10-04) ──────────────────────────────────────
  '체험 버전입니다': 'This is a trial server',
  '체험 버전 안내': 'About the trial',
  '가입 없이 바로 써 볼 수 있습니다': 'Try it now — no sign-up needed',
  '아이디': 'ID',
  '데모 계정으로 들어가기': 'Enter with the demo account',
  '열기 · 고치기 · 검사 · 자동 고치기 — 전부 됩니다': 'Open, edit, validate and quick-fix — all available',
  '체험 버전은 일정 시간 후 초기화됩니다': 'The trial is reset after a while',
  '견본은 회원가입 후 사용할 수 있습니다.': 'Samples are available after you sign up.',
  '파일 내려받기는 회원가입 후에 됩니다': 'Downloading files requires signing up',
  '또는 내 계정으로 로그인': 'or sign in with your own account',

  // ── Account management (2026-10-04) ──────────────────────────────────────────────
  '설정 — 언어 · 계정 · 규칙': 'Settings — language, accounts, rules',
  '계정': 'Accounts',
  '계정 관리': 'Manage accounts',
  '내 비밀번호 바꾸기': 'Change my password',
  '사람을 더하고, 역할을 바꾸고, 잠급니다. 내 비밀번호도 여기서 바꿉니다':
    'Add people, change roles and lock accounts. Change your own password here too',
  '이 계정의 비밀번호를 바꿉니다': 'Change the password of this account',
  '관리자': 'Admin',
  '편집자': 'Editor',
  '열람자': 'Viewer',
  '지금 비밀번호': 'Current password',
  '새 비밀번호': 'New password',
  '새 비밀번호 확인': 'Confirm new password',
  '비밀번호 바꾸기': 'Change password',
  '비밀번호를 바꿨습니다.': 'Password changed.',
  '사람들': 'People',
  '역할': 'Role',
  '마지막 로그인': 'Last sign-in',
  '나': 'me',
  '역할을 바꿨습니다.': 'Role changed.',
  '비밀번호 초기화': 'Reset password',
  '비밀번호를 바꿨습니다. 그 사람은 다시 로그인해야 합니다.': 'Password changed. That person must sign in again.',
  '이 비밀번호로 바꾸기': 'Set this password',
  '잠그기': 'Lock',
  '잠금 풀기': 'Unlock',
  '잠갔습니다.': 'Locked.',
  '잠금을 풀었습니다.': 'Unlocked.',
  '잠그면 그 사람은 들어오지 못합니다. 지우지는 않습니다 — 변경 이력의 이름이 남아야 합니다.':
    'A locked person cannot sign in. The account is not deleted — their name must stay in the change history.',
  '사람 더하기': 'Add a person',
  '처음 비밀번호': 'Initial password',
  '관리자 — 전부 · 편집자 — 열고 고치기 · 열람자 — 보기만':
    'Admin — everything · Editor — open and edit · Viewer — read only',
  '계정 만들기': 'Create account',
  '계정을 만들었습니다.': 'Account created.',
  '개인정보처리방침': 'Privacy policy',
  '에 동의합니다.': '.',
  '연락처를 적으셨습니다 — 처리방침에 동의해 주십시오.':
    'You entered a contact address — please agree to the privacy policy.',
  '탈퇴 — 계정 지우기': 'Delete my account',
  '이 계정을 지웁니다. 되돌릴 수 없습니다.': 'Deletes this account. This cannot be undone.',
  '정말 탈퇴하시겠습니까?': 'Delete your account?',
  '계정과 연락처가 지워집니다. 올린 파일과 변경 이력은 서버에 그대로 남습니다.':
    'Your account and contact details are deleted. Uploaded files and the change history stay on the server.',
  '탈퇴합니다': 'Delete account',
  '올린 파일은 다른 방문자에게 보이지 않습니다. 한동안 쓰지 않으면 지워지고, 로그인을 새로 하면 빈 칸에서 시작합니다.':
    'Other visitors cannot see your uploads. They are deleted after a period of inactivity, and a new sign-in starts with an empty workspace.',
  '회원가입하면 내려받을 수 있습니다': 'Sign up to download',
  '회원가입': 'Sign up',
  '계정이 없습니다 — 회원가입': 'No account yet — sign up',
  '← 로그인으로 돌아가기': '← Back to sign in',
  '가입하고 시작하기': 'Create account and start',
  '계정을 만들면 작업한 파일을 내려받을 수 있습니다.':
    'With your own account you can download the files you work on.',
  '데모 계정': 'Demo account',
  '데모 계정으로는 파일을 내려받을 수 없습니다. 올린 파일은 다른 방문자에게 보이지 않고, 한동안 쓰지 않으면 지워집니다.':
    'The demo account cannot download files. Other visitors cannot see your uploads, and they are deleted after a period of inactivity.',
  '데모 계정으로는 내려받을 수 없습니다 — 눌러서 계정을 만드십시오.':
    'The demo account cannot download — click to create your own account.',
  '연락처 (선택)': 'Contact (optional)',
  '비워 두셔도 됩니다': 'You may leave this blank',
  '연락이 필요할 때만 씁니다. 확인 메일은 보내지 않습니다.':
    'Used only if we need to reach you. No verification email is sent.',
  '첫 관리자 만들기': 'Create the first administrator',
  '계정과 로그인을 쓰기 시작합니다 — 지금은 누구나 들어올 수 있습니다':
    'Start using accounts and sign-in. Right now anyone can get in.',
  '그만두기': 'Cancel',
  '이 서버를 띄운 화면(기동 로그)에 적혀 있습니다 — 아무나 관리자가 되지 않게 하는 값입니다.':
    'Shown in the server startup log. It stops a stranger from claiming the admin account.',

  // ── Change history pane (audit log — 2026-10-02) ───────────────────────────────
  '변경 이력 {n}건': 'Change history ({n})',
  '아직 변경한 적이 없습니다 — 처음 만든 그대로입니다.':
    'No changes yet — this is as first created.',
  '지워지기 전': 'before deletion',
  '고치기 전 (요소 {n}개)': 'before edit ({n} elements)',
  '이 시점의 내용으로 되돌립니다 — 그 뒤에 고친 것은 사라집니다':
    'Restores the contents as of this point — anything changed after it is lost',
  '이 버전으로 되돌리기': 'Restore this version',
  '되돌리기 자체도 이력에 남습니다 — 되돌린 것을 또 되돌릴 수 있습니다.':
    'Restoring is itself recorded, so a restore can be undone again.',
  '대표 사진 (defaultThumbnail)': 'Thumbnail (defaultThumbnail)',
  'definition (en) — KOSMO-CD-3 필수': 'definition (en) — required by KOSMO-CD-3',
  'definition (ko) — 문서용, 비워도 됨': 'definition (ko) — for documents, may be empty',
  '영문 정의가 비면 KOSMO-CD-3 위반입니다': 'An empty English definition breaks KOSMO-CD-3',
  '정의가 idShort와 같습니다 — 도구가 임시로 채운 것입니다. 뜻풀이를 적어 주십시오.':
    'The definition is the same as the idShort — the tool filled it in for now. Please write what it means.',
  '아직 파일이 붙어 있지 않습니다.': 'No file attached yet.',
  '영문으로 시작하고 영문·숫자·밑줄만 쓰는 편이 안전합니다(표준 권고).':
    'Start with a letter and use only letters, digits and underscores (recommended by the standard).',
  '순서는 왼쪽 트리에서 끌어서 바꿉니다 (또는 우클릭 · Alt+↑↓)':
    'Reorder by dragging in the tree on the left (or right-click · Alt+↑↓)',
  '본 사업 산출물은 형식(Type) 단위입니다(KOSMO-AAS-6).':
    'Deliverables in this project are Type-level (KOSMO-AAS-6).',
  'semanticId (IRDI 또는 자체 IRI)': 'semanticId (IRDI or own IRI)',
  'semanticId (표준 템플릿 IRI 또는 IRDI)': 'semanticId (standard template IRI or IRDI)',
  // valueType picker
  글자: 'text',
  '참/거짓': 'true/false',
  정수: 'integer',
  소수: 'decimal',
  날짜: 'date',
  '날짜+시각': 'date and time',
  '주소 (URL·IRI)': 'address (URL·IRI)',
  // Edit pane — tooltips
  '이 언어 줄을 뺍니다': 'Remove this language row',
  '언어 줄을 하나 더 만듭니다 — 같은 뜻을 ko·en으로 나란히 적습니다':
    'Add one more language row — write the same meaning in ko and en side by side',
  '이 요소의 언어별 글을 서버에 바로 반영합니다 — 되돌리려면 헤더의 ↶':
    'Saves the per-language text to the server right away — undo with ↶ in the header',
  '최소·최대를 서버에 바로 반영합니다 — 되돌리려면 헤더의 ↶':
    'Saves min and max to the server right away — undo with ↶ in the header',
  '이 요소의 값을 서버에 바로 반영합니다 — 되돌리려면 헤더의 ↶':
    'Saves this value to the server right away — undo with ↶ in the header',
  '표에서 고친 값을 한 번에 반영합니다 — 요소마다 누르지 않아도 됩니다':
    'Saves everything you changed in the table at once — no need to save each element',
  'idShort를 바꿉니다 — 이 이름을 가리키던 다른 요소의 참조는 따라오지 않습니다':
    'Renames the idShort — references elsewhere that point to this name do NOT follow',
  '이 요소에 담긴 파일을 내려받습니다': 'Downloads the file held by this element',
  '담긴 파일을 파일 안에서 뺍니다 — 되돌리려면 헤더의 ↶':
    'Removes the attached file from the package — undo with ↶ in the header',
  'semanticId를 반영합니다 — 뜻을 가리키는 주소라 Validator가 가장 먼저 봅니다':
    'Saves the semanticId — it is the address of the meaning, the first thing the Validator checks',
  '이 안에 새 요소를 만듭니다': 'Creates a new element inside this one',
  '안의 요소와 값까지 그대로 하나 더 — 두 번째 인증 마크·문서·연락처를 넣을 때 (이름 끝에 _2)':
    'One more copy including inner elements and values — for a second marking, document or contact (name ends with _2)',
  '잘못 지웠으면 「↶ 되돌리기」': 'Deleted by mistake? Use ↶ Undo',
  '자산 정보(종류·globalAssetId)를 반영합니다 — 묶음에서 설비를 가리키는 주소가 이것입니다':
    'Saves the asset information (kind · globalAssetId) — this is the address a group file points at',
  '예: -10~60': 'e.g. -10~60',
  '예: mm · kg · °C': 'e.g. mm · kg · °C',
  // semanticId validation messages (model.ts)
  '표준 사전 IRDI 형식입니다.': 'Valid IRDI from a standard dictionary.',
  '표준 사전 IRDI 복합형입니다 — 「속성/클래스」를 연결한 형식으로, IDTA 템플릿이 리스트 항목에 사용합니다.':
    'Compound IRDI from a standard dictionary — property/class joined, as IDTA templates use for list items.',
  'IRDI 접두는 맞지만 형식이 표준과 다릅니다. 사전에서 코드를 다시 확인하십시오.':
    'The IRDI prefix is right but the shape is not standard. Check the code in the dictionary again.',
  'eCl@ss 끝자리가 -00인 코드는 CDP에 없습니다. 리프 클래스까지 펼쳐 다시 확인하십시오.':
    'An eCl@ss code ending in -00 does not exist in CDP. Expand to the leaf class and check again.',
  '자체 IRI 규약에 맞습니다.': 'Matches the own-IRI convention.',
  'IDTA 공식 IRI입니다. KOSMO Validator는 이를 거부합니다(규정 충돌 ①).':
    'This is an official IDTA IRI. The KOSMO Validator rejects it (rule conflict ①).',
  '이 id의 ConceptDescription이 파일에 없습니다. 「자동 고치기」가 규약대로 만들어 줍니다.':
    'No ConceptDescription with this id exists in the file. Auto-fix will create one per the convention.',
  // ── Summary pane · BoM · tree (2026-10-02, round 3) ───────────
  '이 파일에 넣기': 'Add to this file',
  '＋ 서브모델': '＋ Submodel',
  '＋ 부품': '＋ Part',
  '＋ 설비': '＋ Equipment',
  '＋ 공정': '＋ Process',
  '＋ 조립체': '＋ Assembly',
  '공정·그룹': 'Processes / groups',
  '자체 서브모델': 'Own submodels',
  '서브모델 (설비 포함)': 'Submodels (incl. equipment)',
  '요소 (설비 포함)': 'Elements (incl. equipment)',
  요소: 'Elements',
  '이관 대장': 'Relocation ledger',
  'IDTA 공식 IRI를 자체 IRI로 옮긴 것': 'Official IDTA IRIs moved to own IRIs',
  '원본 IRI로 되돌리기': 'Restore original IRIs',
  '필수 서브모델이 빠졌습니다:': 'Required submodels are missing:',
  '왼쪽 트리에서 요소를 고르면 여기에서 값을 고칠 수 있습니다.':
    'Pick an element in the tree on the left to edit its value here.',
  '명판·기술사양·운전데이터 같은 내용 묶음': 'A content set such as nameplate, technical data or operational data',
  '이 설비를 이루는 부품(BoM) — HierarchicalStructures에 들어갑니다':
    'Parts that make up this equipment (BoM) — stored in HierarchicalStructures',
  '올려 둔 설비 .aasx를 이 공정에 넣습니다': 'Puts an uploaded equipment .aasx into this process',
  '파일 없는 단계 — 공정·라인. 회사 바로 밑에 만듭니다':
    'A layer without a file — a process or line, created right under the company',
  '이 공정 자체의 내용(명판 등)': 'Content of the process itself (nameplate and so on)',
  '설비 한 대의 AAS — 서브모델과 부품을 넣습니다': 'AAS of one piece of equipment — holds submodels and parts',
  '공정·회사(묶음)의 AAS — 설비와 공정·라인을 넣습니다': 'AAS of a process or company — holds equipment and layers',
  '공정·회사': 'Process / company',
  설비: 'Equipment',
  '장비 정보 없음': 'No equipment information',
  '경고도 없습니다.': 'No warnings either.',
  '계층 구조가 비어 있습니다.': 'The hierarchy is empty.',
  '읽는 중…': 'Loading…',
  '이 설비 파일 열기 →': 'Open this equipment file →',
  '서브모델 펼쳐 보기': 'Show submodels',
  '부품 구성 (BoM)': 'Parts (BoM)',
  '공정·설비 구성': 'Processes and equipment',
  '회사·묶음': 'Company / group',
  'AAS 계층': 'AAS tree',
  '이 항목으로 할 수 있는 일 (우클릭도 됩니다)': 'What you can do with this item (right-click works too)',
  // Tree context menu
  '사본 만들기 (복제)': 'Duplicate',
  '↑ 한 칸 위로': '↑ Move up',
  '↓ 한 칸 아래로': '↓ Move down',
  '이 설비에 서브모델 추가': 'Add a submodel to this equipment',
  '규칙 검사를 통과했습니다.': 'The rule check passed.',
  '이 설비를 이루는 부품입니다 — 이 파일의 HierarchicalStructures 서브모델(IDTA 02011)에 저장됩니다.':
    'The parts this equipment is made of — stored in this file’s HierarchicalStructures submodel (IDTA 02011).',
  '호기별': 'per unit',
  대: ' units',
  공정: 'Process',
  조립체: 'Assembly',
  부품: 'Part',
  '공정·라인 — 파일 없는 단계': 'Process or line — a layer without a file',
  '조립체·모듈 — 부품을 묶는 단계': 'Assembly or module — a layer that groups parts',
  '공정 이름 — 예: WeldingProcess (Enter로 연달아)': 'Process name — e.g. WeldingProcess (Enter to add another)',
  '조립체 이름 — 예: DriveUnit (Enter로 연달아)': 'Assembly name — e.g. DriveUnit (Enter to add another)',
  '이름만 — 예: PressMachine2': 'Name only — e.g. PressMachine2',
  '부품 이름 — 예: MainMotor': 'Part name — e.g. MainMotor',
  // Important: keep sentences containing numbers **whole**. Splitting them into fragments and joining breaks English word order
  //    ("Warnings 10of 10of them are cleared…" — measured 2026-10-02)
  '규칙 위반 {n}건': '{n} rule errors',
  '경고 {n}건 중 {m}건은 위 「자동 고치기」로 함께 지워집니다.':
    'Of {n} warnings, {m} are cleared by Auto-fix above.',
  '경고 {n}건은 확인만 하십시오.': '{n} warnings — please just review them.',
  'semanticId가 없으면 {rule} 위반입니다.': 'Without a semanticId this breaks {rule}.',
  '허용 목록 밖입니다. IRDI({prefixes}) 또는 {base}/... 형식이어야 합니다.':
    'Not in the allowed list. It must be an IRDI ({prefixes}) or {base}/…',
  // Login (2026-10-02)
  로그인: 'Sign in',
  로그아웃: 'Sign out',
  '로그인 이름': 'Login name',
  '표시 이름': 'Display name',
  비밀번호: 'Password',
  '비밀번호 확인': 'Confirm password',
  '로그인하십시오.': 'Please sign in.',
  '계정이 하나도 없습니다 — 처음 쓰는 서버입니다. 관리자 계정을 만드십시오.':
    'There are no accounts yet — this server is new. Create an administrator account.',
  '비워 두면 로그인 이름을 씁니다': 'Leave empty to use the login name',
  '비밀번호는 10자 이상이어야 합니다.': 'The password must be at least 10 characters.',
  '두 비밀번호가 다릅니다.': 'The two passwords do not match.',
  '관리자 만들기': 'Create administrator',
  '확인 중…': 'Checking…',
  // Common buttons
  닫기: 'Close',
  취소: 'Cancel',
  저장: 'Save',
  확인: 'OK',
  지우기: 'Delete',
  '다시 읽기': 'Reload',
};

/**
 * The chosen language. If none was chosen, follow the **browser language** — Korean for a Korean browser, English otherwise
 * (product owner, 2026-10-14: "prioritize global"). A choice once made is remembered.
 */
export function readLang(): Lang {
  let stored: string | null = null;
  try {
    stored = window.localStorage.getItem(KEY);
  } catch {
    // localStorage throws in private windows — fall back to the browser language
  }
  if (stored === 'en' || stored === 'ko') return stored;
  return browserLang();
}

/** The browser's first preferred language — ko if Korean, en otherwise (including unknown) */
export function browserLang(languages: readonly string[] | undefined = globalThis.navigator?.languages): Lang {
  const first = languages?.[0] ?? globalThis.navigator?.language ?? '';
  return first.toLowerCase().startsWith('ko') ? 'ko' : 'en';
}

export function writeLang(lang: Lang): void {
  try {
    window.localStorage.setItem(KEY, lang);
  } catch {
    /* Even if it cannot be saved, it applies for this load */
  }
}

/** Translator — if missing from the dictionary, returns the given Korean as is */
export function translator(lang: Lang): (text: string) => string {
  if (lang === 'ko') return (text) => text;
  return (text) => EN[text] ?? EN_MORE[text] ?? EN_METAMODEL[text] ?? text;
}

/**
 * Placeholder substitution — inserts numbers into `t('경고 {n}건…')` afterwards.
 * Important: translate the whole sentence, then insert only the numbers. Joining fragments wrecks English word order.
 */
export function fill(text: string, values: Record<string, string | number | undefined | null>): string {
  // Important: replace everything in one pass. Replacing one at a time means that if an earlier inserted value contains text like `{1}`,
  //    that gets replaced in the next round too (file names and user input can be anything)
  return text.replace(/\{(\w+)\}/g, (whole, key: string) => (key in values ? String(values[key] ?? '') : whole));
}

/**
 * Current language — fixed once when the module loads.
 *
 * Important: switching language **reloads the screen** (Settings does that). If it were only held as state and re-rendered,
 *    label tables written at the top of files (`const LABELS = {...}`) would stay frozen in the language first loaded,
 *    and only half would change. Language is not switched several times a day, so reloading is the reliable choice.
 */
const current: Lang = readLang();

/** Locale for date · time · number formats — follows the chosen language (left to the browser default, an English screen shows times with the Korean AM marker, e.g. "8:00" prefixed in Korean) */
export function locale(): string {
  return current === 'en' ? 'en-US' : 'ko-KR';
}

/** Current language — the value sent to the server (api/http.ts) */
export function currentLang(): Lang {
  return current;
}

// Important: server package code (e.g. CSV reading in @aas/linter) also runs inside the screen — its text uses the same language too
setLangSource(() => current);

// Match the document language too — screen readers, browser translation offers and spell check read this value (index.html default is ko)
if (typeof document !== 'undefined') document.documentElement.lang = current;

/**
 * One piece of text in the current language. If missing from the dictionary, returns the given Korean as is.
 *
 * Exists so `t` does not have to be passed down as a prop to every component — threading it through twenty components
 * one by one means one gets missed and that screen alone stays Korean. The `t` prop still works too (it does the same thing).
 */
export function tr(text: string): string {
  return current === 'ko' ? text : (EN[text] ?? EN_MORE[text] ?? EN_METAMODEL[text] ?? text);
}

/**
 * For showing a **value** the server provided — something the server holds as Korean data, such as bundle category names.
 * Looks it up in the server dictionary (@aas/core). The value itself is unchanged; only the displayed text is translated (the original value is sent back).
 */
export function trServerValue(text: string): string {
  return current === 'ko' ? text : (lookupEn(text) ?? text);
}
