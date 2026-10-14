/**
 * Settings — currently just the language.
 *
 * Important: **state first how far English goes.** Screen text and the text the server produces (finding messages, rule descriptions,
 *    validation reports, bundle notes, errors) all have English (2026-10-14). What stays Korean on the English screen is only
 *    **what comes from the file** (names, values) and **folder/file names in the submission bundle** (names fixed by the submission structure).
 *    Without knowing this it reads as "translation is incomplete" — so we write down what remains.
 *
 * Important: **changing the language reloads the screen** (the caller does it). String tables defined at the top of files
 *    are frozen in the language first loaded, so merely re-rendering changes only half of it (i18n.ts `current`).
 */
import type { Lang } from '../i18n.js';
import { tr } from '../i18n.js';
import { T } from './T.js';

interface Props {
  lang: Lang;
  onChange: (lang: Lang) => void;
  onClose: () => void;
  t: (text: string) => string;
}

export function Settings({ lang, onChange, onClose, t }: Props): React.JSX.Element {
  return (
    <div className="settings">
      <h2>{t('설정')}</h2>

      <section>
        <h3>{t('언어')}</h3>
        <div className="row-buttons">
          <button
            className={lang === 'ko' ? 'primary' : ''}
            title={tr('화면 글자를 한국어로 — 모든 글자가 한국어입니다')}
            onClick={() => onChange('ko')}
          >
            {/* i18n-ignore — a language's name is written in that language ("한국어" even on the English screen) */}
            한국어
          </button>
          <button
            className={lang === 'en' ? 'primary' : ''}
            title={tr('화면 글자와 서버가 만드는 글(지적 문구·검증 결과서)을 영어로')}
            onClick={() => onChange('en')}
          >
            English
          </button>
        </div>
        <p className="note">
          <T k={'영어를 고르면 화면 글자와 지적 문구·규칙 설명·검증 결과서가 모두 영어로 나옵니다. <b>파일에서 온 이름과 값</b>, 제출 묶음의 폴더 이름은 그대로 남습니다.'} />
        </p>
        <p className="hint">
          {tr('고른 언어는 이 브라우저에 남습니다. 서버 설정이 아니라 보는 사람마다 따로입니다.')}{' '}
          {tr('언어를 바꾸면 화면을 새로 읽습니다 — 파일은 그대로 있고, 저장하지 않은 입력만 사라집니다.')}
        </p>
      </section>

      <div className="row-buttons actions">
        <button className="primary" onClick={onClose}>
          {t('닫기')}
        </button>
      </div>
    </div>
  );
}
