/**
 * File actions — upload · open bundle · sample · import for tree · remove (link warning) · create new · download.
 * Split out of App.tsx (2026-10-13 componentization) — code and comments are verbatim from before the move;
 * the state and actions it uses arrive under the same names (taken from c).
 */
import { api, type HierarchyNode } from '../api.js';
import { type DraftNode } from '../components/HierarchyTree.js';
import { fill, tr } from '../i18n.js';
import type { Core } from './context.js';

export function useFileActions(c: Pick<Core, 'demoLocked' | 'errors' | 'loadPackage' | 'markStart' | 'openedRef' | 'packageId' | 'packages' | 'policy' | 'run' | 'setAdding' | 'setConcepts' | 'setFindings' | 'setFixReport' | 'setHierarchy' | 'setNotice' | 'setPackageId' | 'setPackages' | 'setPickedFiles' | 'setSampleLocked' | 'setShells' | 'setSubmodels'>) {
  const { demoLocked, errors, loadPackage, markStart, openedRef, packageId, packages, policy, run, setAdding, setConcepts, setFindings, setFixReport, setHierarchy, setNotice, setPackageId, setPackages, setPickedFiles, setSampleLocked, setShells, setSubmodels } = c;
  const onUpload = async (file: File): Promise<void> => {
    // If the same name already exists, say so — but do not block (one may view different versions side by side).
    // Without the notice, same-named files pile up in the list and nobody can tell them apart (measured in a 3-expert demo)
    const duplicate = packages.some((item) => item.name === file.name);
    const created = await run(() => api.upload(file));
    if (!created) return;
    const list = await api.listPackages();
    setPackages(list.result);
    setFixReport(undefined);
    const warnings = [...(created.warnings ?? [])];
    if (duplicate) {
      warnings.push(
        tr('같은 이름의 파일이 이미 열려 있습니다 — 둘 다 유지됩니다. 정리하려면 「파일 목록」에서 지우십시오.'),
      );
    }
    // Pass on what the server noticed while reading the file (it was an XML version, etc.) — never skip it silently
    if (warnings.length > 0) setNotice(warnings.join(' · '));
    await loadPackage(created.packageId);
  };
  /**
   * Open a reference bundle — one ZIP uploads the process and its equipment together.
   * Important: if a hash differs from the manifest, report it rather than hide it. It means "a file changed after the bundle was made".
   */
  const onOpenBundle = async (file: File): Promise<void> => {
    const opened = await run(() => api.openBundle(file));
    if (!opened) return;
    const list = await api.listPackages();
    setPackages(list.result);
    setFixReport(undefined);
    const fresh = opened.files.filter((f) => !f.reused).length;
    const verified = opened.files.filter((f) => f.hashOk === true).length;
    const head = fill(tr('번들 {0} v{1} — 파일 {2}개(새로 {3}) · 해시 일치 {4}/{5}'), { 0: opened.bundle.code ?? '', 1: opened.bundle.version ?? '?', 2: opened.files.length, 3: fresh, 4: verified, 5: opened.files.length });
    setNotice(opened.problems.length > 0 ? `${head} · ⚠ ${opened.problems.join(' · ')}` : head);
    if (opened.processPackageId) await loadPackage(opened.processPackageId);
  };
  /**
   * Start from a sample — the first step for someone with no AASX at all.
   *
   * Important: for a newcomer, "Open AASX file" is a dead end — there is no file to open. "Create new" gives
   *    six empty submodels, so it is unclear what to fill in. Show a filled-in sample first.
   *    Opens the static files shipped with the screen (public/samples — scripts/make-samples.mjs) as a bundle.
   *    Clicking the same sample again, bundle opening recognizes it by hash and makes no copy.
   */
  const onOpenSample = async (): Promise<void> => {
    // Demo accounts do not open the sample — instead of asking for a token, point them to sign-up
    if (demoLocked) {
      setSampleLocked(true);
      return;
    }
    const name = 'RB01_OptimizationQuality_sample_bundle.zip';
    const data = await run(async () => {
      const response = await fetch(`${import.meta.env.BASE_URL}samples/${name}`);
      if (!response.ok) throw new Error(fill(tr('견본 파일을 받지 못했습니다 ({0}).'), { 0: response.status }));
      return response.blob();
    });
    if (!data) return;
    await onOpenBundle(new File([data], name, { type: 'application/zip' }));
    setNotice(
      tr('견본을 열었습니다 — 공정 구성(RB01)과 설비 1종(RollFormingMachine_sample ×2). 설비 줄을 누르면 그 설비 파일이 열립니다.'),
    );
  };
  /**
   * The composition tree's "Import from PC" — upload only, and **leave the screen as it is**.
   *
   * Important: why this is separate from `onUpload`: that one opens the uploaded file immediately (loadPackage). Doing that
   *    while building a tree would wipe the draft from the screen. Here we only re-read the list into the candidates;
   *    putting it into the selected state is the tree editor's job.
   */
  const onImportForTree = async (file: File): Promise<string | undefined> => {
    const created = await run(() => api.upload(file));
    if (!created) return undefined; // run() has already shown the failure message
    const list = await api.listPackages();
    setPackages(list.result);
    const warnings = created.warnings ?? [];
    if (warnings.length > 0) setNotice(warnings.join(' · '));
    return created.packageId;
  };
  /**
   * Removes files from the list — one or many through a single path (checkbox bulk removal, user 2026-09-09).
   * Important: files being removed together do not count as "pointed at" — removing a process with its equipment at once is normal.
   *    References are checked below the process level too (before, only the top level was checked and equipment under a level was missed).
   */
  const deletePackages = async (ids: readonly string[]): Promise<void> => {
    const gone = new Set(ids);
    const targets = packages.filter((item) => gone.has(item.packageId));
    if (targets.length === 0) return;

    const mentions = (nodes: readonly HierarchyNode[], assetId: string): boolean =>
      nodes.some((child) => child.globalAssetId === assetId || mentions(child.children, assetId));
    const warnings: string[] = [];
    for (const target of targets) {
      if (!target.globalAssetId) continue;
      const users: string[] = [];
      for (const other of packages) {
        if (gone.has(other.packageId)) continue;
        try {
          const view = await api.hierarchy(other.packageId);
          if (mentions(view.children, target.globalAssetId)) {
            users.push(other.assetName ?? other.name ?? other.packageId);
          }
        } catch {
          // A file without a hierarchy — it cannot point at anything, so skip it
        }
      }
      if (users.length > 0) {
        warnings.push(fill(tr('{0}: {1}이(가) 가리키고 있습니다'), { 0: target.assetName ?? target.name ?? target.packageId, 1: users.join(' · ') }));
      }
    }

    /*
     * External ERP / MES numbers kept next to the file (integration design §4.5). Deleting the file deletes them, and the
     * integration side receives "equipment removed" — the ERP may retire that equipment, so the person is told first.
     * Important: a server without integration routes answers 404 — then there is nothing to warn about.
     */
    for (const target of targets) {
      try {
        const refs = await api.integration.externalRefs(target.packageId);
        const count = refs.value.subjects.reduce((sum, subject) => sum + subject.refs.length, 0);
        if (count > 0) {
          warnings.push(fill(tr('{0}: ERP · MES 외부 번호 {1}개가 함께 지워지고, 연동된 시스템에는 「설비 없어짐」이 전해집니다'), { 0: target.assetName ?? target.name ?? target.packageId, 1: count }));
        }
      } catch {
        // No integration on this server, or no permission to read the numbers — the delete itself is unchanged
      }
    }

    const labels = targets.map((item) => `「${item.name ?? item.packageId}」`);
    const head =
      targets.length === 1
        ? fill(tr('{0}을(를) 목록에서 지웁니다.'), { 0: labels[0] })
        : fill(tr('파일 {0}건을 목록에서 지웁니다:\n{1}\n'), { 0: targets.length, 1: labels.join('\n') });
    const warning = warnings.length > 0 ? fill(tr('\n\n주의: {0}. 지우면 그 연결이 끊어집니다.'), { 0: warnings.join('\n') }) : '';
    if (!window.confirm(fill(tr('{0} 되돌릴 수 없습니다.{1}'), { 0: head, 1: warning }))) return;

    // Even if one fails, everything before it was removed — always re-read the list
    const done = await run(async () => {
      for (const target of targets) await api.deletePackage(target.packageId);
      return true;
    });
    const list = await api.listPackages();
    setPackages(list.result);
    setPickedFiles(new Set());
    if (!done) return;
    setNotice(targets.length === 1 ? fill(tr('{0}을(를) 지웠습니다.'), { 0: labels[0] }) : fill(tr('파일 {0}건을 지웠습니다.'), { 0: targets.length }));
    // If the file being viewed survives, leave it as is
    if (!packageId || !gone.has(packageId)) return;
    const next = list.result[0];
    if (next) {
      await loadPackage(next.packageId);
    } else {
      // Nothing left — return to the start screen
      setPackageId(undefined);
      setSubmodels([]);
      setShells([]);
      setConcepts([]);
      setFindings([]);
      setHierarchy(undefined);
      openedRef.current = undefined;
    }
  };
  const onDeletePackage = (targetId?: string): Promise<void> => {
    const wanted = targetId ?? packageId;
    return wanted ? deletePackages([wanted]) : Promise.resolve();
  };
  /**
   * Create new (one piece of equipment or a process) — the server builds the skeleton (conventions live only in the linter policy).
   * It must have zero rule violations right after creation.
   */
  const onCreatePackage = async (
    assetName: string,
    extraSubmodels: string[],
    unit: 'equipment' | 'composite' = 'equipment',
    tree: DraftNode[] = [],
  ): Promise<void> => {
    const created = await run(async () => {
      const made = await api.createPackage(assetName, extraSubmodels, unit);
      // Important: insert the drawn composition **while creating**. Showing an empty process first stalls at "what now?" —
      //    for a process, its composition is its identity. If one fails the rest still go in, and below we say which did not.
      //    Iterating parents first means nesting (company > process > line > equipment) goes in as is — the server accepts parentPath at any depth
      const failed: string[] = [];
      let total = 0;
      const iri = policy?.iriBase ?? 'https://www.smart-factory.kr/ids';
      const put = async (nodes: DraftNode[], parentPath: string[]): Promise<void> => {
        for (const node of nodes) {
          total += 1;
          const at = parentPath.length > 0 ? { parentPath } : {};
          if (node.kind === 'group') {
            try {
              await api.addHierarchyNode(made.packageId, { name: node.name, group: true, ...(node.line ? { line: true } : {}), ...at });
              await put(node.children, [...parentPath, node.name]);
            } catch {
              failed.push(node.name);
            }
          } else if (node.kind === 'file' && node.packageId) {
            const item = packages.find((p) => p.packageId === node.packageId);
            if (node.split && node.count > 1) {
              // Per unit — instead of ×n, link **a file cloned from the original** (name_1…_n) for each.
              // Inserting an empty node with just a name does not bring the original's submodels along (field report 2026-08-27)
              const base = item?.assetName ?? item?.name?.replace(/\.aasx$/i, '') ?? 'Unit';
              for (let n = 1; n <= node.count; n += 1) {
                const unitName = `${base}_${n}`;
                try {
                  const existing = packages.find((p) => p.assetName === unitName);
                  const clone = existing ?? (await api.clonePackage(node.packageId, unitName));
                  await api.addHierarchyNode(made.packageId, { sourcePackageId: clone.packageId, ...at });
                } catch {
                  failed.push(unitName);
                }
              }
              continue;
            }
            try {
              await api.addHierarchyNode(made.packageId, {
                sourcePackageId: node.packageId,
                ...(node.count > 1 ? { bulkCount: node.count } : {}),
                ...at,
              });
            } catch {
              failed.push(node.name);
            }
          } else {
            // Equipment without a file yet — take only the name and derive the Asset address by convention.
            // Creating an equipment file with the same name later makes the addresses match and the link connects on its own
            try {
              await api.addHierarchyNode(made.packageId, {
                name: node.name,
                globalAssetId: `${iri}/asset/${node.name}/1/0`,
                ...at,
              });
            } catch {
              failed.push(node.name);
            }
          }
        }
      };
      await put(tree, []);
      return { made, failed, total };
    });
    if (!created) return;
    const { failed } = created;
    setAdding(undefined);
    setFixReport(undefined);
    const list = await api.listPackages();
    setPackages(list.result);
    const orgLabel = tr('묶음');
    setNotice(
      unit !== 'equipment'
        ? failed.length > 0
          ? fill(tr('새 {0} 「{1}」을(를) 만들었습니다. 다만 {2}은(는) 넣지 못했습니다 — 아래에서 다시 넣으십시오.'), { 0: orgLabel, 1: assetName, 2: failed.join(' · ') })
          : created.total > 0
            ? fill(tr('새 {0} 「{1}」을(를) {2}건과 함께 만들었습니다.'), { 0: orgLabel, 1: assetName, 2: created.total })
            : fill(tr('새 {0} 「{1}」을(를) 만들었습니다. 아래 구성 트리의 「＋ 공정」「＋ 설비」로 넣으십시오.'), { 0: orgLabel, 1: assetName })
        : fill(tr('새 설비 「{0}」을(를) 만들었습니다. 대표 사진은 임시 그림이니 실제 사진으로 바꾸십시오.'), { 0: assetName }),
    );
    await loadPackage(created.made.packageId);
  };
  /**
   * Important: downloading with violations left fails in the KOSMO Validator. We do not block —
   *    an intermediate save is a download too — but make sure the user knows. When done, say where the file went
   *    (the browser downloaded silently and we got "I clicked and nothing happened" inquiries).
   */
  const onDownload = async (): Promise<void> => {
    if (!packageId) return;
    if (
      errors > 0 &&
      !window.confirm(
        fill(tr('위반 {0}건이 남아 있습니다. 이대로 내려받으면 KOSMO Validator에서 떨어집니다.\n'), { 0: errors }) +
          tr('그래도 내려받을까요? (작업 중 저장이면 괜찮습니다)'),
      )
    )
      return;
    await run(() => api.download(packageId));
    markStart('download');
    setNotice(tr('AASX를 내려받았습니다 — 브라우저의 다운로드 폴더에 있습니다.'));
  };
  return { onUpload, onOpenBundle, onOpenSample, onImportForTree, deletePackages, onDeletePackage, onCreatePackage, onDownload };
}
