/**
 * Composition tree editor — draws company → process → (line →) equipment **in one tree**.
 *
 * Important: there is one rule: the company row's "+ Process" creates a process, and **that process row's "+ Equipment"** puts equipment under it.
 *    An input row opens right below the clicked row, and what you add is attached under it.
 *    We once also gave process rows "+ Process" (sub-process), and people wondered "do I pick the process twice?" — removed (user, 2026-09-08).
 *    The server accepts nesting, but the screen draws company → (line →) process → equipment. Lines are created only with the
 *    company row's "+ Line", and line rows get "+ Process" and "+ Equipment" (2026-10-14, digital-twin five-level concept — parts are the BoM inside the equipment file).
 *    Process rows still carry only "+ Equipment" — the reason "process under process" was confusing still holds.
 *    There are no separate concepts such as "Slot to add", "Add here", "Type directly" or "Make group" —
 *    the same thing looked different while creating (draft) and after creating (immediate save), so beginners learned it twice
 *    (2026-09-08, conclusion of the UX and AAS expert review: unify into one tree).
 *
 * The caller decides between the two modes — draft (NewPackage: edits an in-memory tree) · immediate (Hierarchy: calls the API per row).
 * This component does not distinguish them. Only one input row is open in the whole tree at a time (adder).
 */
import type { PackageDescription } from '../api.js';
import { tr } from '../i18n.js';
import { AssetAdder } from './hierarchy/AssetAdder.js';
import { BuildNodes } from './hierarchy/BuildNodes.js';
import { GroupAdder } from './hierarchy/GroupAdder.js';
import { TERMS, type Adder, type DraftNode } from './hierarchy/terms.js';

export { NODE_NAME_RE, nodeNameOk, type Adder, type DraftNode } from './hierarchy/terms.js';

interface Props {
  /** Word set — defaults to a process file. 'equipment' for the part composition of an equipment file */
  unit?: keyof typeof TERMS;
  rootName: string;
  /** Kind label of the root row — "Company / bundle" etc. */
  rootLabel: string;
  rootAssetId?: string;
  nodes: readonly DraftNode[];
  /** Uploaded files that can be picked from "+ Equipment" */
  candidates: readonly PackageDescription[];
  /**
   * Uploads a .aasx from a PC folder in place — returning the uploaded file's packageId makes it selected right away.
   * Important: without it the button is not drawn. This is where people got stuck seeing only "No uploaded files" (user, 2026-09-09).
   */
  onImportFile?: (file: File) => Promise<string | undefined>;
  busy: boolean;
  adder?: Adder;
  onAdderChange: (adder?: Adder) => void;
  onAddGroup: (parentPath: string[], name: string, line?: boolean) => void;
  onAddFile: (parentPath: string[], packageId: string, count: number, split: boolean) => void;
  onAddPlanned: (parentPath: string[], name: string) => void;
  onRemove: (path: string[], node: DraftNode) => void;
  /** What to append at the end of an equipment (file) row — immediate mode's ▸ expand submodels / "Open file" */
  leafExtra?: (node: DraftNode, path: string[]) => React.ReactNode;
  /** One line shown when the root has nothing */
  emptyHint?: string;
  /** Translator (i18n.ts) */
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
  const terms = TERMS[unit]; // Important: renamed so it does not clash with the translator t (2026-10-02)
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

  /** The open input row — when its position (adderKey) changes the key changes, so it is redrawn and the input is cleared */
  const renderAdder = (path: string[]): React.JSX.Element => {
    const siblings = findChildren(path).map((node) => node.name);
    return adder?.kind === 'group' || adder?.kind === 'line' ? (
      <GroupAdder key={adderKey} path={path} siblings={siblings} terms={terms} line={adder.kind === 'line'} busy={busy} onAddGroup={onAddGroup} close={close} t={t} />
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
          {terms.line && (
            <button
              type="button"
              className="act"
              disabled={busy}
              title={tr('공정을 묶는 단계(라인)를 만듭니다 — 회사 → 라인 → 공정 → 설비')}
              onClick={() => open([], 'line')}
            >
              ＋ {t(terms.line)}
            </button>
          )}
          <button
            type="button"
            className="act"
            disabled={busy}
            title={tr('파일 없는 단계(공정·라인)를 만듭니다')}
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
