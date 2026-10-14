/**
 * Composition tree — row list (recursive) — ▦ level · ⚙ equipment, "+ Equipment" · "✕" per row, the open input row.
 * Split out of components/HierarchyTree.tsx (2026-10-13 componentization) — markup and comments were moved verbatim.
 */
import type { ReactNode } from 'react';
import { fill, tr } from '../../i18n.js';
import { same, type Adder, type DraftNode, type Terms } from './terms.js';

interface Props {
  list: readonly DraftNode[];
  path: string[];
  terms: Terms;
  adder: Adder | undefined;
  busy: boolean;
  open: (path: string[], kind: Adder['kind']) => void;
  onRemove: (path: string[], node: DraftNode) => void;
  leafExtra?: (node: DraftNode, path: string[]) => ReactNode;
  renderAdder: (path: string[]) => React.JSX.Element;
  t: (text: string) => string;
}

export function BuildNodes(props: Props): React.JSX.Element {
  const { list, path, terms, adder, busy, open, onRemove, leafExtra, renderAdder, t } = props;
  return (
    <>
      {list.map((node) => {
        const here = [...path, node.name];
        const focus = adder !== undefined && same(adder.path, here);
        return (
          <li key={here.join('/')}>
            <div className={`build-row${focus ? ' focus' : ''}`}>
              {node.kind === 'group' ? (
                <>
                  <span className="build-mark" title={t(node.line ? terms.lineMark : terms.groupMark)}>{node.line ? '▤' : '▦'}</span>
                  <span className="build-name">{node.name}</span>
                  <span className="dim">{t(node.line && terms.line ? terms.line : terms.group)}</span>
                  {node.line && (
                    <button
                      type="button"
                      className="act"
                      disabled={busy}
                      title={tr('이 라인 아래에 공정을 만듭니다')}
                      onClick={() => open(here, 'group')}
                    >
                      ＋ {t(terms.group)}
                    </button>
                  )}
                  <button
                type="button"
                className="act"
                disabled={busy}
                title={tr('이 줄 아래에 설비(또는 부품)를 넣습니다')}
                onClick={() => open(here, 'asset')}
              >
                    ＋ {t(terms.asset)}
                  </button>
                </>
              ) : (
                <>
                  <span
                    className="build-mark"
                    title={
                      node.kind === 'file'
                        ? fill(tr('{0} — 올려 둔 파일'), { 0: t(terms.asset) })
                        : node.kind === 'planned'
                          ? fill(tr('{0} — 이름만. 같은 이름으로 파일을 만들면 이어집니다'), { 0: t(terms.asset) })
                          : fill(tr('{0} — 파일이 열려 있지 않습니다'), { 0: t(terms.asset) })
                    }
                  >
                    ⚙
                  </span>
                  <span className="build-name">{node.name}</span>
                  {node.count > 1 && (
                    <span className="hier-count">{node.split ? `_1…_${node.count} ${t('호기별')}` : `×${node.count}${t('대')}`}</span>
                  )}
                  {node.kind === 'file' && <span className="dim pick-file">{node.fileName}</span>}
                  {node.kind === 'planned' && terms.fileBadges && (
                    <span className="hier-count planned" title={tr('같은 이름으로 설비 파일을 만들면 저절로 이어집니다')}>
                      {tr('예정')}
                    </span>
                  )}
                  {node.kind === 'unopened' && terms.fileBadges && (
                    <span className="hier-count unopened" title={tr('이 설비 파일이 올라와 있지 않습니다 — 올리면 이어집니다')}>
                      {tr('파일 안 열림')}
                    </span>
                  )}
                  {leafExtra?.(node, here)}
                </>
              )}
              <button
                type="button"
                className="act danger"
                disabled={busy}
                title={node.kind === 'group' ? fill(tr('{0}을(를) 빼면 그 밑 {1}은(는) 한 층 위로 올라옵니다'), { 0: t(terms.group), 1: t(terms.asset) }) : tr('이 목록에서 뺍니다 — 파일은 지워지지 않습니다')}
                onClick={() => onRemove(here, node)}
              >
                ✕
              </button>
            </div>
            {node.kind === 'group' && (
              <ul>
                <BuildNodes {...props} list={node.children} path={here} />
                {adder && same(adder.path, here) && <li>{renderAdder(here)}</li>}
              </ul>
            )}
          </li>
        );
      })}
    </>
  );
}
