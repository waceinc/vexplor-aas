/**
 * 수집 동작 — 지금 수집 · 가상 PLC 연결 · 공정 화면의 설비별 연결·수집 · 수집 연결 지우기.
 * App.tsx 에서 떼어 냈다(2026-10-13 컴포넌트화) — 코드와 주석은 옮기기 전 글자 그대로이고,
 * 쓰는 상태·동작은 같은 이름으로 받는다(c 에서 꺼낸다).
 */
import { api } from '../api.js';
import { fill, tr } from '../i18n.js';
import type { Core } from './context.js';

export function useCollectionActions(c: Pick<Core, 'equipmentName' | 'loadPackage' | 'packageId' | 'run' | 'setAdding' | 'setLastCycle' | 'setNotice' | 'setValues' | 'shell' | 'submodels'>) {
  const { equipmentName, loadPackage, packageId, run, setAdding, setLastCycle, setNotice, setValues, shell, submodels } = c;
  /**
   * 수집 연결(AID) 지우기 — 연결을 잘못 만들었거나 더 안 쓸 때.
   * 서브모델과 AAS의 참조를 함께 지운다. 🔴 이미 쌓인 수집값(시계열)은 남는다 —
   * 연결을 끊는 것이지 기록을 태우는 게 아니다.
   *
   * 🔴 그리고 「자리도 함께 만들기」로 **모델에 세운 항목은 지우지 않는다.** 그건 이제
   *    모델의 일부이고, 사람이 값을 채웠을 수도 있어 우리가 판단해 태울 것이 아니다.
   *    다만 **그 사실을 묻는 자리에서 말해야 한다** — 안 그러면 다 지워진 줄 안다.
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
  /** 지금 한 번 수집한다(M8). 모델은 건드리지 않는다 */
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
   * 가상 PLC로 연결 — 설치판만 가진 사람이 번들을 재현하는 길(2026-09-30).
   * 🔴 파일에 수집 연결(AID)이 더해진다 — 제출 모델이면 시연본이 된다. 그래서 확인받는다
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
  /** 공정 화면에서 설비 하나를 가상 PLC에 붙이고 한 번 수집한다 — 공정 화면에 그대로 머문다 */
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
    await loadPackage(packageId); // 연결 상태를 다시 그린다
  };
  const onCollectEquipment = async (pid: string): Promise<void> => {
    const cycle = await run(() => api.collect(pid));
    if (!cycle) return;
    const failed = cycle.interfaces.filter((entry) => entry.error).length;
    setNotice(fill(tr('「{0}」 수집 {1}건{2}'), { 0: equipmentName(pid), 1: cycle.collected, 2: failed > 0 ? fill(tr(' · 접속 실패 {0}건'), { 0: failed }) : '' }));
  };
  /** 현장 PLC — 그 설비 파일을 열고 「수집 연결 만들기」 창을 바로 띄운다(주소·태그 입력은 거기서) */
  const onConnectEquipment = async (pid: string): Promise<void> => {
    await loadPackage(pid);
    setAdding('aid');
  };
  return { onDeleteAid, onCollect, onSimulate, onSimulateEquipment, onCollectEquipment, onConnectEquipment };
}
