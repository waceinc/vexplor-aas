/**
 * 새로 만들기 — 설비 한 대, 또는 여러 설비로 이루어진 공정.
 *
 * 🔴 빈 AAS를 만들지 않는다. KOSMO는 서브모델 4종을 요구하고 총 개수를 6~8종으로 묶는다 —
 * 빈 파일에서 출발하면 그걸 사람이 기억해 하나씩 붙여야 한다. 뼈대는 **서버(린터 정책)** 가 만든다.
 * 여기서는 이름과 추가할 서브모델만 받는다.
 *
 * 공정을 고르면 계층 서브모델(IDTA 02011)이 진입점까지 채워진 채로 만들어진다.
 * 그다음 설비를 하나씩 매다는 것은 「무엇으로 이루어졌나」 패널이 맡는다.
 */
import { useState } from 'react';
import { HierarchyTree, type Adder, type DraftNode } from './HierarchyTree.js';
import type { PackageDescription, Policy } from '../api.js';
import { tr } from '../i18n.js';
import { T } from './T.js';

export type AssetUnit = 'equipment' | 'composite';

interface Props {
  policy?: Policy;
  /** 공정에 넣을 수 있는 후보 — 지금 열려 있는 설비 파일들 */
  candidates?: PackageDescription[];
  /** PC 폴더에서 .aasx를 올려 그 자리에서 넣는다 — HierarchyTree로 넘긴다 */
  onImportFile?: (file: File) => Promise<string | undefined>;
  busy: boolean;
  onCancel: () => void;
  onCreate: (
    assetName: string,
    extraSubmodels: string[],
    unit: AssetUnit,
    /** 함께 만들 구성 — 회사 → 공정 → 설비 트리(초안). 만든 뒤 줄마다 API로 넣는다 */
    tree: DraftNode[],
  ) => void;
  /** 번역기 (i18n.ts) */
  t: (text: string) => string;
}

/** 필수 4종에 더해 기본으로 넣는 것 — 서버의 DEFAULT_EXTRA_SUBMODELS와 같아야 한다 */
/**
 * 필수 4종의 설명 — 순서까지 규정 그대로다(정책 requiredSubmodels 순).
 * 초보자는 영문 이름만으로 무엇인지 모른다.
 */
const REQUIRED_HINTS: Record<string, string> = {
  DigitalNameplate: tr('명판 — 제조사·모델명·일련번호'),
  HandoverDocumentation: tr('인계 문서 — 매뉴얼·도면 첨부'),
  TechnicalData: tr('기술 사양'),
  OperationalData: tr('운전 데이터'),
};

/**
 * 선택 서브모델 — IDTA 공식 발행 54종 중 이 사업에서 쓸 법한 것(2026-08-26 사용자 확정).
 * 번호는 필수 4종에 이어 5~11로 매긴다. 장비 특화(○○Safety)는 이름이 제각각이라 직접 입력이다.
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
  /** 선택 서브모델 체크 — 기본은 실측 표준 구성(계층·정비지침)만 켠다 */
  const [optional, setOptional] = useState<Record<string, boolean>>(
    Object.fromEntries(OPTIONAL_EXTRAS.map((option) => [option.name, option.on])),
  );
  const [unit, setUnit] = useState<AssetUnit>('equipment');
  /**
   * 구성 초안 — 회사(이 파일) → 공정 → 설비. 만들 때와 만든 뒤가 **같은 트리 편집기**다(HierarchyTree).
   * 🔴 체크 목록 + 「어느 층」 셀렉트로는 트리가 안 그려졌다(사용자 2026-09-08). 줄의 「＋」가 그 줄 밑에 넣는다
   */
  const [tree, setTree] = useState<DraftNode[]>([]);
  const [adder, setAdder] = useState<Adder>();

  const valid = /^[A-Za-z][A-Za-z0-9_]*$/.test(assetName);
  // 공정·회사·라인은 같은 구조(계층만)라 화면도 하나다 — 이름으로 정해진다
  const process = unit !== 'equipment';
  const userExtras = extra.split(',').map((entry) => entry.trim()).filter((entry) => entry !== '');
  // 🔴 선택 2종(계층·정비지침)은 설비에만 — 공정은 계층만으로 시작한다(앞서 실측으로 잡은 버그)
  const checkedExtras = DEFAULT_EXTRAS.filter((name) => optional[name]);
  const extras = process ? userExtras : [...checkedExtras, ...userExtras];
  const required = policy?.requiredSubmodels ?? [];
  const total = required.length + extras.length;

  /** 경로의 자식 목록을 바꿔 새 트리를 만든다 — 상태는 불변으로 다룬다 */
  const updateAt = (list: DraftNode[], path: string[], fn: (children: DraftNode[]) => DraftNode[]): DraftNode[] => {
    if (path.length === 0) return fn(list);
    return list.map((node) =>
      node.name === path[0] ? { ...node, children: updateAt(node.children, path.slice(1), fn) } : node,
    );
  };
  const addAt = (path: string[], node: DraftNode): void =>
    setTree((current) => updateAt(current, path, (children) => [...children, node]));
  /** 공정을 빼면 그 밑 것들은 한 층 위로 올라온다 — 말없이 지우지 않는다 */
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
      {/* 🔴 공정·회사·라인을 버튼으로 나누지 않는다 — 구조가 완전히 같고(계층 하나), 층 이름을 고정하면
          "라인은? 사이트는?" 할 때마다 버튼이 는다. 표준 계층(RAMI 4.0)은 재귀라 층 이름은 사용자가
          짓는 것이 맞다(2026-08-26 확정). 버튼을 「공정」으로 줄였다가 되돌렸다 — 한 공정이 아니라
          회사 그룹으로 만드는 쓰임이 맞다(사용자 2026-09-08). 이름은 「그룹(회사/공정)」 */}
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

      {/* ① 이름 */}
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
                  {index + 1}. <b>{name}</b>
                  {REQUIRED_HINTS[name] && <span className="dim"> — {REQUIRED_HINTS[name]}</span>}
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
                    {required.length + index + 1}. <b>{option.name}</b>
                    <span className="dim"> — {option.hint}</span>
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
          {/* KOSMO-AAS-4 — 총 6~8종. 9종부터는 만들자마자 위반이라 미리 알린다 */}
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
            onAddGroup={(path, name) => addAt(path, { name, kind: 'group', count: 1, split: false, children: [] })}
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
