/**
 * 머리글 밑 알림 띠 묶음 — 탈퇴 확인 · 체험판 · 견본 잠김 · 오류 · 토큰 · 충돌 · 알림 · 교정 결과.
 * App.tsx 에서 떼어 냈다(2026-10-13 컴포넌트화). 띠 하나하나의 모양은 ui/Banner 가 맡는다.
 */
import type { FixReport } from '../api.js';
import { T } from '../components/T.js';
import { tr } from '../i18n.js';
import { Banner } from '../ui/Banner.js';

interface Props {
  t: (text: string) => string;
  /** 탈퇴 확인을 묻는 중 */
  confirmQuit: boolean;
  onQuit: () => void;
  onCancelQuit: () => void;
  demoLocked: boolean;
  sampleLocked: boolean;
  signupAllowed: boolean;
  onSignup: () => void;
  onCloseSampleLocked: () => void;
  error?: string;
  onCloseError: () => void;
  /** 서버가 인증을 켜 두었는데 토큰이 없거나 틀렸을 때의 안내 */
  needsToken?: string;
  onToken: (token: string | undefined) => void;
  conflict?: string;
  onReload: () => void;
  notice?: string;
  onCloseNotice: () => void;
  fixReport?: FixReport;
  onCloseFixReport: () => void;
}

export function StatusBanners(props: Props): React.JSX.Element {
  const { t } = props;
  return (
    <>
      {/* 탈퇴 확인 — 되돌릴 수 없다. 무엇이 남고 무엇이 사라지는지 적는다 */}
      {props.confirmQuit && (
        <Banner kind="demo-bar" role="alertdialog">
          ⚠️ <b>{t('정말 탈퇴하시겠습니까?')}</b>{' '}
          {t('계정과 연락처가 지워집니다. 올린 파일과 변경 이력은 서버에 그대로 남습니다.')}{' '}
          <button className="link" onClick={props.onQuit}>
            {t('탈퇴합니다')}
          </button>{' '}
          <button className="link" onClick={props.onCancelQuit}>
            {t('그만두기')}
          </button>
        </Banner>
      )}

      {/*
        체험판 띠 — 무엇이 막혀 있고 올린 것이 어떻게 되는지를 먼저 말한다.
        🔴 처음에는 「다른 사람에게도 보입니다」였다. 작업 공간을 로그인마다 가른 뒤로는
           사실이 아니다(2026-10-04). 대신 **로그인을 새로 하면 빈 칸에서 시작한다**는 것을
           적는다 — 데모 계정은 로그인이 곧 작업 공간이라, 모르면 「파일이 사라졌다」가 된다.
      */}
      {props.demoLocked && (
        <Banner kind="demo-bar">
          🧪 <b>{t('체험판입니다')}</b> —{' '}
          {t('올린 파일은 다른 방문자에게 보이지 않습니다. 한동안 쓰지 않으면 지워지고, 로그인을 새로 하면 빈 칸에서 시작합니다.')}{' '}
          <button className="link" onClick={props.onSignup}>
            {t('회원가입하면 내려받을 수 있습니다')}
          </button>
        </Banner>
      )}

      {props.sampleLocked && (
        <Banner kind="demo-bar" role="alertdialog">
          🔒 <b>{t('견본은 회원가입 후 사용할 수 있습니다.')}</b>{' '}
          {props.signupAllowed && (
            <button
              className="link"
              onClick={() => {
                props.onCloseSampleLocked();
                props.onSignup();
              }}
            >
              {t('회원가입')}
            </button>
          )}{' '}
          <button className="link" onClick={props.onCloseSampleLocked}>
            {t('닫기')}
          </button>
        </Banner>
      )}

      {/* 오류는 헤더 안이 아니라 아래 띠로 — 헤더 안에 있으면 버튼을 밀어내며 줄이 꺾였다 */}
      {props.error && (
        <Banner kind="error-bar" role="alert" onClose={props.onCloseError} closeText={tr('닫기')}>
          {props.error}
        </Banner>
      )}

      {props.needsToken !== undefined && (
        <form
          className="token-bar"
          onSubmit={(event) => {
            event.preventDefault();
            const input = new FormData(event.currentTarget).get('token');
            // 새로고침하지 않는다 — 편집하다 토큰이 만료된 경우 화면을 잃지 않아야 한다
            props.onToken(typeof input === 'string' ? input : undefined);
          }}
        >
          <b>{tr('접근 토큰이 필요합니다.')}</b> {tr('관리자에게 받은 토큰을 넣어 주세요.')} {props.needsToken}
          <input name="token" type="password" placeholder={tr('토큰')} autoComplete="off" autoFocus />
          <button className="primary" type="submit">
            {tr('확인')}
          </button>
        </form>
      )}

      {props.conflict && (
        <div className="conflict">
          {/* 화면의 값을 밀어 넣지 않는다 — 남의 편집을 덮어쓰는 게 가장 나쁜 결과다 */}
          {tr('다른 곳에서 이 서브모델이 먼저 바뀌었습니다.')} <b>{tr('내 수정은 저장하지 않았습니다.')}</b>{' '}
          {props.conflict}
          <button
            className="link"
            title={tr('서버에 저장된 최신 내용을 다시 읽어 옵니다 — 내가 고치던 것은 사라집니다')}
            onClick={props.onReload}
          >
            {tr('다시 읽기')}
          </button>
        </div>
      )}

      {props.notice && (
        <Banner kind="notice" onClose={props.onCloseNotice} closeText={tr('닫기')}>
          {props.notice}
        </Banner>
      )}

      {props.fixReport && (
        <Banner kind="fix-report" onClose={props.onCloseFixReport} closeText={tr('닫기')}>
          <T
            k={'교정 {0}건({1}바퀴) · 남은 위반 {2}건'}
            v={[props.fixReport.applied.length, props.fixReport.rounds, props.fixReport.after.countBySeverity.error]}
          />
          {Object.keys(props.fixReport.relocations).length > 0 && (
            <>
              {' '}
              <T k={'· 이관 대장 {0}건'} v={[Object.keys(props.fixReport.relocations).length]} />
            </>
          )}
        </Banner>
      )}
    </>
  );
}
