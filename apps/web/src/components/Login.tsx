/**
 * Sign in · create the first administrator.
 *
 * Important: **the screen does not hold the session key.** The server issues it as an HttpOnly cookie and the
 *    browser attaches it to every request on its own. If screen code touched the key, a single XSS would steal it
 *    — this is the biggest change from the token approach that used localStorage.
 *
 * Important: failure messages are shown **exactly as the server sent them.** If the screen rewrote them as
 *    "that account does not exist" or the like, what the server deliberately hid (whether the account exists) would leak back out.
 */
import { useState } from 'react';
import { ConsentBox } from './login/ConsentBox.js';
import { DemoCard } from './login/DemoCard.js';
import { ProfileFields } from './login/ProfileFields.js';

interface Props {
  /** There are no accounts at all — create the first administrator instead of signing in */
  setupNeeded: boolean;
  /**
   * Whether to ask for the setup code — the server is exposed to the outside.
   * Important: without it, anyone on the same network becomes administrator first. The code is in the server startup log.
   */
  setupCodeRequired: boolean;
  /** Whether users may sign up on their own — if not, "Sign up" is not shown at all */
  signupAllowed: boolean;
  /** On a trial server, point the way straight in with the demo account */
  demo?: { login: string; password: string };
  /** If the user came in by pressing "Sign up", show the sign-up fields first — do not make them press again */
  startInSignup?: boolean;
  /**
   * Privacy policy URL. **Without it the contact fields are not shown** —
   * we do not collect what we have not said how we use, and the server rejects it by the same rule.
   */
  privacyUrl?: string;
  busy: boolean;
  onLogin: (login: string, password: string) => Promise<string | undefined>;
  onSetup: (
    login: string,
    password: string,
    displayName: string,
    setupCode: string,
  ) => Promise<string | undefined>;
  onSignup: (
    login: string,
    password: string,
    displayName: string,
    email: string,
    company: string,
    agreed: boolean,
  ) => Promise<string | undefined>;
  t: (text: string) => string;
  /** Only when the user opened "create the first administrator" themselves — not for someone who is stuck */
  onCancel?: () => void;
}

export function Login({
  setupNeeded,
  setupCodeRequired,
  signupAllowed,
  demo,
  startInSignup,
  privacyUrl,
  busy,
  onLogin,
  onSetup,
  onSignup,
  onCancel,
  t,
}: Props): React.JSX.Element {
  /**
   * Three modes share one form.
   *  - `setup`  there are no accounts — create the first administrator (may ask for the setup code)
   *  - `signup` self sign-up — the server decides the role. It never becomes administrator
   *  - `login`  the usual case
   * Important: setup is **not something you can choose.** It is a state that appears only when there are no accounts
   */
  const [wantSignup, setWantSignup] = useState(startInSignup === true);
  const mode: 'setup' | 'signup' | 'login' = setupNeeded ? 'setup' : wantSignup ? 'signup' : 'login';
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [code, setCode] = useState('');
  const [email, setEmail] = useState('');
  /** Asked only when contact details were entered — without them there is no personal data to consent to */
  const [agreed, setAgreed] = useState(false);
  const [company, setCompany] = useState('');
  const [error, setError] = useState<string>();
  const [working, setWorking] = useState(false);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setError(undefined);
    if (mode !== 'login' && password !== confirm) {
      setError(t('두 비밀번호가 다릅니다.'));
      return;
    }
    if (profile) {
      // Company name is optional (user request, 2026-10-08) — the server applies the same rule
      if (displayName.trim() === '' || email.trim() === '') {
        setError(t('이름 · 이메일을 적어 주십시오.'));
        return;
      }
      if (!agreed) {
        setError(t('개인정보 수집·이용에 동의해야 가입할 수 있습니다.'));
        return;
      }
    }
    setWorking(true);
    const failed =
      mode === 'setup'
        ? await onSetup(login.trim(), password, displayName.trim(), code.trim())
        : mode === 'signup'
          ? await onSignup(login.trim(), password, displayName.trim(), email.trim(), company.trim(), agreed)
          : await onLogin(login.trim(), password);
    setWorking(false);
    if (failed) {
      setError(failed);
      setPassword('');
      setConfirm('');
    }
  };

  /** Sign-up on a server that published a privacy policy — collects name · company · email · consent */
  const profile = mode === 'signup' && privacyUrl !== undefined && privacyUrl !== '';
  const disabled = busy || working || login.trim() === '' || password === '';
  /** Required-field marks — only on screens that create an account (sign-up · first administrator). The sign-in screen has just two fields, so none there */
  const marks = mode !== 'login';
  // Important: the asterisk is drawn with CSS (.req::after), not text — as text the field name would become "Login name*" and
  //    screen readers would read "asterisk" too. aria-required conveys that the field must be filled
  const req = marks ? <span className="req" aria-hidden="true" /> : null;

  return (
    <div className="login">
      <span className="wordmark big">VEXPLOR</span>
      <h1>AAS Studio</h1>

      {mode === 'setup' ? (
        <p className="note warn">
          {t('계정이 하나도 없습니다 — 처음 쓰는 서버입니다. 관리자 계정을 만드십시오.')}
        </p>
      ) : mode === 'signup' ? (
        <p>{t('계정을 만들면 작업한 파일을 내려받을 수 있습니다.')}</p>
      ) : demo ? (
        <p>{t('AAS를 만들고 · 검사하고 · 내려받는 웹 도구입니다.')}</p>
      ) : (
        <p>{t('로그인하십시오.')}</p>
      )}

      <form className="login-form" onSubmit={(event) => void submit(event)}>
        <label>
          {t('로그인 이름')}
          {req}
          <input
            value={login}
            aria-required={marks}
            autoFocus
            autoComplete="username"
            placeholder={mode === 'setup' ? 'admin' : ''}
            onChange={(event) => setLogin(event.target.value)}
          />
        </label>

        {mode === 'setup' && setupCodeRequired && (
          <label>
            {t('설치 코드')}
            {req}
            <input
              value={code}
              autoComplete="off"
              onChange={(event) => setCode(event.target.value)}
            />
            <span className="hint">
              {t('이 서버를 띄운 화면(기동 로그)에 적혀 있습니다 — 아무나 관리자가 되지 않게 하는 값입니다.')}
            </span>
          </label>
        )}

        {mode !== 'login' && (
          <label>
            {profile ? t('이름') : t('표시 이름')}
            {profile && req}
            <input
              aria-required={profile}
              value={displayName}
              autoComplete="name"
              maxLength={40}
              placeholder={profile ? '' : t('비워 두면 로그인 이름을 씁니다')}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </label>
        )}

        {/*
          Member details — collected only on a server that published a privacy policy (the public trial server) (user request, 2026-10-06).
          Important: the moment we collect it, it is personal data. State what · why · how long **right above the consent box**; sign-up requires consent
             (Personal Information Protection Act, Article 15 — disclose the items collected · purpose · retention period · right to refuse).
          Important: a server without a privacy policy has none of these fields — and the server rejects them too.
        */}
        {profile && <ProfileFields company={company} setCompany={setCompany} email={email} setEmail={setEmail} req={req} t={t} />}

        <label>
          {t('비밀번호')}
          {req}
          <input
            type="password"
            aria-required={marks}
            value={password}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>

        {mode !== 'login' && (
          <>
            <label>
              {t('비밀번호 확인')}
              {req}
              <input
                aria-required
                type="password"
                value={confirm}
                autoComplete="new-password"
                onChange={(event) => setConfirm(event.target.value)}
              />
            </label>
            <p className="hint">{t('비밀번호는 10자 이상이어야 합니다.')}</p>
          </>
        )}

        {profile && <ConsentBox agreed={agreed} setAgreed={setAgreed} privacyUrl={privacyUrl} req={req} t={t} />}

        {/* Important: role="alert" — screen readers announce the failure immediately */}
        {error && (
          <p className="note bad" role="alert">
            {error}
          </p>
        )}

        <button className="primary big" type="submit" disabled={disabled}>
          {working
            ? t('확인 중…')
            : mode === 'setup'
              ? t('관리자 만들기')
              : mode === 'signup'
                ? t('가입하고 시작하기')
                : t('로그인')}
        </button>

        {/* Important: hidden when there are no accounts at all — the only thing to do then is create the first administrator */}
        {signupAllowed && mode !== 'setup' && (
          <button
            className="link"
            type="button"
            onClick={() => {
              setWantSignup(!wantSignup);
              setError(undefined);
              setPassword('');
              setConfirm('');
            }}
          >
            {wantSignup ? t('← 로그인으로 돌아가기') : t('처음이신가요? 회원가입')}
          </button>
        )}

        {/* Server with sign-up closed (in-house default) — say who grants accounts, so it does not feel like a dead end */}
        {!signupAllowed && mode === 'login' && (
          <p className="hint">
            {t('계정이 없으면 관리자에게 요청하십시오 — 관리자가 「설정 → 계정 관리」에서 만들어 줍니다.')}
          </p>
        )}

        {onCancel && (
          <button className="link" type="button" onClick={onCancel}>
            {t('그만두기')}
          </button>
        )}
      </form>

      {demo && mode === 'login' && (
        <DemoCard
          demo={demo}
          disabled={busy || working}
          onEnter={() => {
            setError(undefined);
            setWorking(true);
            void onLogin(demo.login, demo.password).then((failed) => {
              setWorking(false);
              if (failed) setError(failed);
            });
          }}
          t={t}
        />
      )}

    </div>
  );
}
