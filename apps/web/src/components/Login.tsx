/**
 * 로그인 · 첫 관리자 만들기.
 *
 * 🔴 **세션 열쇠를 화면이 들고 있지 않는다.** 서버가 HttpOnly 쿠키로 주고, 브라우저가
 *    요청마다 알아서 싣는다. 화면 코드가 열쇠를 만지면 그 순간 XSS 한 방에 털린다
 *    — 토큰 방식에서 localStorage를 쓰던 것과 가장 크게 달라진 점이다.
 *
 * 🔴 실패 문구를 **서버가 준 그대로** 보여 준다. 화면이 "그 계정은 없습니다" 따위로
 *    고쳐 쓰면 서버가 일부러 가린 것(계정의 존재)이 도로 새어 나간다.
 */
import { useState } from 'react';

interface Props {
  /** 계정이 하나도 없다 — 로그인이 아니라 첫 관리자를 만든다 */
  setupNeeded: boolean;
  /**
   * 설치 코드를 물어야 하나 — 밖으로 열린 서버다.
   * 🔴 없으면 같은 망의 아무나 먼저 관리자가 된다. 서버 기동 로그에 적혀 있다.
   */
  setupCodeRequired: boolean;
  /** 스스로 가입할 수 있는 서버인가 — 아니면 「회원가입」 자체를 보이지 않는다 */
  signupAllowed: boolean;
  /** 체험판이면 체험 계정으로 바로 들어가는 길을 안내한다 */
  demo?: { login: string; password: string };
  /** 「회원가입」을 눌러 들어왔으면 가입 칸부터 보인다 — 한 번 더 누르게 하지 않는다 */
  startInSignup?: boolean;
  /**
   * 개인정보처리방침 주소. **없으면 연락처 칸을 보이지 않는다** —
   * 어떻게 쓰는지 밝히지 않고 받지 않겠다는 뜻이고, 서버도 같은 기준으로 거절한다.
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
  ) => Promise<string | undefined>;
  t: (text: string) => string;
  /** 스스로 「첫 관리자 만들기」를 연 경우에만 — 갇힌 사람에게는 주지 않는다 */
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
   * 세 가지 모드가 한 폼을 쓴다.
   *  - `setup`  계정이 하나도 없다 — 첫 관리자를 만든다(설치 코드를 물을 수 있다)
   *  - `signup` 스스로 가입한다 — 역할은 서버가 정한다. 관리자가 되지 않는다
   *  - `login`  평소
   * 🔴 setup은 **고를 수 있는 것이 아니다.** 계정이 없을 때만 나오는 상태다
   */
  const [wantSignup, setWantSignup] = useState(startInSignup === true);
  const mode: 'setup' | 'signup' | 'login' = setupNeeded ? 'setup' : wantSignup ? 'signup' : 'login';
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [code, setCode] = useState('');
  const [email, setEmail] = useState('');
  /** 연락처를 적었을 때만 묻는다 — 안 적으면 동의받을 개인정보가 없다 */
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState<string>();
  const [working, setWorking] = useState(false);

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setError(undefined);
    if (mode !== 'login' && password !== confirm) {
      setError(t('두 비밀번호가 다릅니다.'));
      return;
    }
    // 🔴 적었으면 동의가 먼저다. 안 적었으면 동의받을 것이 없다
    if (mode === 'signup' && email.trim() !== '' && !agreed) {
      setError(t('연락처를 적으셨습니다 — 처리방침에 동의해 주십시오.'));
      return;
    }
    setWorking(true);
    const failed =
      mode === 'setup'
        ? await onSetup(login.trim(), password, displayName.trim(), code.trim())
        : mode === 'signup'
          ? await onSignup(login.trim(), password, displayName.trim(), email.trim())
          : await onLogin(login.trim(), password);
    setWorking(false);
    if (failed) {
      setError(failed);
      setPassword('');
      setConfirm('');
    }
  };

  const disabled = busy || working || login.trim() === '' || password === '';

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
      ) : demo ? null : (
        <p>{t('로그인하십시오.')}</p>
      )}

      {/*
        체험판 안내 — 카드 한 장으로 묶는다.
        🔴 처음에는 회색 잔글씨 두 줄이었다. 체험 서버에 온 사람이 **가장 먼저 알아야 하는 것**
           (어떻게 들어가나 · 무엇이 되고 안 되나)인데 눈에 들어오지 않았다(사용자 2026-10-04).
        🔴 아이디·비밀번호를 적어 두기만 하지 않고 **단추 하나로 들어가게** 한다 —
           보고 베껴 치게 할 이유가 없다. 값은 그대로 보여 준다(무엇으로 들어가는지 숨기지 않는다).
      */}
      {demo && mode === 'login' && (
        <section className="demo-card" aria-label={t('체험판 안내')}>
          <h2>{t('가입 없이 바로 써 볼 수 있습니다')}</h2>
          <dl>
            <dt>{t('아이디')}</dt>
            <dd className="mono">{demo.login}</dd>
            <dt>{t('비밀번호')}</dt>
            <dd className="mono">{demo.password}</dd>
          </dl>
          <button
            className="primary big"
            type="button"
            disabled={busy || working}
            onClick={() => {
              setError(undefined);
              setWorking(true);
              void onLogin(demo.login, demo.password).then((failed) => {
                setWorking(false);
                if (failed) setError(failed);
              });
            }}
          >
            {t('체험 계정으로 들어가기')}
          </button>
          <ul>
            <li>{t('열기 · 고치기 · 검사 · 자동 고치기 — 전부 됩니다')}</li>
            <li>{t('올린 파일은 나만 봅니다 · 한동안 안 쓰면 지워집니다')}</li>
            <li className="locked">{t('파일 내려받기는 회원가입 후에 됩니다')}</li>
          </ul>
        </section>
      )}

      {demo && mode === 'login' && <p className="or">{t('또는 내 계정으로 로그인')}</p>}

      <form className="login-form" onSubmit={(event) => void submit(event)}>
        <label>
          {t('로그인 이름')}
          <input
            value={login}
            autoFocus
            autoComplete="username"
            placeholder={mode === 'setup' ? 'admin' : ''}
            onChange={(event) => setLogin(event.target.value)}
          />
        </label>

        {mode === 'setup' && setupCodeRequired && (
          <label>
            {t('설치 코드')}
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
            {t('표시 이름')}
            <input
              value={displayName}
              autoComplete="name"
              placeholder={t('비워 두면 로그인 이름을 씁니다')}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </label>
        )}

        <label>
          {t('비밀번호')}
          <input
            type="password"
            value={password}
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>

        {/* 🔴 처리방침을 올려 두지 않은 서버는 연락처 칸 자체가 없다 — 서버도 거절한다 */}
        {mode === 'signup' && privacyUrl && (
          <>
            <label>
              {t('연락처 (선택)')}
              <input
                type="email"
                value={email}
                autoComplete="email"
                placeholder={t('비워 두셔도 됩니다')}
                onChange={(event) => setEmail(event.target.value)}
              />
              {/* 🔴 확인하지 않는다는 사실을 적는다 — 확인된 주소인 양 두면 안 된다 */}
              <span className="hint">{t('연락이 필요할 때만 씁니다. 확인 메일은 보내지 않습니다.')}</span>
            </label>
            {email.trim() !== '' && (
              <label className="agree">
                <input type="checkbox" checked={agreed} onChange={(event) => setAgreed(event.target.checked)} />
                <span>
                  <a href={privacyUrl} target="_blank" rel="noreferrer">
                    {t('개인정보처리방침')}
                  </a>
                  {t('에 동의합니다.')}
                </span>
              </label>
            )}
          </>
        )}

        {mode !== 'login' && (
          <>
            <label>
              {t('비밀번호 확인')}
              <input
                type="password"
                value={confirm}
                autoComplete="new-password"
                onChange={(event) => setConfirm(event.target.value)}
              />
            </label>
            <p className="hint">{t('비밀번호는 10자 이상이어야 합니다.')}</p>
          </>
        )}

        {/* 🔴 role="alert" — 화면 낭독기가 실패를 바로 읽어 준다 */}
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

        {/* 🔴 계정이 하나도 없을 때는 보이지 않는다 — 그때 할 일은 첫 관리자 만들기뿐이다 */}
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
            {wantSignup ? t('← 로그인으로 돌아가기') : t('계정이 없습니다 — 회원가입')}
          </button>
        )}

        {/* 가입이 닫힌 서버(사내 기본) — 길이 없다고 느끼지 않게 누구에게 받는지 말해 준다 */}
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
    </div>
  );
}
