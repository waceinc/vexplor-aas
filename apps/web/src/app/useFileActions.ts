/**
 * 파일 동작 — 올리기 · 번들 열기 · 견본 · 트리용 가져오기 · 지우기(연결 경고) · 새로 만들기 · 내려받기.
 * App.tsx 에서 떼어 냈다(2026-10-13 컴포넌트화) — 코드와 주석은 옮기기 전 글자 그대로이고,
 * 쓰는 상태·동작은 같은 이름으로 받는다(c 에서 꺼낸다).
 */
import { api, type HierarchyNode } from '../api.js';
import { type DraftNode } from '../components/HierarchyTree.js';
import { fill, tr } from '../i18n.js';
import type { Core } from './context.js';

export function useFileActions(c: Pick<Core, 'demoLocked' | 'errors' | 'loadPackage' | 'markStart' | 'openedRef' | 'packageId' | 'packages' | 'policy' | 'run' | 'setAdding' | 'setConcepts' | 'setFindings' | 'setFixReport' | 'setHierarchy' | 'setNotice' | 'setPackageId' | 'setPackages' | 'setPickedFiles' | 'setSampleLocked' | 'setShells' | 'setSubmodels'>) {
  const { demoLocked, errors, loadPackage, markStart, openedRef, packageId, packages, policy, run, setAdding, setConcepts, setFindings, setFixReport, setHierarchy, setNotice, setPackageId, setPackages, setPickedFiles, setSampleLocked, setShells, setSubmodels } = c;
  const onUpload = async (file: File): Promise<void> => {
    // 같은 이름이 이미 있으면 알려 준다 — 막지는 않는다(다른 판을 나란히 볼 수도 있다).
    // 안 알리면 목록에 같은 이름이 나란히 쌓여 어느 것이 어느 것인지 모른다(3전문가 시연 실측)
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
    // 파일을 읽으며 서버가 알아챈 것(XML 판이었다 등)을 그대로 전한다 — 조용히 넘기지 않는다
    if (warnings.length > 0) setNotice(warnings.join(' · '));
    await loadPackage(created.packageId);
  };
  /**
   * 레퍼런스 번들 열기 — ZIP 하나로 공정과 설비가 함께 올라온다.
   * 🔴 해시가 manifest와 다르면 숨기지 않고 알린다. 「번들을 만든 뒤 파일이 바뀌었다」는 뜻이다.
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
   * 견본으로 시작하기 — AASX가 한 장도 없는 사람의 첫걸음.
   *
   * 🔴 처음 받은 사람에게 「AASX 파일 열기」는 막다른 길이다 — 열 파일이 없다. 「새로 만들기」는
   *    빈 서브모델 여섯 개라 무엇을 채우는지 보이지 않는다. 다 채운 견본을 먼저 보여 준다.
   *    화면에 함께 실린 정적 파일(public/samples — scripts/make-samples.mjs)을 번들로 연다.
   *    같은 견본을 다시 눌러도 번들 열기가 해시로 알아보고 사본을 만들지 않는다.
   */
  const onOpenSample = async (): Promise<void> => {
    // 데모 계정은 견본을 열지 않는다 — 토큰을 묻는 대신 회원가입을 안내한다
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
   * 구성 트리의 「PC에서 가져오기」 — 올리기만 하고 **화면은 그대로 둔다**.
   *
   * 🔴 `onUpload`와 갈라 둔 이유: 저쪽은 올린 파일을 곧바로 연다(loadPackage). 트리를 짜던
   *    중에 그러면 만들던 초안이 화면에서 사라진다. 여기서는 목록만 새로 읽어 후보에 넣고,
   *    고른 상태로 만드는 일은 트리 편집기가 한다.
   */
  const onImportForTree = async (file: File): Promise<string | undefined> => {
    const created = await run(() => api.upload(file));
    if (!created) return undefined; // 실패 메시지는 run()이 이미 띄웠다
    const list = await api.listPackages();
    setPackages(list.result);
    const warnings = created.warnings ?? [];
    if (warnings.length > 0) setNotice(warnings.join(' · '));
    return created.packageId;
  };
  /**
   * 파일을 목록에서 지운다 — 하나든 여럿이든 한 길(체크 박스 일괄 지우기, 사용자 2026-09-09).
   * 🔴 지우는 것끼리는 "가리키고 있다"로 세지 않는다 — 공정과 그 설비를 한꺼번에 지우는 것이 보통이다.
   *    가리키는 자리는 공정 층 밑까지 본다(전엔 맨 윗단만 봐서 층 밑 설비를 놓쳤다).
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
          // 계층이 없는 파일이다 — 가리킬 수가 없으므로 넘어간다
        }
      }
      if (users.length > 0) {
        warnings.push(fill(tr('{0}: {1}이(가) 가리키고 있습니다'), { 0: target.assetName ?? target.name ?? target.packageId, 1: users.join(' · ') }));
      }
    }

    const labels = targets.map((item) => `「${item.name ?? item.packageId}」`);
    const head =
      targets.length === 1
        ? fill(tr('{0}을(를) 목록에서 지웁니다.'), { 0: labels[0] })
        : fill(tr('파일 {0}건을 목록에서 지웁니다:\n{1}\n'), { 0: targets.length, 1: labels.join('\n') });
    const warning = warnings.length > 0 ? fill(tr('\n\n주의: {0}. 지우면 그 연결이 끊어집니다.'), { 0: warnings.join('\n') }) : '';
    if (!window.confirm(fill(tr('{0} 되돌릴 수 없습니다.{1}'), { 0: head, 1: warning }))) return;

    // 하나가 실패해도 그 앞까지는 지워졌다 — 목록은 반드시 다시 읽는다
    const done = await run(async () => {
      for (const target of targets) await api.deletePackage(target.packageId);
      return true;
    });
    const list = await api.listPackages();
    setPackages(list.result);
    setPickedFiles(new Set());
    if (!done) return;
    setNotice(targets.length === 1 ? fill(tr('{0}을(를) 지웠습니다.'), { 0: labels[0] }) : fill(tr('파일 {0}건을 지웠습니다.'), { 0: targets.length }));
    // 보던 파일이 살아 있으면 그대로 둔다
    if (!packageId || !gone.has(packageId)) return;
    const next = list.result[0];
    if (next) {
      await loadPackage(next.packageId);
    } else {
      // 남은 것이 없다 — 첫 화면으로 돌아간다
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
   * 새로 만들기(설비 한 대 또는 공정) — 뼈대는 서버가 만든다(규약은 린터 정책 한 곳에만 둔다).
   * 만들자마자 규칙 위반 0건이어야 한다.
   */
  const onCreatePackage = async (
    assetName: string,
    extraSubmodels: string[],
    unit: 'equipment' | 'composite' = 'equipment',
    tree: DraftNode[] = [],
  ): Promise<void> => {
    const created = await run(async () => {
      const made = await api.createPackage(assetName, extraSubmodels, unit);
      // 🔴 그린 구성을 **만들면서 바로** 넣는다. 빈 공정을 먼저 보여 주면 "이제 뭘 해야 하나"에서 막힌다 —
      //    공정은 구성이 곧 정체다. 하나가 실패해도 나머지는 넣고, 어느 것이 안 됐는지 아래에서 알려 준다.
      //    부모 먼저 순서로 돌면 중첩(회사>공정>라인>설비)도 그대로 들어간다 — 서버는 어느 깊이든 parentPath를 받는다
      const failed: string[] = [];
      let total = 0;
      const iri = policy?.iriBase ?? 'https://www.smart-factory.kr/ids';
      const put = async (nodes: DraftNode[], parentPath: string[]): Promise<void> => {
        for (const node of nodes) {
          total += 1;
          const at = parentPath.length > 0 ? { parentPath } : {};
          if (node.kind === 'group') {
            try {
              await api.addHierarchyNode(made.packageId, { name: node.name, group: true, ...at });
              await put(node.children, [...parentPath, node.name]);
            } catch {
              failed.push(node.name);
            }
          } else if (node.kind === 'file' && node.packageId) {
            const item = packages.find((p) => p.packageId === node.packageId);
            if (node.split && node.count > 1) {
              // 호기별 — ×n 대신 **원본을 복제한 파일**(이름_1…_n)을 각각 잇는다.
              // 이름만 단 빈 마디를 넣으면 원본의 서브모델이 안 딸려온다(실측 제보 2026-08-27)
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
            // 아직 파일이 없는 설비 — 이름만 받고 Asset 주소는 규약으로 짓는다.
            // 나중에 같은 이름으로 설비 파일을 만들면 주소가 일치해 끈이 저절로 이어진다
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
   * 🔴 위반이 남은 채로 내려받으면 KOSMO Validator에서 떨어진다. 막지는 않는다 —
   *    중간 저장도 내려받기다 — 다만 알고 받게 한다. 끝나면 어디로 갔는지 말해 준다
   *    (브라우저가 조용히 받아 「눌렀는데 아무 일도 없다」는 문의가 있었다).
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
