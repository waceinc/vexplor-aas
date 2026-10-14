/**
 * Value editing — MultiLanguageProperty (text per language) · Range (min · max) · other values (text).
 * Split out of components/Inspector.tsx (2026-10-13 componentization) — markup and comments were moved verbatim.
 * Values being typed are this part's state. When moving to another element or when a save changes the content, Inspector changes
 * the key and redraws it, so it returns to the initial values (same result as the old "reset when the fingerprint changes").
 */
import { useState } from 'react';
import { fill, tr } from '../../i18n.js';
import type { TreeNode } from '../../model.js';
import type { LangText } from './helpers.js';

interface Props {
  node: TreeNode;
  busy: boolean;
  onSave: (node: TreeNode, value: unknown) => void;
  t: (text: string) => string;
}

export function ValueEditor({ node, busy, onSave, t }: Props): React.JSX.Element {
  const raw = node.node;
  const [text, setText] = useState(typeof raw.value === 'string' ? raw.value : '');
  const [langs, setLangs] = useState<LangText[]>(Array.isArray(raw.value) ? (raw.value as LangText[]) : []);
  const [range, setRange] = useState<{ min: string; max: string }>({ min: String(raw['min'] ?? ''), max: String(raw['max'] ?? '') });
  if (node.modelType === 'MultiLanguageProperty') {
    return (
      <div className="editor">
        {langs.map((entry, index) => (
          <div className="lang-row" key={index}>
            <input
              value={entry.language}
              aria-label={t('언어')}
              onChange={(event) =>
                setLangs(langs.map((l, i) => (i === index ? { ...l, language: event.target.value } : l)))
              }
            />
            <input
              value={entry.text}
              aria-label={t('내용')}
              onChange={(event) =>
                setLangs(langs.map((l, i) => (i === index ? { ...l, text: event.target.value } : l)))
              }
            />
            {/* There was a case where a language could not be removed, so an empty row got saved — an empty text violates the PKG-LANG rule */}
            <button
              className="link"
              title={t('이 언어 줄을 뺍니다')}
              aria-label={fill(tr('{0} 줄 빼기'), { 0: entry.language || tr('언어') })}
              onClick={() => setLangs(langs.filter((_, i) => i !== index))}
            >
              ✕
            </button>
          </div>
        ))}
        <button
          title={t('언어 줄을 하나 더 만듭니다 — 같은 뜻을 ko·en으로 나란히 적습니다')}
          onClick={() => setLangs([...langs, { language: 'ko', text: '' }])}
        >
          {t('언어 추가')}
        </button>
        <button
          className="primary"
          disabled={busy}
          title={t('이 요소의 언어별 글을 서버에 바로 반영합니다 — 되돌리려면 헤더의 ↶')}
          onClick={() => onSave(node, langs)}
        >
          {t('저장')}
        </button>
      </div>
    );
  }
  if (node.modelType === 'Range') {
    return (
      <div className="editor">
        <input
          value={range.min}
          aria-label={t('최소')}
          onChange={(event) => setRange({ ...range, min: event.target.value })}
        />
        <input
          value={range.max}
          aria-label={t('최대')}
          onChange={(event) => setRange({ ...range, max: event.target.value })}
        />
        <button
          className="primary"
          disabled={busy}
          title={t('최소·최대를 서버에 바로 반영합니다 — 되돌리려면 헤더의 ↶')}
          onClick={() => onSave(node, range)}
        >
          {t('저장')}
        </button>
      </div>
    );
  }
  return (
    <div className="editor">
      <textarea
        value={text}
        aria-label={t('값')}
        rows={3}
        onChange={(event) => setText(event.target.value)}
      />
      <button
        className="primary"
        disabled={busy}
        title={t('이 요소의 값을 서버에 바로 반영합니다 — 되돌리려면 헤더의 ↶')}
        onClick={() => onSave(node, text)}
      >
        {t('저장')}
      </button>
    </div>
  );
}
