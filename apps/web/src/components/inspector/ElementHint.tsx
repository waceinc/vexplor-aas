/**
 * Guidance where there is nothing to edit — a concept definition (CD), or a collection whose values sit in the elements below.
 * Split out of components/Inspector.tsx (2026-10-13 componentization) — markup and comments were moved verbatim.
 */
import { T } from '../T.js';
import type { TreeNode } from '../../model.js';

export function ElementHint({ node }: { node: TreeNode }): React.JSX.Element {
  return (
    <p className="hint">
      {node.modelType === 'ConceptDescription' ? (
        <>
          <T k={'<b>용어 정의</b>입니다 — 서브모델 요소가 쓰는 이름의 뜻풀이이고, 요소의 {0}가 여기를 가리킵니다. 표준 사전(ECLASS·IEC CDD)에서 온 것은 그대로 두고, 도구가 만든 것은 아래에서 뜻풀이를 채우십시오 — 문서용 자료의 「정의」 열에 그대로 실립니다.'} v={[<span className="mono">semanticId</span>]} /></>
      ) : (
        <><T k={'여기서는 <b>{0}</b>의 내용을 확인합니다. 값은 아래 요소(Property 등)에 있습니다 — 트리에서 펼쳐 고르십시오.'} v={[node.modelType]} /></>
      )}
    </p>
  );
}
