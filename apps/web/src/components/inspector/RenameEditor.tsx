/**
 * 이름(idShort) 바꾸기.
 * components/Inspector.tsx 에서 떼어 냈다(2026-10-13 컴포넌트화) — 마크업·주석은 옮기기 전 글자 그대로다.
 * 입력 중인 값은 이 부품의 상태다. 다른 요소로 옮기거나 저장으로 내용이 바뀌면 Inspector 가 key 를 바꿔
 * 새로 그리므로 처음 값으로 돌아간다(예전 「지문이 바뀌면 초기화」 효과와 같은 결과).
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
