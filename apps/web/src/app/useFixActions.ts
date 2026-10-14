/**
 * 되돌리기 · 다시 하기 · 자동 고치기(미리보기 → 고른 것만 반영, 파일별) · 이관 대장 되돌리기.
 * App.tsx 에서 떼어 냈다(2026-10-13 컴포넌트화) — 코드와 주석은 옮기기 전 글자 그대로이고,
 * 쓰는 상태·동작은 같은 이름으로 받는다(c 에서 꺼낸다).
 */
import { api, type FixReport } from '../api.js';
import { type FixPlan } from '../components/FixPreview.js';
import { fill, tr } from '../i18n.js';
import type { Core } from './context.js';

export function useFixActions(c: Pick<Core, 'ledger' | 'loadPackage' | 'markStart' | 'mounts' | 'packageId' | 'packages' | 'run' | 'setFixPlans' | 'setFixReport' | 'setNotice' | 'undoState'>) {
  const { ledger, loadPackage, markStart, mounts, packageId, packages, run, setFixPlans, setFixReport, setNotice, undoState } = c;
  /**
   * 되돌리기·다시 하기 — "실수했을 때 뒤로가기". 어떤 변경이든(값·삭제·순서·자동 고치기) 서버가
   * 직전 상태를 들고 있어 한 번에 돌아간다. 확인창은 띄우지 않는다 — 되돌리기는 그 자체가 되돌려진다
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
   * 「자동 고치기」 — 바로 고치지 않고 **미리보기 팝업**부터. 무엇이 어떻게 바뀌는지 항목별 전/후를 보여 주고
   * 체크한 것만 반영한다(사용자 2026-09-11 "자체 제작 형식으로 바꿔 버리고 끝이냐").
   */
  const onFix = async (): Promise<void> => {
    if (!packageId) return;
    markStart('fix');
    // 공정(묶음)이면 이어 붙인 설비 파일까지 — 각 파일의 미리보기를 따로 받아 파일별로 보여 준다
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
   * 체크한 것만 반영 — **파일별로 나눠** 각자의 원본에 쓴다.
   * 🔴 한 파일이 실패해도 나머지는 계속한다. 중간에 멈추면 어디까지 갔는지 알 수 없다.
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
  /** 이관 대장의 원본 IRI로 되돌리기 — KOSMO 우선 정책이면 다시 위반으로 잡힌다. 규정 해석이 바뀌었을 때 쓰는 길 */
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
