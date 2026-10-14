/**
 * Undo · redo · auto-fix (preview → apply only the chosen items, per file) · revert from the migration ledger.
 * Split out of App.tsx (2026-10-13 componentization) — code and comments are verbatim from before the move;
 * the state and actions it uses arrive under the same names (taken from c).
 */
import { api, type FixReport } from '../api.js';
import { type FixPlan } from '../components/FixPreview.js';
import { fill, tr } from '../i18n.js';
import type { Core } from './context.js';

export function useFixActions(c: Pick<Core, 'ledger' | 'loadPackage' | 'markStart' | 'mounts' | 'packageId' | 'packages' | 'run' | 'setFixPlans' | 'setFixReport' | 'setNotice' | 'undoState'>) {
  const { ledger, loadPackage, markStart, mounts, packageId, packages, run, setFixPlans, setFixReport, setNotice, undoState } = c;
  /**
   * Undo/redo — "go back when you made a mistake". For any change (value · delete · order · auto-fix) the server
   * holds the previous state, so it returns in one step. No confirmation dialog — an undo can itself be undone
   */
  const onUndo = async (): Promise<void> => {
    if (!packageId || undoState.undo.length === 0) return;
    const result = await run(() => api.undo(packageId));
    if (!result) return;
    setNotice(fill(tr('되돌렸습니다: {0}. 잘못 눌렀으면 「다시 하기」.'), { 0: result.undone }));
    await loadPackage(packageId);
  };
  const onRedo = async (): Promise<void> => {
    if (!packageId || undoState.redo.length === 0) return;
    const result = await run(() => api.redo(packageId));
    if (!result) return;
    setNotice(fill(tr('다시 했습니다: {0}.'), { 0: result.redone }));
    await loadPackage(packageId);
  };
  /**
   * "Auto-fix" — do not fix right away; start with a **preview popup**. Show per-item before/after of what changes and how,
   * and apply only the checked ones (user 2026-09-11: "so you just convert it to your own format and that's it?").
   */
  const onFix = async (): Promise<void> => {
    if (!packageId) return;
    markStart('fix');
    // For a process (bundle), include the spliced equipment files — fetch each file's preview separately and show them per file
    const targets = [
      {
        packageId,
        name: packages.find((item) => item.packageId === packageId)?.name ?? tr('이 파일'),
        self: true,
      },
      ...mounts.map((m) => ({ packageId: m.pid, name: m.name, self: false })),
    ];
    const plans = await run(async () => {
      const previews = await Promise.all(
        targets.map((t) => api.fixPreview(t.packageId).catch(() => undefined)),
      );
      const made: FixPlan[] = [];
      targets.forEach((t, i) => {
        const preview = previews[i];
        if (preview && preview.applied.length > 0) made.push({ ...t, preview });
      });
      return made;
    });
    if (!plans) return;
    setFixPlans(plans);
  };
  /**
   * Apply only the checked items — **split per file**, each written to its own source.
   * Important: if one file fails, continue with the rest. Stopping midway leaves no way to know how far it got.
   */
  const onApplyFix = async (
    select: { packageId: string; ruleId: string; pointer: string }[],
  ): Promise<void> => {
    if (!packageId) return;
    setFixPlans(undefined);
    const byPackage = new Map<string, { ruleId: string; pointer: string }[]>();
    for (const item of select) {
      const list = byPackage.get(item.packageId) ?? [];
      list.push({ ruleId: item.ruleId, pointer: item.pointer });
      byPackage.set(item.packageId, list);
    }
    const failed: string[] = [];
    let mine: FixReport | undefined;
    let others = 0;
    await run(async () => {
      for (const [pid, picks] of byPackage) {
        try {
          const report = await api.fix(pid, picks);
          if (pid === packageId) mine = report;
          else others += report.applied.length;
        } catch {
          failed.push(mounts.find((m) => m.pid === pid)?.name ?? pid);
        }
      }
      return true;
    });
    if (mine) setFixReport(mine);
    if (others > 0 || failed.length > 0) {
      setNotice(
        fill(tr('연결 설비 파일에서 {0}건을 고쳤습니다'), { 0: others }) +
          (failed.length > 0 ? fill(tr(' — 다만 {0}는 고치지 못했습니다.'), { 0: failed.join(' · ') }) : '.'),
      );
    }
    await loadPackage(packageId);
  };
  /** Revert to the original IRI from the migration ledger — under a KOSMO-first policy it is flagged as a violation again. The path for when the interpretation of the rules changes */
  const onRevertLedger = async (): Promise<void> => {
    if (!packageId) return;
    const count = Object.keys(ledger).length;
    if (
      !window.confirm(
        fill(tr('이관 대장의 {0}건을 IDTA 원본 IRI로 되돌립니다. 지금 정책(KOSMO 우선)이면 다시 위반으로 잡힙니다 — 규정 해석이 바뀌었을 때 쓰는 기능입니다. 잘못 눌렀으면 「↶ 되돌리기」.'), { 0: count }),
      )
    )
      return;
    const done = await run(() => api.revertRelocations(packageId));
    if (!done) return;
    setNotice(fill(tr('원본 IRI로 되돌렸습니다: {0}건.'), { 0: done.reverted.length }));
    await loadPackage(packageId);
  };
  return { onUndo, onRedo, onFix, onApplyFix, onRevertLedger };
}
