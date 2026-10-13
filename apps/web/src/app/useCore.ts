/**
 * 핵심 — 실행 틀(run: 처리 중 표시 · 오류 분류) · 파일 읽기 · 처음 읽기 · 처음 화면으로 · 저장할 파일 고르기 · 지적으로 가기.
 * App.tsx 에서 떼어 냈다(2026-10-13 컴포넌트화) — 코드와 주석은 옮기기 전 글자 그대로이고,
 * 쓰는 상태·동작은 같은 이름으로 받는다(c 에서 꺼낸다).
 */
import { useCallback, useEffect } from 'react';
import { api, ConflictError, currentToken, type AuthState, UnauthorizedError } from '../api.js';
import { revealPath, type Finding, type TreeNode } from '../model.js';

import type { Model } from './context.js';
import { describeError } from './describeError.js';

export function useCore(c: Pick<Model, 'expanded' | 'linkedRevisions' | 'openedRef' | 'packageId' | 'revisions' | 'roots' | 'setAdding' | 'setAuth' | 'setAutoCollect' | 'setBusy' | 'setConcepts' | 'setConflict' | 'setError' | 'setExpanded' | 'setFilesOpen' | 'setFindings' | 'setFixCount' | 'setFixReport' | 'setHierAdder' | 'setHierarchy' | 'setHistoryFor' | 'setInterfaces' | 'setLastCycle' | 'setLedger' | 'setLinked' | 'setLive' | 'setNeedsToken' | 'setNotice' | 'setOpcua' | 'setPackageId' | 'setPackages' | 'setPolicy' | 'setReveal' | 'setRevisions' | 'setSelectedKey' | 'setShellRevisions' | 'setShells' | 'setSubmodelTarget' | 'setSubmodels' | 'setUndoState' | 'setUnfixable' | 'setValues' | 'setVersion'>) {
  const { expanded, linkedRevisions, openedRef, packageId, revisions, roots, setAdding, setAuth, setAutoCollect, setBusy, setConcepts, setConflict, setError, setExpanded, setFilesOpen, setFindings, setFixCount, setFixReport, setHierAdder, setHierarchy, setHistoryFor, setInterfaces, setLastCycle, setLedger, setLinked, setLive, setNeedsToken, setNotice, setOpcua, setPackageId, setPackages, setPolicy, setReveal, setRevisions, setSelectedKey, setShellRevisions, setShells, setSubmodelTarget, setSubmodels, setUndoState, setUnfixable, setValues, setVersion } = c;
  const run = useCallback(async <T,>(work: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(undefined);
    try {
      return await work();
    } catch (caught) {
      // 충돌은 오류가 아니라 상황이다 — 덮어쓰지 않았다는 사실과 함께 다시 읽을 길을 준다
      if (caught instanceof ConflictError) setConflict(caught.message);
      // 토큰이 없거나 틀렸다 — 오류 문구 대신 입력 자리를 준다
      else if (caught instanceof UnauthorizedError) setNeedsToken(caught.message);
      else setError(describeError(caught));
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  const loadPackage = useCallback(
    async (id: string) => {
      await run(async () => {
        const [tree, report, rules, shellList, conceptList, revs, aid, samples, preview] = await Promise.all([
          api.submodels(id),
          api.lint(id),
          api.policy(id),
          api.shells(id),
          api.conceptDescriptions(id),
          api.revisions(id),
          api.interfaces(id),
          api.values(id),
          // 저장 없는 미리보기 — 실제로 고쳐질 것과 못 고칠 것을 가른다(단추 숫자의 근거)
          api.fixPreview(id).catch(() => undefined),
        ]);
        const cannot = new Set((preview?.skipped ?? []).map((s) => `${s.ruleId}|${s.pointer}`));
        setUnfixable(cannot.size);
        setFixCount(preview?.applied.length);
        // 수집 어댑터가 없는 배포에서도 조회는 된다(시계열이 비어 있으면 0건)
        setLive(await api.liveMapping(id).catch(() => undefined));
        // 🔴 계층 서브모델이 없는 파일은 400이 온다 — 그건 잘못이 아니라 그런 파일인 것이다
        setHierarchy(await api.hierarchy(id).catch(() => undefined));
        setAutoCollect(await api.collectStatus().catch(() => undefined));
        setOpcua(await api.opcuaStatus().catch(() => undefined));
        setLedger(await api.relocations(id).then((r) => r.relocations).catch(() => ({})));
        setUndoState(await api.undoStatus(id).catch(() => ({ undo: [], redo: [] })));
        setSubmodels(tree.result);
        setFindings(
          report.findings.map((finding) =>
            finding.fixable && cannot.has(`${finding.ruleId}|${finding.pointer}`) ? { ...finding, fixable: false } : finding,
          ),
        );
        setPolicy(rules);
        setShells(shellList.result);
        setConcepts(conceptList.result);
        setInterfaces(aid.interfaces);
        setValues(samples.result);
        setRevisions(revs.Submodel);
        setShellRevisions(revs.AssetAdministrationShell);
        setConflict(undefined);
        // 🔴 다른 파일의 수집 결과를 이어서 보여 주면 안 된다 — 인터페이스 이름이 같아
        // (둘 다 InterfaceTemplateForOPCUA) 남의 상태가 내 것처럼 보인다.
        // 함수형 갱신은 나중에 돌아 openedRef가 이미 새 값이 된다 — 지금 바로 비교한다
        if (openedRef.current !== id) {
          setLastCycle(undefined);
          setFixReport(undefined);
          setHierAdder(undefined);
          setSubmodelTarget(undefined);
          // 🔴 이전 파일의 선택이 남으면 새 파일에서 요약·구성 화면이 안 보이는데
          //    이유를 알 수 없다(디자인 점검 중 실측) — 파일이 바뀌면 선택도 비운다
          setSelectedKey(undefined);
        }
        setPackageId(id);
        // 같은 파일을 다시 읽는 것(저장·추가 뒤)이면 펼침 상태를 지킨다.
        // 편집할 때마다 트리가 접히면 깊은 요소를 손볼 수 없다
        // AAS와 서브모델은 처음부터 펼쳐 둔다. 접힌 트리는 무엇이 있는지 보이지 않는다.
        // (AAS 아래에는 AssetInformation 하나뿐이라 펼쳐도 어지럽지 않다)
        const defaults = new Set([
          ...shellList.result.map((_, index) => `/assetAdministrationShells/${index}`),
          ...tree.result.map((_, index) => `/submodels/${index}`),
        ]);
        const sameFile = openedRef.current === id;
        openedRef.current = id;
        setExpanded((current) => (sameFile && current.size > 0 ? current : defaults));
      });
    },
    [run],
  );
  /** 첫 화면 — 파일 목록을 읽고 첫 파일을 연다. 토큰을 넣은 뒤에도 이걸 다시 부른다 */
  const bootstrap = useCallback(async () => {
    // 🔴 로그인 상태가 먼저다. 로그인하지 않았으면 목록을 부를 이유가 없고,
    //    부르면 401이 떠서 "오류"처럼 보인다
    const state = await api.authMe().catch(
      (): AuthState => ({ authenticated: false, setupNeeded: false, authRequired: false }),
    );
    setAuth(state);
    if (state.authRequired && !state.authenticated && currentToken() === undefined) return;
    await run(async () => {
      const list = await api.listPackages();
      setPackages(list.result);
      if (list.result[0]) await loadPackage(list.result[0].packageId);
      // 파일이 하나도 없어도 규약은 필요하다 — 첫 화면의 「새로 만들기」가 쓴다
      else setPolicy(await api.globalPolicy());
    });
  }, [run, loadPackage]);

  useEffect(() => {
    void bootstrap();
    // 판 번호는 인증 없이도 읽힌다(/health) — 토큰 넣기 전에도 화면에 보인다
    void fetch('/health')
      .then((response) => response.json())
      .then((body: { version?: string }) => setVersion(body.version))
      .catch(() => undefined);
  }, [bootstrap]);
  /**
   * 목록에서 파일을 지운다.
   *
   * 🔴 지우기 전에 **다른 공정이 이 설비를 가리키고 있는지** 본다. 공정은 globalAssetId라는
   *    끈 하나로 설비를 가리킬 뿐이라, 설비를 지워도 공정 파일은 멀쩡해 보인다 —
   *    끊어진 사실이 화면 어디에도 안 나타난다. 그래서 지우기 전에 알려 준다.
   */
  /**
   * 처음 화면으로 — 로고를 누르면 돌아간다(웹의 관습, 2026-08-26 사용자 요청).
   * 파일은 그대로 두고 보던 것만 내려놓는다 — 다시 고르면 이어서 작업된다.
   */
  const goHome = (): void => {
    setSelectedKey(undefined);
    setAdding(undefined);
    setFilesOpen(false);
    setHistoryFor(undefined);
    setPackageId(undefined);
    setSubmodels([]);
    setShells([]);
    setConcepts([]);
    setFindings([]);
    setHierarchy(undefined);
    setLinked([]);
    setNotice(undefined);
    setFixReport(undefined);
    setError(undefined);
    openedRef.current = undefined;
  };
  const onSelectFinding = (finding: Finding): void => {
    // 지적이 가리키는 요소까지 가는 길을 전부 펼친다 — 접혀 있으면 보이지 않는다
    const path = revealPath(roots, finding.pointer);
    if (path.target === undefined) return; // 트리에 자리가 없는 지적(있으면 안 되지만 방어)
    setExpanded(new Set([...expanded, ...path.keys]));
    setReveal(path.target);
    setSelectedKey(path.target);
  };
  /**
   * 이 노드를 저장할 파일 — ⚙ 가지(다른 파일의 요소)면 **그 파일이 원본**이므로 거기에 쓴다.
   * 🔴 보기 전용을 풀면서 정한 원칙: 화면은 이어 붙였어도 저장은 반드시 원본 파일로 간다.
   *    revision도 그 파일 것을 쓴다 — 남의 파일이라고 충돌 보호를 빼면 안 된다.
   */
  const targetOf = (node: TreeNode): { pid: string; revision: number | undefined } =>
    node.linkedPackageId !== undefined
      ? {
          pid: node.linkedPackageId,
          revision: linkedRevisions[node.linkedPackageId]?.[node.submodelId],
        }
      : { pid: packageId!, revision: revisions[node.submodelId] };

  /**
   * valueType 변경 — 요소 통째 교체(PUT). $value 경로로는 타입을 못 바꾼다.
   * 🔴 추가할 때 안 정하면 xs:string으로 박히는데 바꿀 길이 없었다(실사용 검증에서 확인).
   */
  const onChangeValueType = async (node: TreeNode, valueType: string): Promise<void> => {
    if (!packageId || !node.idShortPath) return;
    const { pid, revision } = targetOf(node);
    const content = { ...(node.node as Record<string, unknown>), valueType };
    const done = await run(async () => {
      await api.putElement(pid, node.submodelId, node.idShortPath!, content, revision);
      return true;
    });
    if (done) await loadPackage(packageId);
  };
  return { run, loadPackage, bootstrap, goHome, onSelectFinding, targetOf, onChangeValueType };
}
