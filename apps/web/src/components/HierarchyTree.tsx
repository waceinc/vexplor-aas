/**
 * 구성 트리 편집기 — 회사 → 공정 → (라인 →) 설비를 **한 트리에서** 그린다.
 *
 * 🔴 규칙은 하나다: 회사 줄의 「＋ 공정」으로 공정을 만들고, **그 공정 줄의 「＋ 설비」**로 밑에 설비를 넣는다.
 *    누른 줄 바로 밑에 입력 줄이 열리고, 넣은 것은 그 밑에 붙는다.
 *    공정 줄에 「＋ 공정」(하위 공정)까지 두었더니 "공정을 두 번 고르나" 하고 헷갈렸다 — 뺐다(사용자 2026-09-08).
 *    서버는 중첩을 받지만 화면은 회사 → 공정 → 설비 세 층만 그린다.
 *    「넣을 자리」「여기에 넣기」「직접 적기」「그룹 만들기」 같은 별도 개념은 없다 —
 *    같은 것을 만들 때(초안)와 만든 뒤(즉시 저장)에 다른 모양으로 보여 초보자가 두 번 배웠다
 *    (2026-09-08, UX·AAS 전문가 검토 결론: 트리 하나로 통일).
 *
 * 두 모드는 호출부가 정한다 — 초안(NewPackage: 메모리 트리를 고친다) · 즉시(Hierarchy: 줄마다 API를 부른다).
 * 이 컴포넌트는 둘을 구분하지 않는다. 입력 줄은 트리 전체에서 한 번에 하나만 열린다(adder).
 */
import type { PackageDescription } from '../api.js';
import { tr } from '../i18n.js';
import { AssetAdder } from './hierarchy/AssetAdder.js';
import { BuildNodes } from './hierarchy/BuildNodes.js';
import { GroupAdder } from './hierarchy/GroupAdder.js';
import { TERMS, type Adder, type DraftNode } from './hierarchy/terms.js';

export { NODE_NAME_RE, nodeNameOk, type Adder, type DraftNode } from './hierarchy/terms.js';

interface Props {
  /** 낱말 셋 — 기본은 공정 파일. 설비 파일의 부품 구성이면 'equipment' */
  unit?: keyof typeof TERMS;
  rootName: string;
  /** 뿌리 줄의 종류 표시 — 「회사·묶음」 등 */
  rootLabel: string;
  rootAssetId?: string;
  nodes: readonly DraftNode[];
  /** 「＋ 설비」에서 고를 수 있는 올려 둔 파일 */
  candidates: readonly PackageDescription[];
  /**
   * PC 폴더의 .aasx를 그 자리에서 올린다 — 올린 파일의 packageId를 돌려주면 바로 골라진 상태가 된다.
   * 🔴 없으면 버튼을 그리지 않는다. 「올려 둔 파일 없음」만 보고 막히던 자리다(사용자 2026-09-09).
   */
  onImportFile?: (file: File) => Promise<string | undefined>;
  busy: boolean;
  adder?: Adder;
  onAdderChange: (adder?: Adder) => void;
  onAddGroup: (parentPath: string[], name: string) => void;
  onAddFile: (parentPath: string[], packageId: string, count: number, split: boolean) => void;
  onAddPlanned: (parentPath: string[], name: string) => void;
  onRemove: (path: string[], node: DraftNode) => void;
  /** 설비(file) 줄 끝에 덧붙일 것 — 즉시 모드의 ▸ 서브모델 펼치기·「파일 열기」 */
  leafExtra?: (node: DraftNode, path: string[]) => React.ReactNode;
  /** 뿌리에 아무것도 없을 때 한 줄 */
  emptyHint?: string;
  /** 번역기 (i18n.ts) */
  t: (text: string) => string;
}

export function HierarchyTree({
  unit = 'composite',
  rootName,
  rootLabel,
  rootAssetId,
  nodes,
  candidates,
  onImportFile,
  busy,
  adder,
  onAdderChange,
  onAddGroup,
  onAddFile,
  onAddPlanned,
  onRemove,
  leafExtra,
  emptyHint,
  t,
}: Props): React.JSX.Element {
  const terms = TERMS[unit]; // 🔴 번역기 t와 겹치지 않게 이름을 바꿨다(2026-10-02)
  const adderKey = adder ? `${adder.kind}:${adder.path.join('/')}` : '';

  const findChildren = (path: readonly string[]): readonly DraftNode[] => {
    let list: readonly DraftNode[] = nodes;
    for (const part of path) {
      const found = list.find((node) => node.name === part);
      if (!found) return [];
      list = found.children;
    }
    return list;
  };

  const open = (path: string[], kind: Adder['kind']): void => onAdderChange({ path, kind });
  const close = (): void => onAdderChange(undefined);

  /** 열린 입력 줄 — 자리(adderKey)가 바뀌면 key 가 바뀌어 새로 그려지고 입력값도 비워진다 */
  const renderAdder = (path: string[]): React.JSX.Element => {
    const siblings = findChildren(path).map((node) => node.name);
    return adder?.kind === 'group' ? (
      <GroupAdder key={adderKey} path={path} siblings={siblings} terms={terms} busy={busy} onAddGroup={onAddGroup} close={close} t={t} />
    ) : (
      <AssetAdder
        key={adderKey}
        path={path}
        siblings={siblings}
        terms={terms}
        candidates={candidates}
        {...(onImportFile ? { onImportFile } : {})}
        busy={busy}
        onAddFile={onAddFile}
        onAddPlanned={onAddPlanned}
        close={close}
        t={t}
      />
    );
  };

  const nodeProps = { terms, adder, busy, open, onRemove, renderAdder, t, ...(leafExtra ? { leafExtra } : {}) };
  const rootFocus = adder !== undefined && adder.path.length === 0;
  return (
    <ul className="build-tree">
      <li>
        <div className={`build-row root${rootFocus ? ' focus' : ''}`}>
          <span className="build-name">{rootName}</span>
          <span className="dim">{rootLabel}</span>
          {rootAssetId && <span className="mono dim pick-file">{rootAssetId}</span>}
          <button
            type="button"
            className="act"
            disabled={busy}
            title={tr('파일 없는 층(공정·라인)을 만듭니다')}
            onClick={() => open([], 'group')}
          >
            ＋ {t(terms.group)}
          </button>
          <button
            type="button"
            className="act"
            disabled={busy}
            title={tr('설비(또는 부품)를 넣습니다')}
            onClick={() => open([], 'asset')}
          >
            ＋ {t(terms.asset)}
          </button>
        </div>
        <ul>
          {nodes.length === 0 && !adder && emptyHint && (
            <li>
              <p className="hint">{emptyHint}</p>
            </li>
          )}
          <BuildNodes {...nodeProps} list={nodes} path={[]} />
          {adder && adder.path.length === 0 && <li>{renderAdder([])}</li>}
        </ul>
      </li>
    </ul>
  );
}
