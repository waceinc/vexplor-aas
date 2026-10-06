/**
 * 화면 글자의 언어.
 *
 * 🔴 **화면 글자는 전부 영어가 있다. 서버가 만드는 글은 아직 한국어다.** 린터의 지적 문구·
 *    규칙 설명·검증 결과서·번들 README가 그렇다(KOSMO·KTL 규격 용어가 많아 따로 옮겨야
 *    한다). 설정 화면이 그 사실을 먼저 말한다 — 모르고 쓰면 "번역이 깨졌다"로 읽힌다.
 *
 * 🔴 **화면에 한국어를 새로 적으면 `tr()`·`<T>`로 감싸고 사전(en.ts)에 넣는다.** 빠뜨리면
 *    CI가 멈춘다(`node scripts/i18n-scan.mjs --check`). 사전에 없어도 화면은 한국어로
 *    나오므로(폴백) 깨지지는 않지만, 영어 화면의 그 자리만 한국어로 남는다.
 *
 * 🔴 사전은 **한국어 글자 자체를 열쇠로** 쓴다. `t('열기')`처럼. 열쇠를 따로 만들면
 *    (`header.open` 같은) 코드에서 무슨 글자인지 안 보이고, 사전에 없을 때 빈칸이 뜬다.
 *    한국어를 열쇠로 두면 **못 찾아도 한국어가 그대로 나온다** — 최악이 "안 번역됨"이다.
 */
import { EN_MORE } from './en.js';

export type Lang = 'ko' | 'en';

const KEY = 'aas.lang';

/** 영어 사전 — 없는 열쇠는 한국어 그대로 나간다 */
const EN: Record<string, string> = {
  // 헤더 — 파일
  파일: 'File',
  'AASX 열기': 'Open AASX',
  '새로 만들기': 'New',
  '번들 열기': 'Open bundle',
  '파일 목록': 'File list',
  '열린 파일 없음': 'No file open',
  '— 파일 고르기 —': '— choose a file —',
  // 헤더 — 편집·검사
  '↶ 되돌리기': '↶ Undo',
  서브모델: 'Submodels',
  '서브모델 추가': 'Add submodel',
  '다른 파일에서 가져오기': 'Import from another file',
  '자동 고치기': 'Auto-fix',
  // 헤더 — 제출
  뽑아내기: 'Export',
  '검증 결과서': 'Validation report',
  '문서용 자료': 'Document assets',
  '레퍼런스 번들': 'Reference bundle',
  'AASX 내려받기': 'Download AASX',
  // 헤더 — 상태·설정
  위반: 'Errors',
  경고: 'Warnings',
  '→ 내주는 중': '→ Serving',
  '규칙과 규약 보기': 'Rules and conventions',
  '토큰 지우기': 'Clear token',
  언어: 'Language',
  설정: 'Settings',
  '처리 중…': 'Working…',
  // 첫 화면
  '서버에 올려 둔 파일이 있습니다 — 아래에서 골라 이어서 작업하거나, 새 파일을 엽니다.':
    'You have files on the server — pick one below to continue, or open a new one.',
  'AASX 파일을 열면 계층 트리·규칙 지적·수집이 한 화면에 뜹니다.':
    'Open an AASX file to see its tree, rule findings and collected values on one screen.',
  'AASX 파일 열기': 'Open AASX file',
  '이어서 작업하기': 'Continue working',
  '올려 둔 파일': 'files on the server',
  건: '',
  // ── 편집 칸(Inspector) — 버튼과 라벨 (2026-10-02) ──────────────────
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
  // ── 수집 칸(OPC UA) — 2026-10-02 ──────────────────────────────────
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
  // ── 편집 칸 — 라벨·안내·고르개 (2026-10-02 2차) ────────────────────
  위치: 'Location',
  이름: 'Name',
  내용: 'Text',
  '변경 이력을 보고 실수를 되돌립니다': 'See the change history and undo a mistake',

  // ── 설치 코드 (첫 관리자 선점 방지 — 2026-10-02) ───────────────────────
  '설치 코드': 'Setup code',

  // ── 체험판 · 회원가입 (2026-10-04) ──────────────────────────────────────
  '체험판입니다': 'This is a trial server',
  '체험판 안내': 'About the trial',
  '가입 없이 바로 써 볼 수 있습니다': 'Try it now — no sign-up needed',
  '아이디': 'ID',
  '체험 계정으로 들어가기': 'Enter with the trial account',
  '열기 · 고치기 · 검사 · 자동 고치기 — 전부 됩니다': 'Open, edit, validate and quick-fix — all available',
  '올린 파일은 나만 봅니다 · 한동안 안 쓰면 지워집니다': 'Only you see your uploads. They are deleted after a period of inactivity',
  '파일 내려받기는 회원가입 후에 됩니다': 'Downloading files requires signing up',
  '또는 내 계정으로 로그인': 'or sign in with your own account',

  // ── 계정 관리 (2026-10-04) ──────────────────────────────────────────────
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
  '체험 계정': 'Trial account',
  '체험 계정으로는 파일을 내려받을 수 없습니다. 올린 파일은 다른 방문자에게 보이지 않고, 한동안 쓰지 않으면 지워집니다.':
    'The trial account cannot download files. Other visitors cannot see your uploads, and they are deleted after a period of inactivity.',
  '체험 계정으로는 내려받을 수 없습니다 — 눌러서 계정을 만드십시오.':
    'The trial account cannot download — click to create your own account.',
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

  // ── 변경 이력 칸 (감사 기록 — 2026-10-02) ───────────────────────────────
  '변경 이력 {n}건': 'Change history ({n})',
  '아직 변경한 적이 없습니다 — 처음 만든 그대로입니다.':
    'No changes yet — this is as first created.',
  '지워지기 전': 'before deletion',
  '고치기 전 (요소 {n}개)': 'before edit ({n} elements)',
  '이 시점의 내용으로 되돌립니다 — 그 뒤에 고친 것은 사라집니다':
    'Restores the contents as of this point — anything changed after it is lost',
  '이 판으로 되돌리기': 'Restore this version',
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
  // valueType 고르개
  글자: 'text',
  '참/거짓': 'true/false',
  정수: 'integer',
  소수: 'decimal',
  날짜: 'date',
  '날짜+시각': 'date and time',
  '주소 (URL·IRI)': 'address (URL·IRI)',
  // 편집 칸 — 툴팁
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
  // semanticId 검증 말 (model.ts)
  '표준 사전 IRDI 형식입니다.': 'Valid IRDI from a standard dictionary.',
  '표준 사전 IRDI 복합형입니다 — 「속성/클래스」를 이은 형식으로, IDTA 템플릿이 리스트 항목에 씁니다.':
    'Compound IRDI from a standard dictionary — property/class joined, as IDTA templates use for list items.',
  'IRDI 접두는 맞지만 형식이 표준과 다릅니다. 사전에서 코드를 다시 확인하십시오.':
    'The IRDI prefix is right but the shape is not standard. Check the code in the dictionary again.',
  'eCl@ss 말미 -00 코드는 CDP에 존재하지 않습니다. 리프 클래스까지 전개해 재확인하십시오.':
    'An eCl@ss code ending in -00 does not exist in CDP. Expand to the leaf class and check again.',
  '자체 IRI 규약에 맞습니다.': 'Matches the own-IRI convention.',
  'IDTA 공식 IRI입니다. KOSMO Validator는 이를 거부합니다(규정 충돌 ①).':
    'This is an official IDTA IRI. The KOSMO Validator rejects it (rule conflict ①).',
  '이 id를 가진 ConceptDescription이 파일에 없습니다. 「자동 고치기」가 규약대로 만들어 줍니다.':
    'No ConceptDescription with this id exists in the file. Auto-fix will create one per the convention.',
  // ── 요약 칸(Summary) · 부품 구성 · 트리 (2026-10-02 3차) ───────────
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
  '파일 없는 층 — 공정·라인. 회사 바로 밑에 만듭니다':
    'A layer without a file — a process or line, created right under the company',
  '이 공정 자체의 내용(명판 등)': 'Content of the process itself (nameplate and so on)',
  '설비 한 대의 AAS — 서브모델과 부품을 넣습니다': 'AAS of one piece of equipment — holds submodels and parts',
  '공정·회사(묶음)의 AAS — 설비와 층을 넣습니다': 'AAS of a process or company — holds equipment and layers',
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
  // 트리 우클릭 메뉴
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
  '공정·라인 — 파일 없는 층': 'Process or line — a layer without a file',
  '조립체·모듈 — 부품을 묶는 층': 'Assembly or module — a layer that groups parts',
  '공정 이름 — 예: WeldingProcess (Enter로 연달아)': 'Process name — e.g. WeldingProcess (Enter to add another)',
  '조립체 이름 — 예: DriveUnit (Enter로 연달아)': 'Assembly name — e.g. DriveUnit (Enter to add another)',
  '이름만 — 예: PressMachine2': 'Name only — e.g. PressMachine2',
  '부품 이름 — 예: MainMotor': 'Part name — e.g. MainMotor',
  // 🔴 숫자가 끼는 문장은 **통째로** 둔다. 조각으로 나눠 이으면 영어 어순이 깨진다
  //    ("Warnings 10of 10of them are cleared…" — 2026-10-02 실측)
  '규칙 위반 {n}건': '{n} rule errors',
  '경고 {n}건 중 {m}건은 위 「자동 고치기」로 함께 지워집니다.':
    'Of {n} warnings, {m} are cleared by Auto-fix above.',
  '경고 {n}건은 확인만 하십시오.': '{n} warnings — please just review them.',
  'semanticId가 없으면 {rule} 위반입니다.': 'Without a semanticId this breaks {rule}.',
  '허용 목록 밖입니다. IRDI({prefixes}) 또는 {base}/... 형식이어야 합니다.':
    'Not in the allowed list. It must be an IRDI ({prefixes}) or {base}/…',
  // 로그인 (2026-10-02)
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
  // 공통 버튼
  닫기: 'Close',
  취소: 'Cancel',
  저장: 'Save',
  확인: 'OK',
  지우기: 'Delete',
  '다시 읽기': 'Reload',
};

export function readLang(): Lang {
  try {
    return window.localStorage.getItem(KEY) === 'en' ? 'en' : 'ko';
  } catch {
    return 'ko'; // 사생활 보호 창에서는 localStorage가 던진다 — 한국어로 간다
  }
}

export function writeLang(lang: Lang): void {
  try {
    window.localStorage.setItem(KEY, lang);
  } catch {
    /* 저장 못 해도 이번 판에는 적용된다 */
  }
}

/** 번역기 — 사전에 없으면 받은 한국어를 그대로 돌려준다 */
export function translator(lang: Lang): (text: string) => string {
  if (lang === 'ko') return (text) => text;
  return (text) => EN[text] ?? EN_MORE[text] ?? text;
}

/**
 * 자리 치환 — `t('경고 {n}건…')` 뒤에 숫자를 꽂는다.
 * 🔴 문장을 통째로 옮긴 뒤 숫자만 넣는다. 토막을 이어 붙이면 영어 어순이 무너진다.
 */
export function fill(text: string, values: Record<string, string | number | undefined | null>): string {
  // 🔴 한 번에 갈아 끼운다. 하나씩 차례로 바꾸면, 먼저 넣은 값 안에 `{1}` 같은 글자가
  //    들어 있을 때 그것까지 다음 차례에 바뀐다(파일 이름·사용자 입력은 무엇이든 될 수 있다)
  return text.replace(/\{(\w+)\}/g, (whole, key: string) => (key in values ? String(values[key] ?? '') : whole));
}

/**
 * 지금 언어 — 모듈이 읽힐 때 한 번 정해진다.
 *
 * 🔴 언어를 바꾸면 **화면을 새로 읽는다**(Settings가 그렇게 한다). 상태로 들고 다시 그리게만
 *    하면, 파일 맨 위에 적어 둔 글자표(`const LABELS = {...}`)는 처음 읽힌 언어로 굳어 있어
 *    반쪽만 바뀐다. 언어는 하루에 몇 번씩 바꾸는 것이 아니므로 새로 읽는 쪽이 확실하다.
 */
const current: Lang = readLang();

/**
 * 글자 하나를 지금 언어로. 사전에 없으면 받은 한국어를 그대로 돌려준다.
 *
 * 컴포넌트마다 `t`를 속성으로 내려 주지 않아도 되게 하려고 둔 것이다 — 스무 개 컴포넌트에
 * 일일이 꿰면 한 군데가 빠져 그 화면만 한국어로 남는다. `t` 속성도 그대로 쓸 수 있다(같은 일을 한다).
 */
export function tr(text: string): string {
  return current === 'ko' ? text : (EN[text] ?? EN_MORE[text] ?? text);
}
