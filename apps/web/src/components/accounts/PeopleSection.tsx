/**
 * Accounts — account management (admin) — people table · roles · lock · password reset · delete · add person.
 * Split out of components/Accounts.tsx (componentization, 2026-10-13) — markup and comments are verbatim from before the move.
 * Success/failure notices are handled by Accounts' act (using the server's message as-is).
 */
import { useCallback, useEffect, useState } from 'react';
import { api, type AuthState, type UserView } from '../../api.js';
import { fill, tr } from '../../i18n.js';
import { roleLabel, ROLES, type Act, type Role } from './types.js';

interface Props {
  me: NonNullable<AuthState['user']>;
  working: boolean;
  act: Act;
  onError: (message: string) => void;
  describeError: (caught: unknown) => string;
  t: (text: string) => string;
}

export function PeopleSection({ me, working, act: actOnce, onError, describeError, t }: Props): React.JSX.Element {
  const roleName = (role: Role): string => roleLabel(role, t);
  const [users, setUsers] = useState<UserView[]>([]);
  /** Show those columns if anyone gave a company name/email at sign-up (otherwise hide the columns entirely) */
  const hasProfile = users.some((user) => user.company !== undefined || user.email !== undefined);
  // Add person
  const [login, setLogin] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<Role>('editor');
  const [password, setPassword] = useState('');

  const load = useCallback(async () => {
    try {
      setUsers((await api.listUsers()).result);
    } catch (caught) {
      onError(describeError(caught));
    }
  }, [describeError, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Do one action; on success, notify and reload the list */
  const act: Act = async (work, done) => {
    const ok = await actOnce(work, done);
    if (ok) await load();
    return ok;
  };

  const addUser = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (await act(() => api.createUser({ login: login.trim(), displayName: displayName.trim(), role, password }), t('계정을 만들었습니다.'))) {
      setLogin('');
      setDisplayName('');
      setPassword('');
      setRole('editor');
    }
  };

  /** The person whose password is being reset — a field opens below the table */
  const [resetFor, setResetFor] = useState<UserView>();
  const [resetValue, setResetValue] = useState('');

  const resetPassword = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!resetFor) return;
    const done = await act(
      () => api.updateUser(resetFor.id, { password: resetValue }),
      t('비밀번호를 바꿨습니다. 그 사람은 다시 로그인해야 합니다.'),
    );
    if (done) {
      setResetFor(undefined);
      setResetValue('');
    }
  };

  return (
    <section>
      <h3>{t('사람들')}</h3>
      {/* Important: many columns (company name, email) make it wider than the window — only the table scrolls sideways, the window stays on screen (2026-10-06) */}
      <div className="table-scroll">
      <table className="accounts-table">
        <thead>
          <tr>
            <th>{t('로그인 이름')}</th>
            <th>{t('표시 이름')}</th>
            {/* Company name · email received at sign-up — only present on servers that published a privacy policy */}
            {hasProfile && <th>{t('회사명')}</th>}
            {hasProfile && <th>{t('이메일')}</th>}
            <th>{t('역할')}</th>
            <th>{t('마지막 로그인')}</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <tr key={user.id} className={user.disabled ? 'locked' : ''}>
              <td className="mono">
                {user.login}
                {user.id === me.id && <span className="dim"> ({t('나')})</span>}
                {user.demo === true && <span className="dim"> ({t('데모')})</span>}
              </td>
              <td>{user.displayName}</td>
              {hasProfile && <td>{user.company ?? '—'}</td>}
              {hasProfile && (
                <td className="mono" title={user.consentAt ? `${t('동의')} ${user.consentAt.slice(0, 16).replace('T', ' ')}` : undefined}>
                  {user.email ?? '—'}
                </td>
              )}
              <td>
                <select
                  value={user.role}
                  disabled={working || user.demo === true}
                  aria-label={`${user.login} ${t('역할')}`}
                  onChange={(event) =>
                    void act(() => api.updateUser(user.id, { role: event.target.value as Role }), t('역할을 바꿨습니다.'))
                  }
                >
                  {ROLES.map((item) => (
                    <option key={item} value={item}>
                      {roleName(item)}
                    </option>
                  ))}
                </select>
              </td>
              <td className="dim">{user.lastLoginAt ? user.lastLoginAt.slice(0, 10) : '—'}</td>
              <td className="row-buttons">
                {/* Demo accounts cannot be changed — it is a shared entry whose password is shown on screen (the server blocks it too) */}
                {user.demo !== true && (
                <button
                  className="link"
                  disabled={working}
                  onClick={() => {
                    setResetFor(user);
                    setResetValue('');
                  }}
                >
                  {t('비밀번호 초기화')}
                </button>
                )}
                {user.demo !== true && (
                <button
                  className="link"
                  disabled={working}
                  title={t('잠그면 그 사람은 들어오지 못합니다. 지우지는 않습니다 — 변경 이력의 이름이 남아야 합니다.')}
                  onClick={() =>
                    void act(
                      () => api.updateUser(user.id, { disabled: !user.disabled }),
                      user.disabled ? t('잠금을 풀었습니다.') : t('잠갔습니다.'),
                    )
                  }
                >
                  {user.disabled ? t('잠금 풀기') : t('잠그기')}
                </button>
                )}
                {/* Important: you cannot delete yourself (your own account is under "Settings → Leave"). The server blocks it too */}
                {user.id !== me.id && user.demo !== true && (
                  <button
                    className="link danger"
                    disabled={working}
                    title={t('계정과 그 사람이 올린 파일을 지웁니다 — 되돌릴 수 없습니다. 막기만 하려면 「잠그기」')}
                    onClick={() => {
                      const ok = window.confirm(
                        fill(
                          tr('「{0}」({1}) 계정을 지웁니다.\n\n그 사람이 올린 파일도 함께 지워지며 되돌릴 수 없습니다.\n막기만 하려면 「잠그기」를 쓰십시오.\n\n지울까요?'),
                          { 0: user.displayName, 1: user.login },
                        ),
                      );
                      if (ok) void act(() => api.deleteUser(user.id), fill(tr('「{0}」 계정을 지웠습니다.'), { 0: user.login }));
                    }}
                  >
                    {t('삭제')}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>

      {/* No prompt window — the password would be shown in plain text, and it is easy to close by mistake */}
      {resetFor && (
        <form className="login-form reset-form" onSubmit={(event) => void resetPassword(event)}>
          <label>
            {resetFor.displayName} ({resetFor.login}) — {t('새 비밀번호')}
            <input
              type="password"
              value={resetValue}
              autoFocus
              autoComplete="new-password"
              onChange={(event) => setResetValue(event.target.value)}
            />
          </label>
          <div className="row-buttons">
            <button type="submit" disabled={working || resetValue === ''}>
              {t('이 비밀번호로 바꾸기')}
            </button>
            <button type="button" className="link" onClick={() => setResetFor(undefined)}>
              {t('그만두기')}
            </button>
          </div>
        </form>
      )}

      <h3>{t('사람 더하기')}</h3>
      <form className="login-form" onSubmit={(event) => void addUser(event)}>
        <label>
          {t('로그인 이름')}
          <input value={login} autoComplete="off" onChange={(event) => setLogin(event.target.value)} />
        </label>
        <label>
          {t('표시 이름')}
          <input value={displayName} autoComplete="off" placeholder={t('비워 두면 로그인 이름을 씁니다')} onChange={(event) => setDisplayName(event.target.value)} />
        </label>
        <label>
          {t('역할')}
          <select value={role} onChange={(event) => setRole(event.target.value as Role)}>
            {ROLES.map((item) => (
              <option key={item} value={item}>
                {roleName(item)}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t('처음 비밀번호')}
          <input type="password" value={password} autoComplete="new-password" onChange={(event) => setPassword(event.target.value)} />
        </label>
        <p className="hint">{t('관리자 — 전부 · 편집자 — 열고 고치기 · 열람자 — 보기만')}</p>
        <div className="row-buttons">
          <button type="submit" className="primary" disabled={working || login.trim() === '' || password === ''}>
            {t('계정 만들기')}
          </button>
        </div>
      </form>
    </section>
  );
}
