/**
 * Actions below the edit fields — add element · make copy · delete.
 * Split out of components/Inspector.tsx (2026-10-13 componentization) — markup and comments were moved verbatim.
 */
import type { TreeNode } from '../../model.js';

interface Props {
  node: TreeNode;
  busy: boolean;
  onAddChild?: (node: TreeNode) => void;
  onDuplicate?: (node: TreeNode) => void;
  onDelete?: (node: TreeNode) => void;
  t: (text: string) => string;
}

export function ElementActions({ node, busy, onAddChild, onDuplicate, onDelete, t }: Props): React.JSX.Element {
  return (
    <>
      {/* Reordering is not here — drag and drop in the left tree (also the right-click menu · Alt+↑↓). Following the remark that
          button names alone did not say what they do (2026-09-04), the remaining ones state exactly what they do */}
      <div className="row-buttons actions">
        {onAddChild && (
          <button disabled={busy} title={t('이 안에 새 요소를 만듭니다')} onClick={() => onAddChild(node)}>
            {t('요소 추가')}
          </button>
        )}
        {onDuplicate && (
          <button disabled={busy} title={t('안의 요소와 값까지 그대로 하나 더 — 두 번째 인증 마크·문서·연락처를 넣을 때 (이름 끝에 _2)')} onClick={() => onDuplicate(node)}>
            {t('사본 만들기')}
          </button>
        )}
        {onDelete && (
          <button className="danger" disabled={busy} title={t('잘못 지웠으면 「↶ 되돌리기」')} onClick={() => onDelete(node)}>
            {t('삭제')}
          </button>
        )}
        {onDelete && node.idShortPath !== undefined && (
          <span className="hint">{t('순서는 왼쪽 트리에서 끌어서 바꿉니다 (또는 우클릭 · Alt+↑↓)')}</span>
        )}
      </div>
    </>
  );
}
