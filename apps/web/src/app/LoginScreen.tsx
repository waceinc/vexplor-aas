/**
 * 로그인 화면(로그인 상태를 안 뒤에만 그린다 — auth 는 늘 있다) — 로그인 · 회원가입 · 첫 관리자 만들기. 계정이 없거나 스스로 「첫 관리자 만들기」를 열었을 때 이 화면만 그린다.
 * App.tsx 에서 떼어 냈다(2026-10-13 컴포넌트화) — 마크업 · 클래스 이름 · 주석은 옮기기 전 글자 그대로이고,
 * 쓰는 상태·동작은 같은 이름의 props 로 받는다.
 */
import { api, type AuthState } from '../api.js';
import { Login } from '../components/Login.js';
import { describeError } from './describeError.js';
import type { Screen } from './context.js';

export function LoginScreen(props: Omit<Pick<Screen, 'auth' | 'bootstrap' | 'busy' | 'setStartAccounts' | 'startAccounts' | 't'>, 'auth'> & { auth: AuthState }): React.JSX.Element {
  const { auth, bootstrap, busy, setStartAccounts, startAccounts, t } = props;

  return (
    <div className="app" data-scale="content">
      <main className="login-wrap">
        {/* onCancel은 **스스로 들어온 사람에게만** 준다 — 갇힌 사람에게 「그만두기」는 뜻이 없다 */}
        <Login
          setupNeeded={auth.setupNeeded}
          setupCodeRequired={auth.setupCodeRequired === true}
          signupAllowed={auth.signupAllowed === true}
          startInSignup={startAccounts && !auth.setupNeeded}
          {...(auth.privacyUrl ? { privacyUrl: auth.privacyUrl } : {})}
          {...(auth.demo ? { demo: auth.demo } : {})}
          busy={busy}
          {...(startAccounts ? { onCancel: () => setStartAccounts(false) } : {})}
          t={t}
          onLogin={async (login, password) => {
            try {
              await api.login(login, password);
              await bootstrap();
              return undefined;
            } catch (caught) {
              return describeError(caught);
            }
          }}
          onSignup={async (login, password, displayName, email, company, agreed) => {
            try {
              await api.signup(login, password, displayName, email, company, agreed);
              setStartAccounts(false);
              await bootstrap();
              return undefined;
            } catch (caught) {
              return describeError(caught);
            }
          }}
          onSetup={async (login, password, displayName, setupCode) => {
            try {
              await api.setup(login, password, displayName, setupCode);
              setStartAccounts(false);
              await bootstrap();
              return undefined;
            } catch (caught) {
              return describeError(caught);
            }
          }}
        />
      </main>
    </div>
  );
}
