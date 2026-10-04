/**
 * 통문장 번역 — 굵은 글씨나 값이 낀 문장을 **한 문장으로** 옮긴다.
 *
 *   <T k="경고 {0}건 중 <b>{1}건</b>은 자동으로 고쳐집니다." v={[warnings, fixable]} />
 *
 * 🔴 왜 필요한가. 문장을 토막 내 따로 옮기면 영어 어순이 무너진다. 실제로
 *    「경고 10건 중 10건은…」이 `Warnings 10of 10of them are cleared…`가 됐다(2026-10-02).
 *    한국어는 「N건 중 M건은」이지만 영어는 「M of the N」이다 — 순서가 바뀌려면 번역하는
 *    사람이 **문장 전체**를 쥐고 있어야 한다. 그래서 굵은 글씨(`<b>`)와 값(`{0}`)을 문장 안에
 *    그대로 적고, 그 자리를 옮겨 놓을 수 있게 한다.
 *
 * 쓸 수 있는 표시는 일부러 몇 개뿐이다: `<b>` `<strong>` `<em>` `<i>` `<code>` `<kbd>` `<br/>` 와 `{번호}`.
 * 번역문에 HTML을 풀어 놓는 것이 아니다 — 사전이 화면에 아무 태그나 넣을 수 있으면 안 된다.
 */
import { Fragment } from 'react';

import { tr } from '../i18n.js';

const TAGS = new Set(['b', 'strong', 'em', 'i', 'code', 'kbd']);
const TOKEN = /\{(\d+)\}|<br\s*\/>|<(\/?)([a-z]+)>/g;

interface Props {
  /** 한국어 통문장 — 사전의 열쇠다 */
  k: string;
  /** `{0}` `{1}` … 자리에 들어갈 것. 글자도, 화면 요소도 된다 */
  v?: readonly React.ReactNode[];
}

export function T({ k, v = [] }: Props): React.JSX.Element {
  return <>{render(tr(k), v)}</>;
}

/** 표시가 든 글자를 화면 요소로. 짝이 안 맞으면 글자 그대로 보인다(깨뜨리지 않는다) */
function render(text: string, values: readonly React.ReactNode[]): React.ReactNode[] {
  interface Frame {
    tag: string | undefined;
    children: React.ReactNode[];
  }
  const stack: Frame[] = [{ tag: undefined, children: [] }];
  const top = (): Frame => stack[stack.length - 1]!;
  let index = 0;
  let serial = 0;
  const push = (node: React.ReactNode): void => {
    top().children.push(<Fragment key={serial++}>{node}</Fragment>);
  };

  TOKEN.lastIndex = 0;
  for (let match = TOKEN.exec(text); match !== null; match = TOKEN.exec(text)) {
    if (match.index > index) push(text.slice(index, match.index));
    index = match.index + match[0].length;

    if (match[1] !== undefined) {
      push(values[Number(match[1])] ?? '');
    } else if (match[0].startsWith('<br')) {
      push(<br />);
    } else if (!TAGS.has(match[3]!)) {
      push(match[0]); // 모르는 표시는 글자로 둔다
    } else if (match[2] === '') {
      stack.push({ tag: match[3], children: [] });
    } else if (top().tag === match[3] && stack.length > 1) {
      const done = stack.pop()!;
      const Tag = done.tag as 'b';
      push(<Tag>{done.children}</Tag>);
    } else {
      push(match[0]); // 짝이 안 맞는 닫는 표시
    }
  }
  if (index < text.length) push(text.slice(index));

  // 닫히지 않은 표시가 남았으면 안의 것을 밖으로 꺼낸다 — 글자를 잃지 않는다
  while (stack.length > 1) {
    const open = stack.pop()!;
    top().children.push(...open.children);
  }
  return top().children;
}
