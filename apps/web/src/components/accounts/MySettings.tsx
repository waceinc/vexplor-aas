/**
 * Accounts — my account settings (anyone) — display name · company name · email · password.
 * Split out of components/Accounts.tsx (2026-10-13 componentization) — markup and comments were moved verbatim.
 * Success and failure notices are handled by Accounts' act (the server's message as is).
 */
import { useState } from 'react';
import { api, type AuthState } from '../../api.js';
import { fill, tr } from '../../i18n.js';
import { roleLabel, type Act, type Role } from './types.js';

interface Props {
  me: NonNullable<AuthState['user']>;
  working: boolean;
  act: Act;
  onError: (message: string) => void;
  /** Changing my password re-establishes the login — makes the screen re-read */
  onChanged: () => void;
  t: (text: string) => string;
}

export function MySettings({ me, working, act, onError, onChanged, t }: Props): React.JSX.Element {
  const roleName = (role: Role): string => roleLabel(role, t);
  // My info
  const [myName, setMyName] = useState(me.displayName);
  const [myCompany, setMyCompany] = useState(me.company ?? '');
  const [myEmail, setMyEmail] = useState(me.email ?? '');
  const profileChanged = myName.trim() !== me.displayName || myCompany.trim() !== (me.company ?? '') || myEmail.trim() !== (me.email ?? '');

  // My password
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');

  const changeMine = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (next !== confirm) {
      onError(t('두 비밀번호가 다릅니다.'));
      return;
    }
    if (await act(() => api.changePassword(current, next), t('비밀번호를 바꿨습니다.'))) {
      setCurrent('');
      setNext('');
      setConfirm('');
      onChanged();
    }
  };

  const saveMine = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    const done = await act(
      () => api.updateMe({ displayName: myName.trim(), company: myCompany.trim(), email: myEmail.trim() }),
      t('내 정보를 저장했습니다.'),
    );
    if (done) onChanged();
  };

  return (
    <>
      <section>
        <h3>{t('내 정보')}</h3>
        <form className="login-form" onSubmit={(event) => void saveMine(event)}>
          <label>
            {t('로그인 이름')}
            <input value={me.login} disabled readOnly />
          </label>
          <label>
            {t('표시 이름')}
            <input value={myName} maxLength={40} autoComplete="name" onChange={(event) => setMyName(event.target.value)} />
          </label>
          <label>
            {t('회사명')}
            <input value={myCompany} maxLength={80} autoComplete="organization" onChange={(event) => setMyCompany(event.target.value)} />
          </label>
          <label>
            {t('이메일')}
            <input type="email" value={myEmail} maxLength={120} autoComplete="email" onChange={(event) => setMyEmail(event.target.value)} />
          </label>
          <p className="hint">
            {fill(tr('역할: {0} — 역할은 관리자가 「계정 관리」에서 바꿉니다.'), { 0: roleName(me.role) })}
          </p>
          <div className="row-buttons">
            <button type="submit" className="primary" disabled={working || !profileChanged || myName.trim() === ''}>
              {t('저장')}
            </button>
          </div>
        </form>
      </section>

      <section>
        <h3>{t('비밀번호 바꾸기')}</h3>
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
          <p className="hint">{t('비밀번호는 10자 이상이어야 합니다. 바꾸면 다른 곳의 로그인은 끊깁니다.')}</p>
          <div className="row-buttons">
            <button type="submit" disabled={working || current === '' || next === ''}>
              {t('비밀번호 바꾸기')}
            </button>
          </div>
        </form>
      </section>
    </>
  );
}
