/**
 * Rename (idShort).
 * Extracted from components/Inspector.tsx (2026-10-13 componentization) — markup · comments moved verbatim at the time.
 * The value being typed is this component's state. When moving to another element or when saving changes the content, Inspector changes
 * the key and redraws, so it returns to the initial value (same result as the former "reset when the fingerprint changes" effect).
 */
import { useState } from 'react';
import type { TreeNode } from '../../model.js';

interface Props {
  node: TreeNode;
  busy: boolean;
  onRename: (node: TreeNode, name: string) => void;
  t: (text: string) => string;
}

export function RenameEditor({ node, busy, onRename, t }: Props): React.JSX.Element {
  const raw = node.node;
  const [name, setName] = useState(String(raw['idShort'] ?? ''));
  return (
    <div className="editor rename">
      <label className="stack">
        {t('이름 (idShort)')}
        <input
          value={name}
          aria-label={t('이름')}
          className="mono"
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      {name.trim() !== '' && !/^[A-Za-z][A-Za-z0-9_]*$/.test(name.trim()) && (
        <p className="note warning">
          {t('영문으로 시작하고 영문·숫자·밑줄만 쓰는 편이 안전합니다(표준 권고).')}
        </p>
      )}
      <button
        disabled={busy || name.trim() === '' || name.trim() === String(raw['idShort'] ?? '')}
        title={t('idShort를 바꿉니다 — 이 이름을 가리키던 다른 요소의 참조는 따라오지 않습니다')}
        onClick={() => onRename(node, name.trim())}
      >
        {t('이름 바꾸기')}
      </button>
    </div>
  );
}
