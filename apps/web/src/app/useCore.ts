/**
 * Core — the run frame (run: busy indicator · error classification) · reading a file · first load · back to the start screen · choosing the file to save to · jumping to a finding.
 * Split out of App.tsx (2026-10-13 componentization) — code and comments are verbatim from before the move;
 * the state and actions it uses arrive under the same names (taken from c).
 */
import { useCallback, useEffect } from 'react';
import { api, ConflictError, currentToken, type AuthState, UnauthorizedError } from '../api.js';
import { revealPath, type Finding, type TreeNode } from '../model.js';

import type { Model } from './context.js';
import { describeError } from './describeError.js';

export function useCore(c: Pick<Model, 'expanded' | 'linkedRevisions' | 'openedRef' | 'packageId' | 'revisions' | 'roots' | 'setAdding' | 'setAuth' | 'setAutoCollect' | 'setBusy' | 'setConcepts' | 'setConflict' | 'setError' | 'setExpanded' | 'setFilesOpen' | 'setFindings' | 'setFixCount' | 'setFixReport' | 'setHierAdder' | 'setHierarchy' | 'setHistoryFor' | 'setInterfaces' | 'setLastCycle' | 'setLedger' | 'setLinked' | 'setLive' | 'setNeedsToken' | 'setNotice' | 'setOpcua' | 'setPackageId' | 'setPackages' | 'setPolicy' | 'setRequirements' | 'setReveal' | 'setRevisions' | 'setSelectedKey' | 'setShellRevisions' | 'setShells' | 'setSubmodelTarget' | 'setSubmodels' | 'setUndoState' | 'setUnfixable' | 'setValues' | 'setVersion'>) {
  const { expanded, linkedRevisions, openedRef, packageId, revisions, roots, setAdding, setAuth, setAutoCollect, setBusy, setConcepts, setConflict, setError, setExpanded, setFilesOpen, setFindings, setFixCount, setFixReport, setHierAdder, setHierarchy, setHistoryFor, setInterfaces, setLastCycle, setLedger, setLinked, setLive, setNeedsToken, setNotice, setOpcua, setPackageId, setPackages, setPolicy, setRequirements, setReveal, setRevisions, setSelectedKey, setShellRevisions, setShells, setSubmodelTarget, setSubmodels, setUndoState, setUnfixable, setValues, setVersion } = c;
  const run = useCallback(async <T,>(work: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(undefined);
    try {
      return await work();
    } catch (caught) {
      // A conflict is a situation, not an error — say that nothing was overwritten and offer a way to reload
      if (caught instanceof ConflictError) setConflict(caught.message);
      // Token missing or wrong — show the input field instead of an error message
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
          // Preview without saving — separates what will actually be fixed from what cannot (the basis of the button count)
          api.fixPreview(id).catch(() => undefined),
        ]);
        const cannot = new Set((preview?.skipped ?? []).map((s) => `${s.ruleId}|${s.pointer}`));
        setUnfixable(cannot.size);
        setFixCount(preview?.applied.length);
        // Queries work even on deployments without a collection adapter (an empty time series means 0 entries)
        setLive(await api.liveMapping(id).catch(() => undefined));
        // Important: a file without a hierarchy submodel returns 400 — that is not a fault, the file is just like that
        setHierarchy(await api.hierarchy(id).catch(() => undefined));
        setAutoCollect(await api.collectStatus().catch(() => undefined));
        setOpcua(await api.opcuaStatus().catch(() => undefined));
        setLedger(await api.relocations(id).then((r) => r.relocations).catch(() => ({})));
        // Template requirement levels — empty when there is no template or it fails (the value table shows "unknown")
        setRequirements(
          await api
            .requirements(id)
            .then((r) => Object.fromEntries(r.result.map((entry) => [entry.submodelId, entry])))
            .catch(() => ({})),
        );
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
        // Important: never keep showing another file's collection results — the interface names are the same
        // (both InterfaceTemplateForOPCUA), so someone else's state looks like ours.
        // A functional update runs later, by which time openedRef already holds the new value — compare right now
        if (openedRef.current !== id) {
          setLastCycle(undefined);
          setFixReport(undefined);
          setHierAdder(undefined);
          setSubmodelTarget(undefined);
          // Important: if the previous file's selection lingers, the summary/composition view does not show for the new file
          //    and there is no visible reason (measured during a design review) — clear the selection when the file changes
          setSelectedKey(undefined);
        }
        setPackageId(id);
        // Re-reading the same file (after a save or an add) keeps the expansion state.
        // If the tree collapsed on every edit, deep elements could not be worked on
        // AAS and submodels start expanded. A collapsed tree hides what is there.
        // (Under an AAS there is only AssetInformation, so expanding it is not cluttered)
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
  /** Start screen — read the file list and open the first file. Called again after a token is entered */
  const bootstrap = useCallback(async () => {
    // Important: login state comes first. If not logged in there is no reason to request the list,
    //    and requesting it yields a 401 that looks like an "error"
    const state = await api.authMe().catch(
      (): AuthState => ({ authenticated: false, setupNeeded: false, authRequired: false }),
    );
    setAuth(state);
    if (state.authRequired && !state.authenticated && currentToken() === undefined) return;
    await run(async () => {
      const list = await api.listPackages();
      setPackages(list.result);
      if (list.result[0]) await loadPackage(list.result[0].packageId);
      // The conventions are needed even with no files — the start screen's "Create new" uses them
      else setPolicy(await api.globalPolicy());
    });
  }, [run, loadPackage]);

  useEffect(() => {
    void bootstrap();
    // The version number is readable without auth (/health) — it shows on screen even before a token is entered
    void fetch('/health')
      .then((response) => response.json())
      .then((body: { version?: string }) => setVersion(body.version))
      .catch(() => undefined);
  }, [bootstrap]);
  /**
   * Removes a file from the list.
   *
   * Important: before removing, check **whether another process points at this equipment**. A process points at
   *    equipment only through one string, globalAssetId, so removing the equipment leaves the process file looking fine —
   *    the broken link shows nowhere on screen. So we warn before removing.
   */
  /**
   * Back to the start screen — clicking the logo returns there (web convention, user request 2026-08-26).
   * Files stay as they are; only the current view is dropped — picking a file again resumes work.
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
    // Expand the whole path to the element the finding points at — collapsed nodes are not visible
    const path = revealPath(roots, finding.pointer);
    if (path.target === undefined) return; // a finding with no place in the tree (should not happen, but defend)
    setExpanded(new Set([...expanded, ...path.keys]));
    setReveal(path.target);
    setSelectedKey(path.target);
  };
  /**
   * The file to save this node to — for a ⚙ branch (an element from another file) **that file is the source**, so write there.
   * Important: principle set when lifting view-only mode: the screen may splice files together, but saves always go to the source file.
   *    Use that file's revision too — dropping conflict protection because it is another file is not allowed.
   */
  const targetOf = (node: TreeNode): { pid: string; revision: number | undefined } =>
    node.linkedPackageId !== undefined
      ? {
          pid: node.linkedPackageId,
          revision: linkedRevisions[node.linkedPackageId]?.[node.submodelId],
        }
      : { pid: packageId!, revision: revisions[node.submodelId] };

  /**
   * valueType change — replace the whole element (PUT). The type cannot be changed via the $value path.
   * Important: if not chosen when adding, it is fixed as xs:string with no way to change it (confirmed in real-use testing).
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
