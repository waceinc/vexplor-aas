/**
 * Login screen (rendered only once the login state is known — auth is always present) — sign in · sign up · create the first admin. Rendered alone when there is no account or the user opened "Create first admin" themselves.
 * Split out of App.tsx (componentization, 2026-10-13) — markup, class names and comments are verbatim from before the move,
 * and the state and actions it uses arrive as props with the same names.
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
        {/* onCancel is passed **only to users who came here on their own** — "Cancel" means nothing to someone who is stuck here */}
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
