/**
 * What is it made of — editing the composition after creation. This is the **immediate-save mode** of `HierarchyTree`.
 *
 * Important: why this screen exists: a process file **does not hold equipment details inside itself.**
 * It only points to the equipment file through one string, `globalAssetId`; having people copy that string by hand
 * is where typos come from. So **just picking an uploaded equipment file** lets the server read the name and address from that file.
 *
 * The hierarchy is IDTA 02011 (HierarchicalStructures), and equipment files describe their own parts with the same grammar
 * (roll forming machine → Uncoiler · RollStandUnit · CutOffPress). So any file with a hierarchy, process or equipment, is handled the same way.
 *
 * Important: it uses **the same tree editor** as creation (NewPackage) — the after-creation screen used to have a different shape
 *    ("Slot to add · Add here · Type directly · Make group"), so beginners learned it twice (2026-09-08, unified after expert review).
 *    Here each row calls the API immediately, and the server does the validation (duplicates, cycles, names).
 */
import { useState } from 'react';
import type { HierarchyNode, HierarchyView, PackageDescription } from '../api.js';
import type { Submodel } from '../model.js';
import { HierarchyTree, type Adder, type DraftNode } from './HierarchyTree.js';
import { tr } from '../i18n.js';
import { T } from './T.js';

interface Props {
  view: HierarchyView;
  /** Is this one machine (part composition) or a process / company (equipment layout) — titles and descriptions differ */
  unit: 'equipment' | 'composite';
  /** The open input row — also opened by the tree's ▦ click and the summary's "+ …", so the outside (App) holds it */
  adder?: Adder;
  onAdderChange: (adder?: Adder) => void;
  /** Candidates that can be added — everything except the currently open file */
  candidates: PackageDescription[];
  /** Upload a .aasx from a PC folder and add it in place — must be the same gesture as at creation (NewPackage) */
  onImportFile?: (file: File) => Promise<string | undefined>;
  busy: boolean;
  /** Own IRI root — used to build the Asset address of equipment entered by name only */
  iriBase?: string;
  onAdd: (sourcePackageId: string, bulkCount: number, parentPath: string[]) => void;
  /** Add split per unit — separate files name_1…name_n instead of ×n */
  onAddSplit: (sourcePackageId: string, count: number, parentPath: string[]) => void;
  onAddManual: (name: string, globalAssetId: string, bulkCount: number, parentPath: string[]) => void;
  onAddGroup: (name: string, parentPath: string[], line?: boolean) => void;
  onRemove: (name: string, parentPath: string[]) => void;
  /** ㉯ Expand a child equipment's submodels in place — the file structure stays reference-based; they are joined only on screen */
  fetchSubmodels: (packageId: string) => Promise<Submodel[]>;
  onOpen: (packageId: string) => void;
  /** Translator — returns the Korean as is when the dictionary has no entry (i18n.ts) */
  t: (text: string) => string;
}

export function Hierarchy({
  view,
  unit,
  adder,
  onAdderChange,
  candidates,
  onImportFile,
  busy,
  iriBase,
  onAdd,
  onAddSplit,
  onAddManual,
  onAddGroup,
  onRemove,
  fetchSubmodels,
  onOpen,
  t,
}: Props): React.JSX.Element {
  /** Expanded equipment (path key) → loaded submodel list (undefined = loading). The same name can appear under two processes, so the key is the path */
  const [opened, setOpened] = useState<Record<string, Submodel[] | undefined>>({});

  if (!view.entryNode) {
    return (
      <div className="hierarchy">
        <p className="hint">{t('계층 구조가 비어 있습니다.')}</p>
      </div>
    );
  }

  const base = iriBase ?? 'https://www.smart-factory.kr/ids';
  const packageOf = (globalAssetId: string): PackageDescription | undefined =>
    candidates.find((item) => item.globalAssetId === globalAssetId);

  /** Server hierarchy → tree-editor node. Groups come down with an empty-string address (transport representation) */
  const toDraft = (list: HierarchyNode[]): DraftNode[] =>
    list.map((node) => {
      if (node.globalAssetId === '') {
        return { name: node.name, kind: 'group', ...(node.line ? { line: true } : {}), count: 1, split: false, children: toDraft(node.children) };
      }
      const source = packageOf(node.globalAssetId);
      const kind: DraftNode['kind'] = source
        ? 'file'
        : node.globalAssetId === `${base}/asset/${node.name}/1/0`
          ? 'planned'
          : 'unopened';
      return {
        name: node.name,
        kind,
        ...(source ? { packageId: source.packageId, fileName: source.name ?? source.packageId } : {}),
        count: node.bulkCount,
        split: false,
        children: toDraft(node.children),
      };
    });

  const toggle = (key: string, packageId: string): void => {
    if (key in opened) {
      setOpened((current) => {
        const next = { ...current };
        delete next[key];
        return next;
      });
      return;
    }
    setOpened((current) => ({ ...current, [key]: undefined }));
    void fetchSubmodels(packageId).then((submodels) =>
      setOpened((current) => (key in current ? { ...current, [key]: submodels } : current)),
    );
  };

  return (
    <div className="hierarchy">
      <h3>{unit === 'equipment' ? t('부품 구성 (BoM)') : t('공정·설비 구성')}</h3>
      {/* People asked "what is this, and is it in the file?" (2026-09-08) — the source is stated on the first line */}
      <p className="hint">
        {unit === 'equipment'
          ? t('이 설비를 이루는 부품입니다 — 이 파일의 HierarchicalStructures 서브모델(IDTA 02011)에 저장됩니다.')
          : tr('회사 → (라인 →) 공정 → 설비를 한 트리로 그립니다 — 이 파일의 HierarchicalStructures 서브모델(IDTA 02011)에 저장되고, 왼쪽 트리 맨 위 ⚙·▦ 줄로도 보입니다. 회사 줄의 「＋ 공정」으로 공정을(라인이 필요하면 「＋ 라인」 다음 그 줄의 「＋ 공정」으로) 만들고, 그 공정 줄의 「＋ 설비」로 설비를 넣습니다(올려 둔 파일에서 고르거나 「PC에서 가져오기」로 이 PC 폴더의 .aasx를 바로 올립니다).')}
      </p>
      <HierarchyTree
        t={t}
        unit={unit}
        rootName={view.entryNode.name}
        rootLabel={unit === 'equipment' ? t('설비') : t('회사·묶음')}
        rootAssetId={view.entryNode.globalAssetId}
        nodes={toDraft(view.children)}
        candidates={candidates}
        {...(onImportFile ? { onImportFile } : {})}
        busy={busy}
        {...(adder ? { adder } : {})}
        onAdderChange={onAdderChange}
        onAddGroup={(parentPath, name, line) => onAddGroup(name, parentPath, line)}
        onAddFile={(parentPath, packageId, count, split) =>
          split && count > 1 ? onAddSplit(packageId, count, parentPath) : onAdd(packageId, count, parentPath)
        }
        onAddPlanned={(parentPath, name) => onAddManual(name, `${base}/asset/${name}/1/0`, 1, parentPath)}
        onRemove={(path) => onRemove(path[path.length - 1]!, path.slice(0, -1))}
        emptyHint={tr('아직 아무것도 들어 있지 않습니다 — 위 줄의 「＋ 공정」 또는 「＋ 설비」로 넣습니다.')}
        leafExtra={(node, path) => {
          if (node.kind !== 'file' || !node.packageId) return null;
          const key = path.join('/');
          const isOpen = key in opened;
          const detail = opened[key];
          return (
            <>
              <button
                type="button"
                className="link hier-toggle"
                title={t('서브모델 펼쳐 보기')}
                disabled={busy}
                onClick={() => toggle(key, node.packageId!)}
              >
                {isOpen ? '▾' : '▸'}
              </button>
              {isOpen && (
                <div className="hier-detail">
                  {detail === undefined ? (
                    <p className="hint">{t('읽는 중…')}</p>
                  ) : (
                    <>
                      <ul className="hier-sublist">
                        {detail.map((submodel) => (
                          <li key={submodel.id}>
                            <span>{submodel.idShort ?? submodel.id}</span>
                            <span className="dim"><T k={'요소 {0}개'} v={[submodel.submodelElements?.length ?? 0]} /></span>
                          </li>
                        ))}
                      </ul>
                      <button
                        type="button"
                        className="link"
                        title={tr('이 설비 파일을 엽니다 — 지금 보는 파일 대신 그 파일로 바뀝니다')}
                        onClick={() => onOpen(node.packageId!)}
                      >
                        {tr('이 설비 파일 열기 →')}
                      </button>
                    </>
                  )}
                </div>
              )}
            </>
          );
        }}
      />
    </div>
  );
}
