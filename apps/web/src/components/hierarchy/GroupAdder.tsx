/**
 * 구성 트리 — 공정(또는 조립체) 넣기 줄 — 파일 없는 층의 이름을 적는다. Enter 로 연달아.
 * components/HierarchyTree.tsx 에서 떼어 냈다(2026-10-13 컴포넌트화) — 마크업·주석은 옮기기 전 글자 그대로다.
 */
import { useEffect, useRef, useState } from 'react';
import { fill, tr } from '../../i18n.js';
import { NODE_NAME_RE, nodeNameOk, type Terms } from './terms.js';

interface Props {
  path: string[];
  siblings: readonly string[];
  terms: Terms;
  busy: boolean;
  onAddGroup: (parentPath: string[], name: string) => void;
  close: () => void;
  t: (text: string) => string;
}

export function GroupAdder({ path, siblings, terms, busy, onAddGroup, close, t }: Props): React.JSX.Element {
  const [name, setName] = useState('');
  const adderRef = useRef<HTMLDivElement>(null);
  // 그 자리로 스크롤한다(입력 줄이 다른 자리로 옮겨 가면 Hierarchy 가 key 를 바꿔 새로 그린다 — 값도 비워진다)
  useEffect(() => adderRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }), []); // jsdom엔 없다
  const ok = nodeNameOk(name, siblings);
  const commit = (): void => {
    if (!ok) return;
    onAddGroup(path, name);
    setName(''); // 줄은 열어 둔다 — 공정 여러 개를 연달아
  };
  return (
    <div className="build-adder" ref={adderRef}>
      <span className="build-mark">▦</span>
      <input
        autoFocus
        aria-label={fill(tr('{0} 이름'), { 0: t(terms.group) })}
        value={name}
        placeholder={t(terms.groupPlaceholder)}
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
