/**
 * 계정 — 내 비밀번호 바꾸기 · (관리자) 사람 더하기·역할·잠그기·비밀번호 초기화.
 *
 * 🔴 이 화면은 한동안 **없었다.** 서버에는 계정 관리 API가 있었고 문서에도 「설정 → 계정 관리」라고
 *    적혀 있었는데, 정작 누를 자리가 없었다(2026-10-04에 문서를 읽다 알아챘다).
 *    관리자가 사람을 더하려면 curl을 쳐야 했다 — 만든 기능을 쓸 수 없으면 없는 것이다.
 *
 * 🔴 실패 문구는 **서버가 준 그대로** 보여 준다. 「마지막 관리자는 잠글 수 없다」 같은 사유는
 *    서버가 판단하고, 화면이 고쳐 쓰면 뜻이 달라진다.
 */
import { useCallback, useEffect, useState } from 'react';

import { api, type AuthState, type UserView } from '../api.js';

type Role = 'admin' | 'editor' | 'viewer';

interface Props {
  me: NonNullable<AuthState['user']>;
  /** 내 비밀번호를 바꾸면 로그인이 새로 잡힌다 — 화면이 다시 읽게 한다 */
  onChanged: () => void;
  onClose: () => void;
  describeError: (caught: unknown) => string;
  t: (text: string) => string;
}

const ROLES: readonly Role[] = ['admin', 'editor', 'viewer'];

export function Accounts({ me, onChanged, onClose, describeError, t }: Props): React.JSX.Element {
  const isAdmin = me.role === 'admin';
  const roleName = (role: Role): string =>
    role === 'admin' ? t('관리자') : role === 'editor' ? t('편집자') : t('열람자');

  const [users, setUsers] = useState<UserView[]>([]);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [working, setWorking] = useState(false);

  // 내 비밀번호
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');

  // 사람 더하기
  const [login, setLogin] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<Role>('editor');
  const [password, setPassword] = useState('');

  const load = useCallback(async () => {
    if (!isAdmin) return;
    try {
      setUsers((await api.listUsers()).result);
    } catch (caught) {
      setError(describeError(caught));
    }
  }, [isAdmin, describeError]);

  useEffect(() => {
    void load();
  }, [load]);

  /** 한 가지 일을 하고, 되면 알리고 목록을 다시 읽는다 */
  const act = async (work: () => Promise<unknown>, done: string): Promise<boolean> => {
    setError(undefined);
    setNotice(undefined);
    setWorking(true);
    try {
      await work();
      setNotice(done);
      await load();
      return true;
    } catch (caught) {
      setError(describeError(caught));
      return false;
    } finally {
      setWorking(false);
    }
  };

  const changeMine = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (next !== confirm) {
      setError(t('두 비밀번호가 다릅니다.'));
      return;
    }
    if (await act(() => api.changePassword(current, next), t('비밀번호를 바꿨습니다.'))) {
      setCurrent('');
      setNext('');
      setConfirm('');
      onChanged();
    }
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

  /** 비밀번호를 새로 정해 줄 사람 — 표 아래에 칸이 열린다 */
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
    <div className="settings accounts">
      <h2>{t('계정')}</h2>

      {error && (
        <p className="note bad" role="alert">
          {error}
        </p>
      )}
      {notice && <p className="note ok">{notice}</p>}

      <section>
        <h3>{t('내 비밀번호 바꾸기')}</h3>
        <form className="login-form" onSubmit={(event) => void changeMine(event)}>
          <label>
            {t('지금 비밀번호')}
            <input type="password" value={current} autoComplete="current-password" onChange={(event) => setCurrent(event.target.value)} />
          </label>
          <label>
            {t('새 비밀번호')}
            <input type="password" value={next} autoComplete="new-password" onChange={(event) => setNext(event.target.value)} />
          </label>
          <label>
            {t('새 비밀번호 확인')}
            <input type="password" value={confirm} autoComplete="new-password" onChange={(event) => setConfirm(event.target.value)} />
          </label>
          <p className="hint">{t('비밀번호는 10자 이상이어야 합니다.')}</p>
          <div className="row-buttons">
            <button type="submit" disabled={working || current === '' || next === ''}>
              {t('비밀번호 바꾸기')}
            </button>
          </div>
        </form>
      </section>

      {isAdmin && (
        <section>
          <h3>{t('사람들')}</h3>
          <table className="accounts-table">
            <thead>
              <tr>
                <th>{t('로그인 이름')}</th>
                <th>{t('표시 이름')}</th>
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
                  </td>
                  <td>{user.displayName}</td>
                  <td>
                    <select
                      value={user.role}
                      disabled={working}
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
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* 창(prompt)을 띄우지 않는다 — 비밀번호가 그대로 보이고, 잘못 눌러 닫기 쉽다 */}
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
      )}

      <div className="row-buttons actions">
        <button onClick={onClose}>{t('닫기')}</button>
      </div>
    </div>
  );
}
