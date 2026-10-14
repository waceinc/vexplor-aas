/**
 * 머리글 — 두 줄. 윗줄은 **어느 파일을 보는가**와 상태, 아랫줄은 **그 파일에 무엇을 하는가**.
 * App.tsx 에서 떼어 냈다(2026-10-13 컴포넌트화). 메뉴 항목은 headerMenus.ts 가 만든다.
 * 머리글은 셸 밀도(90%)로 그린다 — 로직스튜디오 셸과 같은 표(styles/drive.css).
 */
import type { Dispatch, RefObject, SetStateAction } from 'react';
import { LayoutGrid } from 'lucide-react';
import type { PackageDescription, UndoStatus } from '../api.js';
import { Menu, type MenuItem } from '../components/Menu.js';
import { T } from '../components/T.js';
import { fill, tr, type Lang } from '../i18n.js';

interface Props {
  t: (text: string) => string;
  lang: Lang;
  version: string | undefined;
  packages: PackageDescription[];
  packageId: string | undefined;
  busy: boolean;
  demoLocked: boolean;
  errors: number;
  warnings: number;
  /** 자동 고치기가 실제로 손댈 건수 · 사람이 판단할 건수 · 연결 설비 파일 몫 */
  fixable: number;
  unfixable: number;
  linkedFixable: number;
  opcua: { running: boolean; variables: number } | undefined;
  undoState: UndoStatus;
  showHelp: boolean;
  fileInput: RefObject<HTMLInputElement | null>;
  bundleInput: RefObject<HTMLInputElement | null>;
  fileMenu: MenuItem[];
  settingsMenu: MenuItem[];
  submodelMenu: MenuItem[];
  exportMenu: MenuItem[];
  goHome: () => void;
  loadPackage: (packageId: string) => Promise<void>;
  onUpload: (file: File) => Promise<void>;
  onOpenBundle: (file: File) => Promise<void>;
  onUndo: () => Promise<void>;
  onRedo: () => Promise<void>;
  onFix: () => Promise<void>;
  onDownload: () => Promise<void>;
  setShowFindings: (open: boolean) => void;
  setShowHelp: Dispatch<SetStateAction<boolean>>;
  setShowOpcua: (open: boolean) => void;
  setStartAccounts: (open: boolean) => void;
}

export function AppHeader({
  t, lang, version, packages, packageId, busy, demoLocked, errors, warnings, fixable, unfixable, linkedFixable, opcua, undoState,
  showHelp, fileInput, bundleInput, fileMenu, settingsMenu, submodelMenu, exportMenu, goHome, loadPackage, onUpload, onOpenBundle,
  onUndo, onRedo, onFix, onDownload, setShowFindings, setShowHelp, setShowOpcua, setStartAccounts,
}: Props): React.JSX.Element {
  return (
    <header data-scale="shell">
      {/*
        두 줄이다. 윗줄은 **어느 파일을 보는가**와 상태, 아랫줄은 **그 파일에 무엇을 하는가**.
        아랫줄은 파일이 열려야 나온다 — 처음 화면에 눌러도 안 되는 버튼을 줄지어 두지 않는다.
      */}
      <div className="bar">
        {/* 회사 표시 — 화면·결과서·문서에 같은 로고가 들어간다 */}
        <span
          className="brand"
          title={tr('처음 화면으로')}
          onClick={goHome}
          role="button"
          tabIndex={0}
          onKeyDown={(event) => {
            if (event.key === 'Enter') goHome();
          }}
        >
          {/*
            🔴 글자로 그린다(2026-10-02). 이름이 WACE → VEXPLOR로 바뀌었는데 **VEXPLOR 로고
               그림이 없다.** 옛 그림을 그대로 두면 제목은 VEXPLOR인데 그림은 WACE라 어긋난다.
               글자는 해상도를 안 타고, 이름이 또 바뀌어도 여기 한 줄만 고치면 된다.
               공식 로고 파일을 받으면 <img>로 되돌린다.
          */}
          <LayoutGrid aria-hidden="true" />
          <span className="wordmark">VEXPLOR</span>
          <span className="product">AAS Studio</span>
          {/* 판 번호 — 배포처가 여럿이면 "어느 판인가"가 문의의 첫 질문이다 */}
          {version && <span className="version" title={tr('제품 판 번호')}>v{version}</span>}
        </span>

        <input
          ref={fileInput}
          type="file"
          accept=".aasx"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void onUpload(file);
            event.target.value = '';
          }}
        />
        {/*
          🔴 파일 관련 네 가지를 한 메뉴로(2026-10-02). 전에는 「파일」 라벨 + 버튼 셋이
             펼쳐져 윗줄이 길었다. 파일을 여는 일은 **한 번 하고 마는 일**이라 접어도 된다 —
             자주 쓰는 것은 그 옆의 파일 고르개다.
        */}
        <Menu
          label={t('파일')}
          title={tr('열기 · 새로 만들기 · 번들 열기 · 파일 목록')}
          disabled={busy}
          items={fileMenu}
        />
        <input
          ref={bundleInput}
          type="file"
          accept=".zip"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void onOpenBundle(file);
            event.target.value = '';
          }}
        />
        <select
          value={packageId ?? ''}
          disabled={busy || packages.length === 0}
          onChange={(event) => void loadPackage(event.target.value)}
        >
          {packages.length === 0 && <option value="">{t('열린 파일 없음')}</option>}
          {packages.length > 0 && !packageId && <option value="">{t('— 파일 고르기 —')}</option>}
          {packages.map((item) => (
            <option key={item.packageId} value={item.packageId}>
              {item.name ?? item.packageId}
            </option>
          ))}
        </select>

        {/* 오른쪽 — 상태 */}
        <span className="spacer" />
        {busy && <span className="busy">{t('처리 중…')}</span>}
        {packageId && (
          /* 눌러서 목록을 연다. 색만으로 나누지 않는다 — 점 + 글자 (색각 이상 대비) */
          <button
            className={`status chip ${errors === 0 ? 'ok' : 'bad'}`}
            onClick={() => setShowFindings(true)}
            title={tr('눌러서 지적 목록을 봅니다')}
          >
            <span className="dot" aria-hidden="true" />
            {t('위반')} {errors}{lang === 'ko' ? tr('건') : ''}
            <span className="sub"> · {t('경고')} {warnings}{lang === 'ko' ? tr('건') : ''}</span>
          </button>
        )}
        {/*
          🔴 **내주기**는 수집과 반대 방향이다. 전에는 수집 패널 안에 나란히 뒀는데,
             내보내기 주소가 수집 조작부 바로 옆에 떠 있어 사용자가 그 주소를
             「설비 주소」에 넣는 사고가 났다. 방향이 다른 것은 자리도 달라야 한다.
             처음 화면에서는 숨긴다 — 파일도 없는데 「내주는 중」은 무슨 뜻인지 물어 왔다.
        */}
        {packageId && opcua?.running && (
          <button
            className="status chip out"
            onClick={() => setShowOpcua(true)}
            title={tr('이 도구가 다른 시스템에 값을 내주고 있습니다')}
          >
            {t('→ 내주는 중')}
            <span className="sub">{' '}<T k={'· 변수 {0}개'} v={[opcua.variables]} /></span>
          </button>
        )}
        {/* 도움말 — 매뉴얼 대신 화면 안에서(2026-10-08). 글자로 둔다 — 「?」 하나로는 무엇인지 모른다 */}
        <button
          className={`help-trigger${showHelp ? ' on' : ''}`}
          aria-expanded={showHelp}
          title={tr('이 화면에서 할 수 있는 일과 쓰는 법을 봅니다 (F1)')}
          onClick={() => setShowHelp((open) => !open)}
        >
          {t('? 도움말')}
        </button>
        {/*
          🔴 설정(2026-10-02) — 늘 쓰는 것이 아닌데 헤더 자리를 차지하던 것들을 모았다.
             「규칙」은 하루에 한 번 볼까 말까고, 「토큰 지우기」는 자리를 뜰 때만 쓴다.
        */}
        <Menu
          // 🔴 톱니(⚙)를 쓰지 않는다 — 이 화면에서 ⚙는 트리의 **「설비」** 표시다.
          //    한 기호가 두 뜻이면 둘 다 흐려진다. 글자로 적는다(사용자 2026-10-04)
          label={t('설정')}
          align="right"
          title={t('설정 — 언어 · 계정 · 규칙')}
          items={settingsMenu}
        />
      </div>

      {packageId && (
        <div className="bar work">
          {/* 🔴 묶음마다 <span class="group"> — 좁은 창(1024px)에서 「AASX 내려받기」 하나만 셋째 줄로
              떨어져 ③ 제출이 흩어졌다(2026-09-09 실측). 묶음은 통째로 줄을 바꾼다 */}
          {/* 편집 — 파일 안을 바꾸는 동작들. 맨 앞은 뒤로가기 — 실수를 한 번에 되돌린다 */}
          {/*
            🔴 「① 편집 ② 검사 ③ 제출」 라벨을 걷었다(2026-10-02 사용자 요청). 라벨이 자리를
               먹었고, 번호가 "순서대로 해야 한다"는 오해를 줬다 — 실제로는 고치고 검사하고
               또 고치며 왔다 갔다 한다. 묶음은 **구분선**으로만 가른다.
            🔴 접는 기준은 **쓰는 빈도**다. 매번 누르는 것(되돌리기·자동 고치기·내려받기)은
               밖에 두고, 가끔 쓰는 것만 메뉴로 넣는다. 한 번 더 누르게 만드는 것은
               그만한 값을 해야 한다.
          */}
          <span className="group">
          <button
            className="undo"
            onClick={() => void onUndo()}
            disabled={busy || undoState.undo.length === 0}
            aria-label={tr('되돌리기')}
            title={
              undoState.undo[0]
                ? fill(tr('되돌리기: {0} (Ctrl+Z){1}'), { 0: undoState.undo[0], 1: undoState.undo.length > 1 ? fill(tr(' · {0}단계 남음'), { 0: undoState.undo.length }) : '' })
                : tr('되돌릴 변경이 없습니다')
            }
          >
            {t('↶ 되돌리기')}
          </button>
          <button
            className="undo"
            onClick={() => void onRedo()}
            disabled={busy || undoState.redo.length === 0}
            aria-label={tr('다시 하기')}
            title={undoState.redo[0] ? fill(tr('다시 하기: {0} (Ctrl+Shift+Z)'), { 0: undoState.redo[0] }) : tr('다시 할 변경이 없습니다')}
          >
            ↷
          </button>
          <span className="sep-line" aria-hidden="true" />
          {/* 🔴 이름을 「서브모델」로 — 「추가」는 요소 추가 폼의 버튼과 겹쳐 무엇을 더하는지 모호했다 */}
          <Menu
            label={t('서브모델')}
            title={tr('이 파일에 서브모델을 넣습니다')}
            disabled={busy}
            items={submodelMenu}
          />
          <span className="sep-line" aria-hidden="true" />
          {/*
            🔴 한 화면에 파란 버튼은 하나다 — 그것이 「다음에 누를 것」이다.
               고칠 것이 있으면 자동 고치기, 다 고쳤으면 내려받기.
          */}
          <button
            className={fixable > 0 ? 'primary' : ''}
            onClick={() => void onFix()}
            disabled={busy || fixable === 0}
            title={
              fixable === 0
                ? unfixable > 0
                  ? fill(tr('자동으로 고칠 지적이 없습니다 — {0}건은 사람이 판단할 몫입니다(지적 목록 참조)'), { 0: unfixable })
                  : tr('자동으로 고칠 지적이 없습니다')
                : linkedFixable > 0
                  ? tr('고칠 수 있는 지적을 규약대로 교정합니다 — 설비 파일 것은 그 설비 파일에 저장됩니다')
                  : tr('고칠 수 있는 지적(경고 포함)을 규약대로 자동 교정합니다')
            }
          >
            {t('자동 고치기')}{fixable > 0 ? ` ${fixable}${lang === 'ko' ? tr('건') : ''}` : ''}
          </button>
          </span>

          {/* 마지막 단계는 오른쪽 끝에 — 끝내는 동작은 늘 같은 자리에 있어야 손이 기억한다 */}
          <span className="spacer" />
          <span className="group submit">
          <Menu
            label={t('내보내기')}
            align="right"
            title={tr('검증 결과서 · 문서용 자료 · 번들을 내보냅니다')}
            disabled={busy}
            items={exportMenu}
          />
          {/* 🔴 데모 계정은 눌러도 403이다. 눌러 보고 알게 하는 것보다 **왜 안 되는지**를
              먼저 말하는 편이 낫다 — 단추는 남겨 두고 설명을 바꾼다(없으면 「받는 기능이
              없는 도구」로 보인다) */}
          <button
            className={!demoLocked && fixable === 0 && errors === 0 ? 'primary' : ''}
            onClick={() => (demoLocked ? setStartAccounts(true) : void onDownload())}
            disabled={busy}
            title={
              demoLocked
                ? t('데모 계정으로는 내려받을 수 없습니다 — 눌러서 계정을 만드십시오.')
                : errors > 0
                  ? fill(tr('위반 {0}건이 남아 있습니다 — 받을 수는 있지만 KOSMO 규칙을 아직 다 지키지 못했습니다'), { 0: errors })
                  : tr('지금 파일을 .aasx로 내려받습니다')
            }
          >
            {demoLocked ? `🔒 ${t('AASX 내려받기')}` : t('AASX 내려받기')}
          </button>
          </span>
        </div>
      )}
    </header>
  );
}
