/**
 * Composition tree — process (or assembly) add row — type the name of a level without a file. Enter to add several in a row.
 * Split out of components/HierarchyTree.tsx (2026-10-13 componentization) — markup and comments were moved verbatim.
 */
import { useEffect, useRef, useState } from 'react';
import { fill, tr } from '../../i18n.js';
import { NODE_NAME_RE, nodeNameOk, type Terms } from './terms.js';

interface Props {
  path: string[];
  siblings: readonly string[];
  terms: Terms;
  /** Is this a row for adding a line — only the wording and labels differ */
  line?: boolean;
  busy: boolean;
  onAddGroup: (parentPath: string[], name: string, line?: boolean) => void;
  close: () => void;
  t: (text: string) => string;
}

export function GroupAdder({ path, siblings, terms, line = false, busy, onAddGroup, close, t }: Props): React.JSX.Element {
  const label = line && terms.line ? terms.line : terms.group;
  const [name, setName] = useState('');
  const adderRef = useRef<HTMLDivElement>(null);
  // Scroll to that spot (when the input row moves elsewhere, Hierarchy changes the key and redraws it — the value is cleared too)
  // Wrapped in braces so nothing is returned — current Chrome's scrollIntoView returns a Promise; returning it made
  // React treat it as a cleanup function and call it when the row closed, freezing the whole screen (measured 2026-10-14). jsdom has no scrollIntoView
  useEffect(() => {
    void adderRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, []);
  const ok = nodeNameOk(name, siblings);
  const commit = (): void => {
    if (!ok) return;
    onAddGroup(path, name, line);
    setName(''); // keep the row open — for adding several processes in a row
  };
  return (
    <div className="build-adder" ref={adderRef}>
      <span className="build-mark">{line ? '▤' : '▦'}</span>
      <input
        autoFocus
        aria-label={fill(tr('{0} 이름'), { 0: t(label) })}
        value={name}
        placeholder={t(line ? terms.linePlaceholder : terms.groupPlaceholder)}
        disabled={busy}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commit();
          }
          if (event.key === 'Escape') close();
        }}
      />
      <button
        type="button"
        className="primary"
        disabled={!ok || busy}
        title={tr('이 줄 아래에 넣습니다')}
        onClick={commit}
      >
        {tr('넣기')}
      </button>
      <button type="button" onClick={close} disabled={busy}>
        {tr('닫기')}
      </button>
      {name !== '' && !NODE_NAME_RE.test(name) && (
        <p className="warn">{tr('영문으로 시작, 영문·숫자·밑줄 2자 이상.')}</p>
      )}
      {name !== '' && NODE_NAME_RE.test(name) && siblings.includes(name) && (
        <p className="warn">{tr('같은 자리에 같은 이름이 이미 있습니다.')}</p>
      )}
    </div>
  );
}
