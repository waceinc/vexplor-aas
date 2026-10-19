/**
 * Banner strips under the header — account-deletion confirmation · trial · locked sample · error · token · conflict · notice · fix results.
 * Split out of App.tsx (componentization, 2026-10-13). Each strip's look is handled by ui/Banner.
 */
import type { FixReport } from '../api.js';
import { T } from '../components/T.js';
import { tr } from '../i18n.js';
import { Banner } from '../ui/Banner.js';

interface Props {
  t: (text: string) => string;
  /** Asking to confirm account deletion */
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
  /** Guidance when the server has auth enabled but the token is missing or wrong */
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
      {/* Account-deletion confirmation — irreversible. State what stays and what disappears */}
      {props.confirmQuit && (
        <Banner kind="demo-bar" role="alertdialog">
          <b>{t('정말 탈퇴하시겠습니까?')}</b>{' '}
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
        Trial strip — states up front what is blocked and what happens to uploaded files.
        Important: it originally said "visible to others too". Since workspaces were split per login
           that is no longer true (2026-10-04). Instead it says that **a new login starts from an empty workspace** —
           for the demo account each login is its own workspace, and without knowing that users think "my files disappeared".
      */}
      {props.demoLocked && (
        <Banner kind="demo-bar">
          <b>{t('체험 버전입니다')}</b> —{' '}
          {t('올린 파일은 다른 방문자에게 보이지 않습니다. 한동안 쓰지 않으면 지워지고, 로그인을 새로 하면 빈 칸에서 시작합니다.')}{' '}
          <button className="link" onClick={props.onSignup}>
            {t('회원가입하면 내려받을 수 있습니다')}
          </button>
        </Banner>
      )}

      {props.sampleLocked && (
        <Banner kind="demo-bar" role="alertdialog">
          <b>{t('견본은 회원가입 후 사용할 수 있습니다.')}</b>{' '}
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

      {/* Errors go in a strip below, not inside the header — inside the header they pushed buttons aside and wrapped the row */}
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
            // Do not reload — if the token expires mid-edit, the screen must not be lost
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
          {/* Do not force-push the on-screen values — overwriting someone else's edit is the worst outcome */}
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
