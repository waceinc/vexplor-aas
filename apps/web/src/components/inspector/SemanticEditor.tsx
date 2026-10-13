/**
 * semanticId 입력과 그 자리 검증(M4 축소판).
 * components/Inspector.tsx 에서 떼어 냈다(2026-10-13 컴포넌트화) — 마크업·주석은 옮기기 전 글자 그대로다.
 * 입력 중인 값은 이 부품의 상태다. 다른 요소로 옮기거나 저장으로 내용이 바뀌면 Inspector 가 key 를 바꿔
 * 새로 그리므로 처음 값으로 돌아간다(예전 「지문이 바뀌면 초기화」 효과와 같은 결과).
 */
import { useState } from 'react';
import type { Policy } from '../../api.js';
import { checkSemanticId, type TreeNode } from '../../model.js';

interface Props {
  node: TreeNode;
  busy: boolean;
  policy: Policy;
  conceptIds?: ReadonlySet<string>;
  onSaveSemanticId: (node: TreeNode, semanticId: string) => void;
  t: (text: string) => string;
}

export function SemanticEditor({ node, busy, policy, conceptIds, onSaveSemanticId, t }: Props): React.JSX.Element {
  const [semantic, setSemantic] = useState(() => {
    const reference = node.node['semanticId'] as { keys?: { value: string }[] } | undefined;
    return reference?.keys?.[0]?.value ?? '';
  });
  return (
    <div className="editor semantic">
      {/* M4 축소판 — 사전 검색 UI 대신 직접 입력 + 그 자리 검증(§2 결정) */}
      <label className="stack">
        {node.modelType === 'Submodel'
          ? t('semanticId (표준 템플릿 IRI 또는 IRDI)')
          : t('semanticId (IRDI 또는 자체 IRI)')}
        <input
          value={semantic}
          aria-label="semanticId"
          className="mono"
          onChange={(event) => setSemantic(event.target.value)}
          placeholder="0112/2///61987#ABA231#009"
        />
      </label>
      {checkSemanticId(
        semantic,
        policy,
        conceptIds?.has(semantic.trim()) ?? false,
        node.modelType === 'Submodel' ? 'submodel' : 'element',
        t,
      ).map(
        (note, index) => (
          <p key={index} className={`note ${note.level}`}>
            {note.message}
          </p>
        ),
      )}
      <button
        disabled={busy || semantic.trim() === ''}
        title={t('semanticId를 반영합니다 — 뜻을 가리키는 주소라 Validator가 가장 먼저 봅니다')}
        onClick={() => onSaveSemanticId(node, semantic.trim())}
      >
        {t('semanticId 저장')}
      </button>
    </div>
  );
}
