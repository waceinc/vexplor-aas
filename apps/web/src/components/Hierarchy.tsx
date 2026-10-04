/**
 * 무엇으로 이루어졌나 — 만든 뒤의 구성 편집. `HierarchyTree`의 **즉시 저장 모드**다.
 *
 * 🔴 이 화면이 있는 이유: 공정 파일은 **자기 안에 설비 상세를 담지 않는다.**
 * `globalAssetId`라는 끈 하나로 설비 파일을 가리킬 뿐이라, 그 끈을 손으로 옮겨 적게 하면
 * 거기서 오타가 난다. 그래서 **올려 둔 설비 파일을 고르기만 하면** 이름과 주소를 서버가 그 파일에서 읽는다.
 *
 * 계층은 IDTA 02011(HierarchicalStructures)이고, 설비 파일도 같은 문법으로 자기 부품을
 * 적고 있다(롤포밍기 → Uncoiler · RollStandUnit · CutOffPress). 그래서 공정이든 설비든 계층이 있는 파일이면 똑같이 쓴다.
 *
 * 🔴 만들 때(NewPackage)와 **같은 트리 편집기**를 쓴다 — 예전엔 만든 뒤 화면이 「넣을 자리·여기에 넣기·
 *    직접 적기·그룹 만들기」라는 다른 모양이어서 초보자가 두 번 배웠다(2026-09-08, 전문가 검토로 통일).
 *    여기서는 줄마다 API를 바로 부르고, 서버가 검증(중복·순환·이름)을 맡는다.
 */
import { useState } from 'react';
import type { HierarchyNode, HierarchyView, PackageDescription } from '../api.js';
import type { Submodel } from '../model.js';
import { HierarchyTree, type Adder, type DraftNode } from './HierarchyTree.js';
import { tr } from '../i18n.js';
import { T } from './T.js';

interface Props {
  view: HierarchyView;
  /** 설비 한 대(부품 구성)인가 공정·회사(설비 배치)인가 — 제목·설명이 갈린다 */
  unit: 'equipment' | 'composite';
  /** 열려 있는 입력 줄 — 트리의 ▦ 클릭·요약의 「＋ …」로도 열리므로 밖(App)이 들고 있다 */
  adder?: Adder;
  onAdderChange: (adder?: Adder) => void;
  /** 넣을 수 있는 후보 — 지금 열려 있는 파일을 뺀 나머지 */
  candidates: PackageDescription[];
  /** PC 폴더에서 .aasx를 올려 그 자리에서 넣는다 — 만들 때(NewPackage)와 같은 손놀림이어야 한다 */
  onImportFile?: (file: File) => Promise<string | undefined>;
  busy: boolean;
  /** 자체 IRI 뿌리 — 이름만 적은 설비의 Asset 주소를 짓는 데 쓴다 */
  iriBase?: string;
  onAdd: (sourcePackageId: string, bulkCount: number, parentPath: string[]) => void;
  /** 호기별로 나눠 넣기 — ×n 대신 이름_1…이름_n 파일을 각각 */
  onAddSplit: (sourcePackageId: string, count: number, parentPath: string[]) => void;
  onAddManual: (name: string, globalAssetId: string, bulkCount: number, parentPath: string[]) => void;
  onAddGroup: (name: string, parentPath: string[]) => void;
  onRemove: (name: string, parentPath: string[]) => void;
  /** ㉯ 자식 설비의 서브모델을 그 자리에서 펼쳐 본다 — 파일 구조는 참조형 그대로, 화면에서만 이어 붙인다 */
  fetchSubmodels: (packageId: string) => Promise<Submodel[]>;
  onOpen: (packageId: string) => void;
  /** 번역기 — 사전에 없으면 한국어 그대로 (i18n.ts) */
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
  /** 펼쳐 둔 설비(경로 키) → 읽어 온 서브모델 목록 (undefined = 읽는 중). 같은 이름이 두 공정에 있을 수 있어 경로로 키를 잡는다 */
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

  /** 서버 계층 → 트리 편집기 노드. 그룹은 주소가 빈 문자열로 내려온다(전송 표현) */
  const toDraft = (list: HierarchyNode[]): DraftNode[] =>
    list.map((node) => {
      if (node.globalAssetId === '') {
        return { name: node.name, kind: 'group', count: 1, split: false, children: toDraft(node.children) };
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
      {/* "이게 뭔지, 파일에 들어 있는 건지" 물어 왔다(2026-09-08) — 출처를 첫 줄에 적는다 */}
      <p className="hint">
        {unit === 'equipment'
          ? t('이 설비를 이루는 부품입니다 — 이 파일의 HierarchicalStructures 서브모델(IDTA 02011)에 저장됩니다.')
          : tr('회사 → 공정 → 설비를 한 트리로 그립니다 — 이 파일의 HierarchicalStructures 서브모델(IDTA 02011)에 저장되고, 왼쪽 트리 맨 위 ⚙·▦ 줄로도 보입니다. 회사 줄의 「＋ 공정」으로 공정을 만들고, 그 공정 줄의 「＋ 설비」로 설비를 넣습니다(올려 둔 파일에서 고르거나 「PC에서 가져오기」로 이 PC 폴더의 .aasx를 바로 올립니다).')}
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
        onAddGroup={(parentPath, name) => onAddGroup(name, parentPath)}
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
