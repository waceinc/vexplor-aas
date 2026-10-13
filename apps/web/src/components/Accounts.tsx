/**
 * 계정 — 두 얼굴이다(2026-10-08).
 *  - **내 계정 설정**(누구나): 표시 이름 · 회사명 · 이메일 · 비밀번호
 *  - **계정 관리**(관리자): 사람 더하기 · 역할 · 잠그기 · 비밀번호 초기화 · 삭제
 *  예전에는 한 창에 섞여, 관리자의 내 비밀번호 칸이 맨 아래 접혀 있었고 내 이름·연락처는 고칠 길이 없었다.
 *
 * 🔴 이 화면은 한동안 **없었다.** 서버에는 계정 관리 API가 있었고 문서에도 「설정 → 계정 관리」라고
 *    적혀 있었는데, 정작 누를 자리가 없었다(2026-10-04에 문서를 읽다 알아챘다).
 *    관리자가 사람을 더하려면 curl을 쳐야 했다 — 만든 기능을 쓸 수 없으면 없는 것이다.
 *
 * 🔴 실패 문구는 **서버가 준 그대로** 보여 준다. 「마지막 관리자는 잠글 수 없다」 같은 사유는
 *    서버가 판단하고, 화면이 고쳐 쓰면 뜻이 달라진다.
 *
 * 2026-10-13 컴포넌트화 — 두 얼굴을 accounts/ 의 PeopleSection · MySettings 로 나눴다. 여기는 알림 띠와 틀만.
 */
import { useState } from 'react';

import type { AuthState } from '../api.js';
import { MySettings } from './accounts/MySettings.js';
import { PeopleSection } from './accounts/PeopleSection.js';
import type { Act } from './accounts/types.js';

interface Props {
  me: NonNullable<AuthState['user']>;
  /** mine — 내 계정 설정 · people — 계정 관리(관리자) */
  mode: 'mine' | 'people';
  /** 계정 관리 창에서 「내 계정 설정」으로 건너간다 */
  onOpenMine?: () => void;
  /** 내 비밀번호를 바꾸면 로그인이 새로 잡힌다 — 화면이 다시 읽게 한다 */
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

  /** 한 가지 일을 하고, 되면 알린다 */
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

      {/* 계정 관리 창에서 내 것을 고치러 가는 길 — 관리자도 자기 이름 · 비밀번호는 「내 계정 설정」에서 */}
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
