/**
 * Accounts — two faces (2026-10-08).
 *  - **My account settings** (everyone): display name · company · email · password
 *  - **Account management** (administrators): add people · roles · lock · reset password · delete
 *  Previously both were mixed in one window: the administrator's own password field was folded at the bottom, and there was no way to edit one's own name or contact details.
 *
 * Important: for a while this screen **did not exist.** The server had an account management API and the docs said
 *    "Settings → Account management", yet there was nowhere to click (noticed on 2026-10-04 while reading the docs).
 *    An administrator had to type curl commands to add people — a feature you cannot use does not exist.
 *
 * Important: failure messages are shown **exactly as the server sent them.** Reasons such as "the last administrator cannot be locked"
 *    are decided by the server; if the screen rewrote them, the meaning would change.
 *
 * 2026-10-13 componentized — the two faces were split into accounts/ PeopleSection · MySettings. This file holds only the notice bar and frame.
 */
import { useState } from 'react';

import type { AuthState } from '../api.js';
import { MySettings } from './accounts/MySettings.js';
import { PeopleSection } from './accounts/PeopleSection.js';
import type { Act } from './accounts/types.js';

interface Props {
  me: NonNullable<AuthState['user']>;
  /** mine — my account settings · people — account management (administrators) */
  mode: 'mine' | 'people';
  /** Jump from the account management window to "my account settings" */
  onOpenMine?: () => void;
  /** Changing my password re-establishes the session — make the screen reload it */
  onChanged: () => void;
  onClose: () => void;
  describeError: (caught: unknown) => string;
  t: (text: string) => string;
}

export function Accounts({ me, mode, onOpenMine, onChanged, onClose, describeError, t }: Props): React.JSX.Element {
  const isAdmin = me.role === 'admin' && mode === 'people';
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [working, setWorking] = useState(false);

  /** Do one thing and, when it succeeds, report it */
  const act: Act = async (work, done) => {
    setError(undefined);
    setNotice(undefined);
    setWorking(true);
    try {
      await work();
      setNotice(done);
      return true;
    } catch (caught) {
      setError(describeError(caught));
      return false;
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="settings accounts">
      <h2>{mode === 'mine' ? t('내 계정 설정') : t('계정 관리')}</h2>

      {error && (
        <p className="note bad" role="alert">
          {error}
        </p>
      )}
      {notice && <p className="note ok">{notice}</p>}

      {isAdmin && <PeopleSection me={me} working={working} act={act} onError={setError} describeError={describeError} t={t} />}
      {mode === 'mine' && <MySettings me={me} working={working} act={act} onError={setError} onChanged={onChanged} t={t} />}

      {/* Way from the account management window to edit my own details — administrators also edit their own name · password in "my account settings" */}
      {mode === 'people' && onOpenMine && (
        <p className="hint">
          <button type="button" className="link" onClick={onOpenMine}>
            {t('내 계정 설정 →')}
          </button>{' '}
          {t('내 이름 · 연락처 · 비밀번호는 여기서 바꿉니다.')}
        </p>
      )}

      <div className="row-buttons actions">
        <button onClick={onClose}>{t('닫기')}</button>
      </div>
    </div>
  );
}
