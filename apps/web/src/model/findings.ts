/**
 * Model — attaches findings to tree nodes and aggregates counts · worst severity.
 * Split out of src/model.ts (2026-10-13 componentization) — code and comments are verbatim from before the move. Import it via model.ts.
 */
import { type Finding, type TreeNode } from './types.js';

/**
 * Assigns findings to nodes.
 * finding.pointer can be deeper than a node (`.../semanticId`, `.../value`) —
 * so it is attached to the **node with the longest overlap**.
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
  keys.sort((a, b) => b.length - a.length); // longest first

  const byNode = new Map<string, Finding[]>();
  for (const finding of findings) {
    const owner = keys.find((key) => finding.pointer === key || finding.pointer.startsWith(`${key}/`));
    if (owner === undefined) continue;
    byNode.set(owner, [...(byNode.get(owner) ?? []), finding]);
  }
  return byNode;
}

export interface FindingTally {
  /** Findings attached directly to this node */
  own: number;
  /** Count including descendants */
  total: number;
  /** Most severe level across all descendants */
  worst: Finding['severity'];
}

/**
 * Per-node finding aggregation.
 *
 * If a collapsed node does not show its descendants' findings, **you cannot tell what to expand.**
 * Example: the golden file's 2 CD warnings were hidden inside a collapsed group (2026-08-24, found on screen).
 * Info is not counted — facts with nothing to fix live in the finding popup's collapsed "Info" section, not in badges.
 */
export function tallyFindings(
  roots: readonly TreeNode[],
  byNode: ReadonlyMap<string, Finding[]>,
): Map<string, FindingTally> {
  const out = new Map<string, FindingTally>();

  const visit = (node: TreeNode): FindingTally => {
    // Important: info is not counted in badges — it conveys facts with nothing to fix, yet a grey number stayed in the tree
    //    and read as "warning count still there" (2026-09-07). Badges count violations and warnings (usage guide §3)
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
