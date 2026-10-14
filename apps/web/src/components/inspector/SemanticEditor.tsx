/**
 * semanticId input and on-the-spot validation (reduced M4).
 * Extracted from components/Inspector.tsx (2026-10-13 componentization) — markup · comments moved verbatim at the time.
 * The value being typed is this component's state. When moving to another element or when saving changes the content, Inspector changes
 * the key and redraws, so it returns to the initial value (same result as the former "reset when the fingerprint changes" effect).
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
      {/* Reduced M4 — direct input + on-the-spot validation instead of a dictionary search UI (decision in §2) */}
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
