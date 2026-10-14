/**
 * Tree list — row menu (right-click · "⋯") — what you can do with that row.
 * Split out of components/TreeView.tsx (componentization, 2026-10-13) — markup and comments are verbatim from before the move.
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
