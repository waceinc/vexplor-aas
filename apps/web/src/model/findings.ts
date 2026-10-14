/**
 * 모델 — 지적을 트리 노드에 붙이고 건수 · 가장 나쁜 등급을 모은다.
 * src/model.ts 에서 떼어 냈다(2026-10-13 컴포넌트화) — 코드와 주석은 옮기기 전 글자 그대로다. 밖에서는 model.ts 로 쓴다.
 */
import { type Finding, type TreeNode } from './types.js';

/**
 * 지적을 노드에 귀속시킨다.
 * finding.pointer는 노드보다 깊을 수 있다(`.../semanticId`, `.../value`) —
 * 그래서 **가장 길게 겹치는 노드**에 붙인다.
 */
export function attachFindings(
  roots: readonly TreeNode[],
  findings: readonly Finding[],
): Map<string, Finding[]> {
  const keys: string[] = [];
  const walk = (nodes: readonly TreeNode[]): void => {
    for (const node of nodes) {
      keys.push(node.pointer);
      walk(node.children);
    }
  };
  walk(roots);
  keys.sort((a, b) => b.length - a.length); // 긴 것부터 본다

  const byNode = new Map<string, Finding[]>();
  for (const finding of findings) {
    const owner = keys.find((key) => finding.pointer === key || finding.pointer.startsWith(`${key}/`));
    if (owner === undefined) continue;
    byNode.set(owner, [...(byNode.get(owner) ?? []), finding]);
  }
  return byNode;
}

export interface FindingTally {
  /** 이 노드에 직접 붙은 지적 */
  own: number;
  /** 자손까지 합친 수 */
  total: number;
  /** 자손까지 통틀어 가장 무거운 등급 */
  worst: Finding['severity'];
}

/**
 * 노드별 지적 집계.
 *
 * 접힌 노드에 자손의 지적이 보이지 않으면 **어디를 펼쳐야 할지 알 수 없다.**
 * 골든 파일의 CD 경고 2건이 접힌 그룹 안에 숨어 있던 것이 그 예다(2026-08-24, 화면에서 발견).
 * 참고(info)는 세지 않는다 — 고칠 것이 없는 사실은 배지가 아니라 지적 팝업의 「참고」 접힘에 있다.
 */
export function tallyFindings(
  roots: readonly TreeNode[],
  byNode: ReadonlyMap<string, Finding[]>,
): Map<string, FindingTally> {
  const out = new Map<string, FindingTally>();

  const visit = (node: TreeNode): FindingTally => {
    // 🔴 참고(info)는 배지에 세지 않는다 — 고칠 것이 없는 사실 전달인데 회색 숫자가 트리에 남아
    //    "경고 숫자가 남아 있다"고 읽혔다(2026-09-07). 배지는 위반·경고 수다(사용법 §3)
    const own = (byNode.get(node.pointer) ?? []).filter((finding) => finding.severity !== 'info');
    let total = own.length;
    let worst: Finding['severity'] = 'info';
    for (const finding of own) {
      if (severityRank(finding.severity) < severityRank(worst)) worst = finding.severity;
    }
    for (const child of node.children) {
      const childTally = visit(child);
      total += childTally.total;
      if (childTally.total > 0 && severityRank(childTally.worst) < severityRank(worst)) {
        worst = childTally.worst;
      }
    }
    const tally: FindingTally = { own: own.length, total, worst };
    out.set(node.pointer, tally);
    return tally;
  };

  for (const root of roots) visit(root);
  return out;
}

export function severityRank(severity: Finding['severity']): number {
  return severity === 'error' ? 0 : severity === 'warning' ? 1 : 2;
}
