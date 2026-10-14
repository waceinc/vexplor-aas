/**
 * Create new — one machine, or a process made of several machines.
 *
 * Important: never create an empty AAS. KOSMO requires 4 submodel kinds and caps the total at 6–8 kinds —
 * starting from an empty file means a person has to remember that and attach them one by one. The skeleton is built by **the server (linter policy)**.
 * Here we only take the name and the submodels to add.
 *
 * Choosing a process creates the hierarchy submodel (IDTA 02011) already filled up to the entry node.
 * Hanging the machines under it one by one is the job of the "What is it made of" panel.
 */
import { useState } from 'react';
import { HierarchyTree, type Adder, type DraftNode } from './HierarchyTree.js';
import type { PackageDescription, Policy } from '../api.js';
import { tr } from '../i18n.js';
import { T } from './T.js';

export type AssetUnit = 'equipment' | 'composite';

interface Props {
  policy?: Policy;
  /** Candidates that can go into a process — the equipment files open now */
  candidates?: PackageDescription[];
  /** Upload a .aasx from a PC folder and add it in place — passed through to HierarchyTree */
  onImportFile?: (file: File) => Promise<string | undefined>;
  busy: boolean;
  onCancel: () => void;
  onCreate: (
    assetName: string,
    extraSubmodels: string[],
    unit: AssetUnit,
    /** Composition created together — company → process → equipment tree (draft). After creation it is added row by row through the API */
    tree: DraftNode[],
  ) => void;
  /** Translator (i18n.ts) */
  t: (text: string) => string;
}

/** Added by default on top of the required 4 — must match the server's DEFAULT_EXTRA_SUBMODELS */
/**
 * Descriptions of the required 4 — even the order follows the rules (policy requiredSubmodels order).
 * Beginners cannot tell what they are from the English names alone.
 */
const REQUIRED_HINTS: Record<string, string> = {
  DigitalNameplate: tr('명판 — 제조사·모델명·일련번호'),
  HandoverDocumentation: tr('인계 문서 — 매뉴얼·도면 첨부'),
  TechnicalData: tr('기술 사양'),
  OperationalData: tr('운전 데이터'),
};

/**
 * Optional submodels — those likely used in this program out of the 54 officially published by IDTA (confirmed by the user, 2026-08-26).
 * Numbered 5–11 after the required 4. Equipment-specific ones (xxxSafety) have varied names, so they are typed directly.
 */
const OPTIONAL_EXTRAS: { name: string; hint: string; on: boolean }[] = [
  { name: 'HierarchicalStructures', hint: tr('BoM 구조 복잡 장비'), on: true },
  { name: 'MaintenanceInstructions', hint: tr('주기적 보전 중요 장비'), on: true },
  { name: 'CarbonFootprint', hint: tr('에너지 집약 장비'), on: false },
  { name: 'TimeSeriesData', hint: tr('시계열 모니터링 장비'), on: false },
  { name: 'ContactInformation', hint: tr('모든 장비 공통'), on: false },
  { name: 'AssetInterfacesDescription', hint: tr('OPC UA 연동 장비 (수집 연결)'), on: false },
  { name: 'ProvisionOf3DModels', hint: tr('3D 모델 제공'), on: false },
];

const DEFAULT_EXTRAS = OPTIONAL_EXTRAS.map((option) => option.name);

export function NewPackage({
  policy,
  candidates = [],
  onImportFile,
  busy,
  onCancel,
  onCreate,
  t,
}: Props): React.JSX.Element {
  const [assetName, setAssetName] = useState('');
  const [extra, setExtra] = useState('');
  /** Optional submodel checks — by default only the measured standard set (hierarchy · maintenance instructions) is on */
  const [optional, setOptional] = useState<Record<string, boolean>>(
    Object.fromEntries(OPTIONAL_EXTRAS.map((option) => [option.name, option.on])),
  );
  const [unit, setUnit] = useState<AssetUnit>('equipment');
  /**
   * Composition draft — company (this file) → process → equipment. Creation and after-creation use **the same tree editor** (HierarchyTree).
   * Important: a checklist plus a "which level" select did not draw a tree (user, 2026-09-08). A row's "+" adds under that row
   */
  const [tree, setTree] = useState<DraftNode[]>([]);
  const [adder, setAdder] = useState<Adder>();

  const valid = /^[A-Za-z][A-Za-z0-9_]*$/.test(assetName);
  // Process, company and line have the same structure (hierarchy only), so there is one screen — the name decides
  const process = unit !== 'equipment';
  const userExtras = extra.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '');
  // Important: the 2 optional ones (hierarchy · maintenance instructions) are for equipment only — a process starts with the hierarchy only (a bug caught earlier by measurement)
  const checkedExtras = DEFAULT_EXTRAS.filter((name) => optional[name]);
  const extras = process ? userExtras : [...checkedExtras, ...userExtras];
  const required = policy?.requiredSubmodels ?? [];
  const total = required.length + extras.length;

  /** Builds a new tree by replacing the child list at the path — state is treated as immutable */
  const updateAt = (list: DraftNode[], path: string[], fn: (children: DraftNode[]) => DraftNode[]): DraftNode[] => {
    if (path.length === 0) return fn(list);
    return list.map((node) =>
      node.name === path[0] ? { ...node, children: updateAt(node.children, path.slice(1), fn) } : node,
    );
  };
  const addAt = (path: string[], node: DraftNode): void =>
    setTree((current) => updateAt(current, path, (children) => [...children, node]));
  /** Removing a process moves what was under it up one level — nothing is deleted silently */
  const removeAt = (path: string[]): void => {
    const name = path[path.length - 1]!;
    setTree((current) =>
      updateAt(current, path.slice(0, -1), (children) => {
        const gone = children.find((node) => node.name === name);
        const rest = children.filter((node) => node.name !== name);
        return gone?.kind === 'group' ? [...rest, ...gone.children] : rest;
      }),
    );
    if (adder && adder.path.join('/').startsWith(path.join('/'))) setAdder(undefined);
  };
  const treeSize = (list: DraftNode[]): number =>
    list.reduce((n, node) => n + 1 + treeSize(node.children), 0);

  return (
    <div className="add-form">
      <h3>{tr('새로 만들기')}</h3>
      {/* Important: process, company and line are not split into buttons — the structure is exactly the same (one hierarchy), and fixing level names
          adds a button every time someone asks "what about lines? sites?". The standard hierarchy (RAMI 4.0) is recursive, so the user
          should name the levels (confirmed 2026-08-26). We once reduced the button to "Process" and reverted it — the right use is making
          a company group, not one process (user, 2026-09-08). The name is "Group (company/process)" */}
      <div className="unit-choice">
        <button
          className={unit === 'equipment' ? 'primary' : ''}
          onClick={() => setUnit('equipment')}
          disabled={busy}
          title={tr('설비 한 대 — 필수 서브모델 4종이 든 뼈대가 만들어집니다')}
        >
          {tr('설비')}
        </button>
        <button
          className={unit === 'composite' ? 'primary' : ''}
          onClick={() => setUnit('composite')}
          disabled={busy}
          title={tr('회사·공정으로 설비들을 묶는 파일 — 설비 상세는 담지 않고 주소로 가리킵니다')}
        >
          {tr('그룹(회사/공정)')}
        </button>
      </div>
      <p className="hint">
        {process
          ? tr('여러 설비·공정을 담는 단위입니다 — 회사·공정·라인 무엇이든 이름으로 정해집니다. 설비 내용은 각 설비 파일에 있고, 이 파일은 그것을 잇습니다.')
          : tr('설비 한 대의 AAS입니다. 필수 서브모델 4종이 자동으로 들어갑니다.')}
      </p>

      {/* (1) Name */}
      <label>
        {process ? tr('① 이름 (회사·공정·라인)') : tr('설비 이름')}
        <input
          value={assetName}
          autoFocus
          onChange={(event) => setAssetName(event.target.value)}
          placeholder={process ? tr('예: OurFactory · WeldingLine') : tr('예: PressMachine')}
        />
      </label>
      {assetName !== '' && !valid && (
        <p className="warn">{tr('영문으로 시작하고 영문·숫자·밑줄만 씁니다. 이 이름이 id에 그대로 들어갑니다.')}</p>
      )}

      {!process && (
        <>
          <div className="sm-plan">
            <p className="pick-title">{tr('필수 서브모델 — 자동 생성 (순서 고정)')}</p>
            <ol className="sm-required">
              {required.map((name, index) => (
                <li key={name}>
                  {/* Required ones are locked checks — in the same columns (check · number · name) as the optional list, so names start aligned */}
                  <label>
                    <input type="checkbox" checked disabled aria-label={tr('자동으로 들어갑니다')} />
                    <span className="sm-num">{index + 1}.</span>
                    <span>
                      <b>{name}</b>
                      {REQUIRED_HINTS[name] && <span className="dim"> — {REQUIRED_HINTS[name]}</span>}
                    </span>
                  </label>
                </li>
              ))}
            </ol>
            <p className="pick-title">{tr('선택 서브모델 — 필요한 것만 체크')}</p>
            <ul className="sm-optional">
              {OPTIONAL_EXTRAS.map((option, index) => (
                <li key={option.name}>
                  <label>
                    <input
                      type="checkbox"
                      checked={optional[option.name] ?? false}
                      onChange={() =>
                        setOptional((current) => ({
                          ...current,
                          [option.name]: !current[option.name],
                        }))
                      }
                    />
                    <span className="sm-num">{required.length + index + 1}.</span>
                    <span>
                      <b>{option.name}</b>
                      <span className="dim"> — {option.hint}</span>
                    </span>
                  </label>
                </li>
              ))}
            </ul>
          </div>
          <label>
            {tr('설비 특화 서브모델 (직접 입력)')}
            <input
              value={extra}
              onChange={(event) => setExtra(event.target.value)}
              placeholder={tr('쉼표로 구분 — 예: PressSafety (보통 1개)')}
            />
          </label>
          <p className="hint"><T k={'만들면 <b>{0}종</b>이 들어갑니다: {1}'} v={[total, <span className="mono">{[...required, ...extras].join(' · ')}</span>]} />
          </p>
          {/* KOSMO-AAS-4 — 6–8 kinds in total. From 9 kinds it violates the rule the moment it is created, so warn ahead */}
          {total > 8 && (
            <p className="note warning">
              <T k={'{0}종은 KOSMO 상한(8종)을 넘습니다 — 만들자마자 위반(KOSMO-AAS-4)이 됩니다. 설비 특화 서브모델을 줄이십시오.'} v={[total]} /></p>
          )}
        </>
      )}

      {process && (
        <div className="pick-parts">
          <p className="pick-title">{tr('② 구성 — 회사 → 공정 → 설비를 트리로')}</p>
          <p className="hint"><T k={'회사 줄의 「＋ 공정」으로 공정을 만들고, <b>그 공정 줄의 「＋ 설비」</b>로 밑에 설비를 넣습니다. 설비는 올려 둔 파일에서 고르거나, <b>「PC에서 가져오기」</b>로 이 PC 폴더의 .aasx를 그 자리에서 올리거나, 아직 파일이 없으면 이름만 적습니다. 만든 뒤에도 같은 모양으로 고칩니다.'} /></p>
          <HierarchyTree
            t={t}
            rootName={assetName || tr('(이름)')}
            rootLabel={tr('회사·묶음')}
            nodes={tree}
            candidates={candidates}
            {...(onImportFile ? { onImportFile } : {})}
            busy={busy}
            {...(adder ? { adder } : {})}
            onAdderChange={setAdder}
            onAddGroup={(path, name, line) => addAt(path, { name, kind: 'group', ...(line ? { line: true } : {}), count: 1, split: false, children: [] })}
            onAddFile={(path, packageId, count, split) => {
              const item = candidates.find((c) => c.packageId === packageId);
              addAt(path, {
                name: item?.assetName ?? item?.name?.replace(/\.aasx$/i, '') ?? packageId,
                kind: 'file',
                packageId,
                fileName: item?.name ?? packageId,
                count,
                split,
                children: [],
              });
            }}
            onAddPlanned={(path, name) => addAt(path, { name, kind: 'planned', count: 1, split: false, children: [] })}
            onRemove={(path) => removeAt(path)}
            emptyHint={tr('아직 비어 있습니다 — 위 줄의 「＋ 공정」부터. 빈 채로 만들고 나중에 넣어도 됩니다.')}
          />

          <details className="pick-advanced">
            <summary>{tr('고급 — 묶음 자체의 서브모델')}</summary>
            <p className="hint">
              {tr('묶음 파일에는 계층(HierarchicalStructures)만 들어갑니다. 묶음 자체의 명판 등이 더 필요하면 여기 적거나, 만든 뒤 「＋ 서브모델」로 더합니다.')}
            </p>
            <label>
              {tr('서브모델 이름')}
              <input
                value={extra}
                onChange={(event) => setExtra(event.target.value)}
                placeholder={tr('쉼표로 구분 — 예: DigitalNameplate')}
              />
            </label>
          </details>
        </div>
      )}

      {!process && (
        <p className="hint"><T k={'대표 사진은 <b>임시 그림</b>이 들어갑니다. 실제 사진으로 바꾸십시오 (AssetInformation을 고르면 바꿀 수 있습니다).'} /></p>
      )}

      <div className="row-buttons">
        <button
          className={process && adder ? '' : 'primary'}
          disabled={!valid || busy || !policy}
          title={tr('이 이름으로 새 파일을 만들어 서버에 올립니다')}
          onClick={() =>
            onCreate(
              assetName,
              extras,
              unit,
              process ? tree : [],
            )
          }
        >
          {tr('만들기')}
        </button>
        <button onClick={onCancel} disabled={busy}>
          {tr('취소')}
        </button>
      </div>
    </div>
  );
}
