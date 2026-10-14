/**
 * Whole-sentence translation — translates a sentence containing bold text or values **as one sentence**.
 *
 *   <T k="경고 {0}건 중 <b>{1}건</b>은 자동으로 고쳐집니다." v={[warnings, fixable]} />
 *   (the key is the Korean sentence: "Of {0} warnings, <b>{1}</b> are fixed automatically.")
 *
 * Important: why it is needed. Translating a sentence in fragments breaks English word order. In practice
 *    "경고 10건 중 10건은…" became `Warnings 10of 10of them are cleared…` (2026-10-02).
 *    Korean says "of N, M" (N건 중 M건은) while English says "M of the N" — to reorder, the translator
 *    must hold **the whole sentence**. So bold text (`<b>`) and values (`{0}`) are written inside the
 *    sentence as they are, and their positions can be moved.
 *
 * Only a few markers are allowed, on purpose: `<b>` `<strong>` `<em>` `<i>` `<code>` `<kbd>` `<br/>` and `{number}`.
 * This does not unleash HTML from translations — the dictionary must not be able to put arbitrary tags on screen.
 */
import { Fragment } from 'react';

import { tr } from '../i18n.js';

const TAGS = new Set(['b', 'strong', 'em', 'i', 'code', 'kbd']);
const TOKEN = /\{(\d+)\}|<br\s*\/>|<(\/?)([a-z]+)>/g;

interface Props {
  /** Korean whole sentence — the dictionary key */
  k: string;
  /** What goes into the `{0}` `{1}` … slots. Can be text or screen elements */
  v?: readonly React.ReactNode[];
}

export function T({ k, v = [] }: Props): React.JSX.Element {
  return <>{render(tr(k), v)}</>;
}

/** Marked-up text to screen elements. If tags do not pair up, the text is shown as is (never breaks) */
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
      push(match[0]); // unknown markers stay as text
    } else if (match[2] === '') {
      stack.push({ tag: match[3], children: [] });
    } else if (top().tag === match[3] && stack.length > 1) {
      const done = stack.pop()!;
      const Tag = done.tag as 'b';
      push(<Tag>{done.children}</Tag>);
    } else {
      push(match[0]); // closing marker without a matching opener
    }
  }
  if (index < text.length) push(text.slice(index));

  // If unclosed markers remain, lift their contents out — no text is lost
  while (stack.length > 1) {
    const open = stack.pop()!;
    top().children.push(...open.children);
  }
  return top().children;
}
