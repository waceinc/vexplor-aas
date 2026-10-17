/**
 * Collection actions — collect now · connect a virtual PLC · per-equipment connect/collect on the process screen · delete collection links.
 * Split out of App.tsx (componentization, 2026-10-13) — the code is verbatim from before the move,
 * and the state and actions it uses arrive under the same names (taken from c).
 */
import { useEffect } from 'react';
import { api } from '../api.js';
import { fill, tr } from '../i18n.js';
import type { Core } from './context.js';

export function useCollectionActions(c: Pick<Core, 'equipmentName' | 'loadPackage' | 'packageId' | 'run' | 'setAdding' | 'setLastCycle' | 'setNotice' | 'setValues' | 'shell' | 'submodels'>) {
  const { equipmentName, loadPackage, packageId, run, setAdding, setLastCycle, setNotice, setValues, shell, submodels } = c;
  /*
   * Values that arrive without anyone pressing "Collect" — a remote collector (VEXPLOR Edge) or the server's automatic
   * collection — show up on their own: while a file with a collection link is open, its values are read every 10 s.
   */
  const hasAid = submodels.some((submodel) => submodel.idShort === 'AssetInterfacesDescription');
  useEffect(() => {
    if (!packageId || !hasAid) return;
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      void api.values(packageId).then((samples) => setValues(samples.result), () => undefined);
    }, 10_000);
    return () => window.clearInterval(timer);
  }, [packageId, hasAid, setValues]);
  /**
   * Delete a collection link (AID) — when it was created by mistake or is no longer used.
   * Deletes the submodel together with the AAS reference. Important: already collected values (time series) remain —
   * this cuts the link, it does not destroy the record.
   *
   * Important: also, **items created in the model via "Create slots too" are not deleted.** They are now
   *    part of the model, and a person may have filled in values, so it is not ours to decide to destroy them.
   *    But **this must be stated in the confirmation prompt** — otherwise users assume everything was deleted.
   */
  const onDeleteAid = async (): Promise<void> => {
    if (!packageId) return;
    const aid = submodels.find((submodel) => submodel.idShort === 'AssetInterfacesDescription');
    if (!aid) return;
    if (
      !globalThis.confirm(
        tr('수집 연결(AID)을 지웁니다.\n\n') +
          tr('· 이미 수집한 값(시계열)은 남습니다.\n') +
          tr('· 「자리도 함께 만들기」로 OperationalData에 세운 항목도 남습니다 —\n') +
          tr('  필요 없으면 트리에서 직접 지우십시오.\n\n계속할까요?'),
      )
    )
      return;
    const done = await run(async () => {
      await api.deleteSubmodel(packageId, aid.id);
      if (shell) await api.removeSubmodelRef(packageId, shell.id, aid.id).catch(() => undefined);
      return true;
    });
    if (done) {
      setNotice(tr('수집 연결을 지웠습니다.'));
      await loadPackage(packageId);
    }
  };
  /** Collect once now (M8). Does not touch the model */
  const onCollect = async (): Promise<void> => {
    if (!packageId) return;
    const cycle = await run(() => api.collect(packageId));
    if (!cycle) return;
    setLastCycle(cycle);
    const failed = cycle.interfaces.filter((entry) => entry.error).length;
    const badTags = cycle.interfaces.reduce(
      (sum, entry) => sum + (entry.report?.failures.length ?? 0),
      0,
    );
    setNotice(
      fill(tr('수집 {0}건'), { 0: cycle.collected }) +
        (failed > 0 ? fill(tr(' · 접속 실패 {0}건'), { 0: failed }) : '') +
        (badTags > 0 ? fill(tr(' · 나쁜 태그 {0}건'), { 0: badTags }) : ''),
    );
    const samples = await api.values(packageId).catch(() => undefined);
    if (samples) setValues(samples.result);
  };
  /**
   * Connect to a virtual PLC — the way for someone with only the installed edition to reproduce a bundle (2026-09-30).
   * Important: a collection link (AID) is added to the file — a submission model becomes a demo copy. Hence the confirmation
   */
  const onSimulate = async (): Promise<void> => {
    if (!packageId) return;
    if (
      !globalThis.confirm(
        tr('이 설비 파일에 가상 PLC(시뮬레이션) 수집 연결을 만듭니다.\n\n') +
          tr('· 파일에 AID 서브모델이 더해져 「시연본」이 됩니다.\n') +
          tr('· 원본 참조모델을 그대로 두려면, 먼저 「호기별로 나누기」로 호기를 만들어 거기서 하십시오.\n\n계속할까요?'),
      )
    )
      return;
    const result = await run(() => api.simulate(packageId));
    if (!result) return;
    await loadPackage(packageId);
    setNotice(fill(tr('{0}에 연결했습니다 — 태그 {1}개. 한 번 수집합니다.'), { 0: result.title, 1: result.tags }));
    await onCollect();
  };
  /** On the process screen, attach one equipment to a virtual PLC and collect once — stays on the process screen */
  const onSimulateEquipment = async (pid: string): Promise<void> => {
    if (!packageId) return;
    if (
      !globalThis.confirm(
        fill(tr('「{0}」에 가상 PLC(시뮬레이션) 수집 연결을 만듭니다.\n\n'), { 0: equipmentName(pid) }) +
          tr('· 그 설비 파일에 AID 서브모델이 더해져 「시연본」이 됩니다.\n') +
          tr('· 원본 참조모델이면 먼저 「호기별로 나누기」로 호기를 만들어 거기서 하십시오.\n\n계속할까요?'),
      )
    )
      return;
    const result = await run(() => api.simulate(pid));
    if (!result) return;
    const cycle = await run(() => api.collect(pid));
    setNotice(fill(tr('「{0}」 {1}에 연결 — 태그 {2}개{3}'), { 0: equipmentName(pid), 1: result.title, 2: result.tags, 3: cycle ? fill(tr(' · 수집 {0}건'), { 0: cycle.collected }) : '' }));
    await loadPackage(packageId); // Redraw the connection status
  };
  const onCollectEquipment = async (pid: string): Promise<void> => {
    const cycle = await run(() => api.collect(pid));
    if (!cycle) return;
    const failed = cycle.interfaces.filter((entry) => entry.error).length;
    setNotice(fill(tr('「{0}」 수집 {1}건{2}'), { 0: equipmentName(pid), 1: cycle.collected, 2: failed > 0 ? fill(tr(' · 접속 실패 {0}건'), { 0: failed }) : '' }));
  };
  /** On-site PLC — open that equipment file and show the "Create collection link" dialog right away (address and tags are entered there) */
  const onConnectEquipment = async (pid: string): Promise<void> => {
    await loadPackage(pid);
    setAdding('aid');
  };
  return { onDeleteAid, onCollect, onSimulate, onSimulateEquipment, onCollectEquipment, onConnectEquipment };
}
