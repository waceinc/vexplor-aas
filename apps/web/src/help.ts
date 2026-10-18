/**
 * In-screen help — find answers on the spot without opening a separate manual (user request 2026-10-08).
 *
 * Important: **the text lives in this one place**. The help panel, the guided tour and the getting-started list all use this file.
 *    Whoever changes a feature edits this file in the same repository, so it does not drift from the screen and go stale
 *    the way a manual (PPT) does.
 * Important: exposed as functions — switching language re-reads the screen, so each call translates into the current language (tr).
 */
import { currentLang, tr } from './i18n.js';

export type HelpContext = 'start' | 'open' | 'edit' | 'check';

export interface HelpTopic {
  id: string;
  title: string;
  summary: string;
  steps: string[];
  /** Extra things to know — caveats · tips */
  note?: string;
  /** A guide outside the screen, opened in a new window */
  link?: { label: string; href: string };
}

const GUIDE = 'https://github.com/waceinc/vexplor-aas/blob/main/docs/';
// i18n-ignore — file names of the guide in this repository, not UI text
const LOGIC_STUDIO_GUIDE = { ko: '로직스튜디오.md', en: 'logic-studio.md' } as const;
// i18n-ignore — the remote collector is its own repository; its README in each language
const EDGE_GUIDE = { ko: 'https://github.com/waceinc/vexplor-edge/blob/main/README.ko.md', en: 'https://github.com/waceinc/vexplor-edge/blob/main/README.md' } as const;

export function helpTopics(): HelpTopic[] {
  return [
    {
      id: 'start',
      title: tr('시작하기'),
      summary: tr('회원은 로그인, 처음이면 회원가입. 가입 없이 데모 계정으로도 둘러볼 수 있습니다.'),
      steps: [
        tr('회원 — 로그인 이름과 비밀번호를 넣고 「로그인」'),
        tr('처음이면 — 「처음이신가요? 회원가입」. 가입하면 작업한 파일을 내려받을 수 있습니다'),
        tr('데모 계정 — 공용 계정이라 파일 내려받기와 견본 열기가 막혀 있고, 일정 시간 후 초기화됩니다'),
      ],
      note: tr('비밀번호를 5번 틀리면 5분 동안 그 계정으로 로그인할 수 없습니다.'),
    },
    {
      id: 'screen',
      title: tr('화면 구성'),
      summary: tr('머리줄 아래에 트리 · 내용 · 수집 세 칸이 있습니다.'),
      steps: [
        tr('왼쪽 위 「VEXPLOR AAS Studio」 — 누르면 언제든 첫 화면으로 돌아갑니다(열어 둔 파일은 그대로)'),
        tr('머리줄 — 파일 · 서브모델 · 자동 고치기 · 검사 결과 · 내보내기 · 내려받기 · 설정'),
        tr('트리(왼쪽) — AAS → 서브모델 → 요소 순서로 펼쳐집니다. 고르면 가운데에 내용이 나옵니다'),
        tr('내용(가운데) — 요약 · 값 고치기 · 부품 구성'),
        tr('수집(오른쪽) — 설비에서 값을 가져옵니다(OPC UA)'),
      ],
      note: tr('칸 사이 경계를 끌면 너비를 바꿀 수 있습니다.'),
    },
    {
      id: 'open',
      title: tr('파일 열기'),
      summary: tr('내 PC의 AASX를 올리거나, 새로 만들거나, 견본으로 시작합니다.'),
      steps: [
        tr('「AASX 파일 열기」 — 내 PC의 .aasx를 올려 엽니다'),
        tr('「새로 만들기」 — 설비 한 대 또는 회사 · 공정 그룹. 필수 서브모델 4종이 자동으로 들어갑니다'),
        tr('「번들 열기」 — 이 도구에서 내보낸 레퍼런스 번들(.zip)을 엽니다'),
        tr('「견본으로 시작하기」 — 내용이 채워진 연습용 견본(회원)'),
      ],
      note: tr('같은 파일을 다시 올리면 사본이 생깁니다. 작업하던 파일은 「파일 ▾ → 파일 목록」에서 고르세요.'),
    },
    {
      id: 'edit',
      title: tr('값 고치기'),
      summary: tr('왼쪽 트리에서 요소를 고르면 가운데에서 고칩니다. 저장하면 서버에 바로 반영됩니다.'),
      steps: [
        tr('요소 하나 — 트리에서 고르고 값을 바꾼 뒤 「저장」'),
        tr('한꺼번에 — 서브모델을 고르면 「값 한꺼번에 입력」 표가 나옵니다'),
        tr('가져오기 — 「서브모델 ▾ → 다른 파일에서 가져오기」로 견본의 서브모델을 통째로 복사'),
        tr('되돌리기 — 머리줄 「↶ 되돌리기」(Ctrl+Z), 지난 시점은 「이력 · 되돌리기」'),
      ],
      note: tr('가져온 값은 원본 설비의 값입니다. 이 설비에 맞게 고쳐 주세요.'),
    },
    {
      id: 'check',
      title: tr('검사와 자동 고치기'),
      summary: tr('파일을 열면 규칙 43종으로 바로 검사합니다. 위반은 반드시 고칩니다.'),
      steps: [
        tr('머리줄의 「위반 · 경고」를 누르면 검사 결과가 열립니다'),
        tr('위반(빨강) — KOSMO 규칙에 어긋남. 0건이 되도록 고칩니다'),
        tr('경고(노랑) — 표준 · 상호운용에 문제가 될 수 있음. 항목을 누르면 그 요소로 갑니다'),
        tr('「자동 고치기」 — 전 / 후를 미리 보고, 체크한 것만 고칩니다'),
      ],
      note: tr('이 도구의 검사는 사전 점검입니다. 공식 판정은 KOSMO Validator가 합니다.'),
    },
    {
      id: 'export',
      title: tr('내보내기'),
      summary: tr('검증 결과서 · 문서용 자료 · AASX를 내려받습니다.'),
      steps: [
        tr('「내보내기 ▾ → 검증 결과서」 — 인쇄 메뉴에서 PDF로 저장'),
        tr('「내보내기 ▾ → 문서용 자료」 — UML 그림 · 표 · .docx'),
        tr('「AASX 내려받기」 — 지금 파일을 .aasx로(회원만)'),
      ],
      note: tr('완성본은 위반 0건 상태에서 내려받으세요.'),
    },
    {
      id: 'logic-studio',
      title: tr('VEXPLOR Logic Studio에서 쓰기'),
      summary: tr('검사를 마친 AASX를 Logic Studio Cloud 설비 화면에 끌어 놓으면 설비 대장이 됩니다. 공장에 설치할 것도, 변환할 것도 없습니다.'),
      steps: [
        tr('「AASX 내려받기」로 위반 0건인 완성본을 받습니다'),
        tr('Logic Studio Cloud 설비 화면에 그 파일을 끌어 놓습니다'),
        tr('미리 보기에서 기종 · 설비 · 공장 · 라인을 확인하고 가져오면 설비가 기종에 연결된 채로 설비 대장에 들어갑니다'),
        tr('같은 파일을 다시 놓으면 바뀌는 것이 없고, 고친 파일을 놓으면 바뀐 것만 「변경 제안」으로 나옵니다'),
      ],
      note: tr('원격 수집기가 Logic Studio Cloud로 실시간 값을 보내는 연결은 준비 중입니다.'),
      // Important: the guide is a document in this repository, not a page of the product it describes — it says what
      //    this tool hands over (an AASX file) and nothing this tool does not do
      link: { label: tr('Logic Studio 연계 안내'), href: `${GUIDE}${LOGIC_STUDIO_GUIDE[currentLang()]}` },
    },
    {
      id: 'process',
      title: tr('공정과 레퍼런스 번들'),
      summary: tr('회사 → 공정 → 설비를 한 트리로 묶고, ZIP 하나로 내보냅니다.'),
      steps: [
        tr('「새로 만들기 → 그룹(회사 · 공정)」으로 공정 파일을 만듭니다'),
        tr('「＋ 공정」 「＋ 설비」로 구성합니다. 같은 기종 여러 대는 ×N'),
        tr('공정 파일에서 「내보내기 ▾ → 레퍼런스 번들」 — 구성 · 준비 상태를 보고 ZIP으로'),
      ],
    },
    {
      id: 'collect',
      title: tr('현장 값 수집'),
      summary: tr('오른쪽 「수집」 칸에서 설비(PLC)의 값을 가져옵니다.'),
      steps: [
        tr('실제 PLC가 없으면 「가상 PLC로 연결」 — 바로 시험할 수 있습니다'),
        tr('실제 설비는 「수집 연결 만들기」 — OPC UA 주소와 태그를 넣습니다'),
        tr('「수집」 — 지금 값을 한 번 읽어 옵니다. 「주소 목록」으로 수집 주소 표(CSV)'),
      ],
      note: tr('연결하면 파일에 수집 연결(AID)이 추가되어 「시연본」이 됩니다. 원본 파일에는 연결하지 마세요.'),
    },
    {
      id: 'edge',
      title: tr('원격 수집기 (VEXPLOR Edge) — 원클릭 연결'),
      summary: tr('이 서버가 공장 밖에 있을 때, 공장 PC 한 대에 수집기를 두어 설비 값을 받습니다. 단추 하나와 붙여 넣기 한 줄이면 연결됩니다.'),
      steps: [
        tr('「설정 ▾ → 원격 수집기」를 엽니다(꺼져 있으면 관리자가 「원격 수집 켜기」)'),
        tr('「+ 수집기 연결」 — 서버 주소와 읽을 목록을 확인하고 「연결 명령 만들기」'),
        tr('나온 한 줄을 공장 Linux PC의 터미널에 붙여 넣습니다 — 설치 · 등록 · 시작이 한 번에 끝납니다'),
        tr('화면에 「받는 중」이 뜨면 끝입니다. 이후 마지막 수신 · 설비 연결 상태를 같은 화면에서 봅니다'),
      ],
      note: tr('수집기는 승인한 목록만 읽고, 밖으로만 보냅니다(443). 공장으로 들어오는 연결 · 원격 정지는 없습니다. 지금은 Linux(x64 · arm64)용이고 Windows용은 준비 중입니다.'),
      link: { label: tr('VEXPLOR Edge 안내'), href: EDGE_GUIDE[currentLang()] },
    },
    {
      id: 'account',
      title: tr('내 계정'),
      summary: tr('「설정 ▾」에서 언어 · 내 계정 설정 · 로그아웃 · 탈퇴를 합니다.'),
      steps: [
        tr('「내 계정 설정」 — 표시 이름 · 회사명 · 이메일 · 비밀번호'),
        tr('「언어」 — 한국어 / English(이 브라우저에만 저장)'),
        tr('「탈퇴」 — 계정과 올린 파일이 바로 삭제되며 되돌릴 수 없습니다'),
      ],
      note: tr('비밀번호를 잊었다면 관리자에게 「비밀번호 초기화」를 요청하세요.'),
    },
  ];
}

/** Topic to show first for the current screen */
export function topicFor(context: HelpContext): string {
  return context === 'start' ? 'open' : context;
}

/** One step of the guided tour — the target is a CSS selector (+ the element containing the text) */
export interface TourStep {
  sel: string;
  text?: string;
  title: string;
  body: string;
}

/** On first entry — the welcome screen with no file yet */
export function welcomeTour(): TourStep[] {
  return [
    { sel: '.welcome button', text: tr('AASX 파일 열기'), title: tr('파일 열기'), body: tr('내 PC의 .aasx 파일을 올려 엽니다. 여기서부터 시작합니다.') },
    { sel: '.welcome button', text: tr('새로 만들기'), title: tr('새로 만들기'), body: tr('파일이 없다면 설비 한 대나 회사 · 공정 그룹을 새로 만듭니다.') },
    { sel: '.welcome-sample button', title: tr('견본으로 시작하기'), body: tr('내용이 채워진 연습용 견본입니다. 처음이라면 이것부터 열어 보세요(회원).') },
    { sel: 'header .menu-trigger', text: tr('파일'), title: tr('파일 메뉴'), body: tr('열기 · 새로 만들기 · 번들 · 파일 목록은 언제든 여기서 다시 찾습니다.') },
    { sel: 'header .brand', title: tr('첫 화면으로'), body: tr('왼쪽 위 「VEXPLOR AAS Studio」를 누르면 언제든 이 첫 화면으로 돌아옵니다.') },
    { sel: '.help-trigger', title: tr('도움말'), body: tr('막히면 「? 도움말」을 누르세요. 지금 화면에 맞는 설명이 먼저 나옵니다(F1).') },
  ];
}

/** When a file is first opened */
export function fileTour(): TourStep[] {
  return [
    { sel: '.tree-pane', title: tr('트리'), body: tr('AAS → 서브모델 → 요소 순서입니다. 고르면 가운데에 내용이 나옵니다.') },
    { sel: '.middle', title: tr('내용'), body: tr('요약 · 값 고치기 · 부품 구성이 여기에 나옵니다. 값을 바꾸고 「저장」을 누르세요.') },
    { sel: 'header .status.chip', title: tr('검사 결과'), body: tr('파일을 열면 규칙 43종으로 바로 검사합니다. 누르면 무엇이 어긋났는지 보입니다.') },
    { sel: 'header button', text: tr('자동 고치기'), title: tr('자동 고치기'), body: tr('고칠 수 있는 항목을 전 / 후로 미리 보고, 고른 것만 고칩니다.') },
    { sel: 'header .menu-trigger', text: tr('내보내기'), title: tr('내보내기'), body: tr('검증 결과서 · 문서용 자료 · 레퍼런스 번들을 만듭니다.') },
    { sel: 'header button', text: tr('AASX 내려받기'), title: tr('내려받기'), body: tr('지금 파일을 .aasx로 받습니다(회원). 완성본은 위반 0건 상태에서 받으세요.') },
    { sel: '.right-pane', title: tr('수집'), body: tr('설비에서 값을 가져옵니다. 실제 PLC가 없으면 「가상 PLC로 연결」로 시험해 보세요.') },
    { sel: 'header .brand', title: tr('첫 화면으로'), body: tr('왼쪽 위 「VEXPLOR AAS Studio」를 누르면 첫 화면으로 돌아갑니다. 열어 둔 파일은 그대로 남아, 위쪽 파일 고르개에서 다시 엽니다.') },
  ];
}

// ── Getting-started list — kept in this browser (a convenience only; losing it is fine) ──

export type StartStep = 'open' | 'check' | 'fix' | 'download';
export const START_STEPS: readonly StartStep[] = ['open', 'check', 'fix', 'download'];

export interface StartState {
  done: StartStep[];
  hidden: boolean;
}

const START_KEY = 'aas.start.v1';
const TOUR_KEY = 'aas.tour.v1';

export function readStart(): StartState {
  try {
    const raw = globalThis.localStorage?.getItem(START_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<StartState>;
      return { done: (parsed.done ?? []).filter((step) => START_STEPS.includes(step)), hidden: parsed.hidden === true };
    }
  } catch {
    // Storage throws in private windows and the like — fall back to the initial state
  }
  return { done: [], hidden: false };
}

export function writeStart(state: StartState): void {
  try {
    globalThis.localStorage?.setItem(START_KEY, JSON.stringify(state));
  } catch {
    // Even if saving fails, the screen keeps working
  }
}

/** Tours already seen — 'welcome' · 'file' */
export function tourSeen(name: string): boolean {
  try {
    return (globalThis.localStorage?.getItem(TOUR_KEY) ?? '').split(',').includes(name);
  } catch {
    return true; // If it cannot be remembered, do not show it every time — err on the side of not nagging
  }
}

export function markTourSeen(name: string): void {
  try {
    const seen = new Set((globalThis.localStorage?.getItem(TOUR_KEY) ?? '').split(',').filter(Boolean));
    seen.add(name);
    globalThis.localStorage?.setItem(TOUR_KEY, [...seen].join(','));
  } catch {
    // Ignore
  }
}
