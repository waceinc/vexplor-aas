/**
 * 나무 목록 — 줄 메뉴(우클릭 · 「⋯」) — 그 줄로 할 수 있는 일.
 * components/TreeView.tsx 에서 떼어 냈다(2026-10-13 컴포넌트화) — 마크업·주석은 옮기기 전 글자 그대로다.
 */
import type { TreeNode } from '../../model.js';
import { fill, tr } from '../../i18n.js';
import type { TreeMenuItem } from '../TreeView.js';

export interface OpenMenu {
  node: TreeNode;
  x: number;
  y: number;
  items: TreeMenuItem[];
}

export function RowMenu({ menu, onClose }: { menu: OpenMenu; onClose: () => void }): React.JSX.Element {
  return (
    <div
      className="tree-menu"
      role="menu"
      aria-label={fill(tr('{0} 메뉴'), { 0: menu.node.label })}
      style={{ left: menu.x, top: menu.y }}
      onMouseDown={(event) => event.stopPropagation()}
    >
      {menu.items.map((item) => (
        <button
          key={item.label}
          type="button"
          role="menuitem"
          className={item.danger ? 'danger' : ''}
          disabled={item.disabled}
          {...(item.title ? { title: item.title } : {})}
          onClick={() => {
            onClose();
            item.onClick();
          }}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}
