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
  /** 라인을 넣는 줄인가 — 낱말·표시만 다르다 */
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
  // 그 자리로 스크롤한다(입력 줄이 다른 자리로 옮겨 가면 Hierarchy 가 key 를 바꿔 새로 그린다 — 값도 비워진다)
  // 중괄호로 감싸 아무것도 돌려주지 않는다 — 요즘 크롬은 scrollIntoView 가 Promise 를 돌려줘, 그대로 돌려주면
  // React 가 그것을 정리 함수로 알고 줄이 닫힐 때 불러 화면 전체가 멈췄다(2026-10-14 실측). jsdom 에는 scrollIntoView 가 없다
  useEffect(() => {
    void adderRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, []);
  const ok = nodeNameOk(name, siblings);
  const commit = (): void => {
    if (!ok) return;
    onAddGroup(path, name, line);
    setName(''); // 줄은 열어 둔다 — 공정 여러 개를 연달아
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
