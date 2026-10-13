/**
 * 편집 칸 아래 동작 — 요소 추가 · 사본 만들기 · 삭제.
 * components/Inspector.tsx 에서 떼어 냈다(2026-10-13 컴포넌트화) — 마크업·주석은 옮기기 전 글자 그대로다.
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
      {/* 순서 바꾸기는 여기 없다 — 왼쪽 트리에서 끌어서 놓는다(우클릭 메뉴·Alt+↑↓도). 버튼 이름만으로
          무엇인지 모르겠다는 지적(2026-09-04)에 따라 남는 것도 하는 일을 그대로 적는다 */}
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
