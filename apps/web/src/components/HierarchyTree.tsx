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
import { useEffect, useRef, useState } from 'react';
import type { PackageDescription } from '../api.js';
import { tr, fill } from '../i18n.js';
import { T } from './T.js';

export interface DraftNode {
  name: string;
  /** group = 공정·라인(파일 없는 층) · file = 올려 둔 설비 파일 · planned = 이름만(파일은 나중에) · unopened = 파일이 안 열림 */
  kind: 'group' | 'file' | 'planned' | 'unopened';
  packageId?: string;
  fileName?: string;
  /** 같은 것이 몇 대인지(형식 수량). 1이면 표시하지 않는다 */
  count: number;
  /** ×n 대신 이름_1…_n 파일로 각각 — 대별 수집이 목적일 때 */
  split: boolean;
  children: DraftNode[];
}

/** 열려 있는 입력 줄 — 어느 줄 밑(path)에 무엇(kind)을 넣는 중인가 */
export interface Adder {
  path: string[];
  kind: 'asset' | 'group';
}

/**
 * 이름 규칙 — 서버(`^[A-Za-z][A-Za-z0-9_]*$`)보다 린터가 엄격하다(KOSMO-SME-1: 2자 이상).
 * 여기서 린터 기준으로 막아 "만들었는데 위반"을 없앤다. `HasPart_…`는 관계 요소 이름과 부딪힌다(AASd-022)
 */
export const NODE_NAME_RE = /^[A-Za-z][A-Za-z0-9_]*[A-Za-z0-9_]$/;
export function nodeNameOk(name: string, siblings: readonly string[]): boolean {
  return NODE_NAME_RE.test(name) && !name.startsWith('HasPart_') && !siblings.includes(name);
}

/**
 * 화면 낱말 — 공정 파일은 「공정 → 설비」, 설비 파일(부품 구성 BoM)은 「조립체 → 부품」.
 * 🔴 부품 구성 패널이 「＋ 공정」「＋ 설비」로 말하고 있었다 — 요약의 「＋ 부품」과 어긋나
 *    "부품에 공정이 왜 있나"가 됐다(2026-09-09 검토). 구조는 같고 낱말만 다르다.
 */
const TERMS = {
  composite: {
    group: tr('공정'),
    asset: tr('설비'),
    groupMark: tr('공정·라인 — 파일 없는 층'),
    groupPlaceholder: tr('공정 이름 — 예: WeldingProcess (Enter로 연달아)'),
    assetPlaceholder: tr('이름만 — 예: PressMachine2'),
    /** 파일 없는 설비에 「예정」·「파일 안 열림」 배지 — 설비는 제 파일이 있어야 한다는 뜻 */
    fileBadges: true,
  },
  equipment: {
    group: tr('조립체'),
    asset: tr('부품'),
    groupMark: tr('조립체·모듈 — 부품을 묶는 층'),
    groupPlaceholder: tr('조립체 이름 — 예: DriveUnit (Enter로 연달아)'),
    assetPlaceholder: tr('부품 이름 — 예: MainMotor'),
    /** 부품은 대개 제 파일이 없다 — 「예정」「파일 안 열림」이라 하면 빠진 것처럼 읽힌다 */
    fileBadges: false,
  },
} as const;

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

const same = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

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
  const [file, setFile] = useState('');
  const [name, setName] = useState('');
  const [count, setCount] = useState('1');
  const [split, setSplit] = useState(false);
  /** PC에서 올리는 중 — 몇 MB면 몇 초 걸린다. 그동안 같은 버튼을 다시 누르지 못하게 한다 */
  const [importing, setImporting] = useState(false);
  const adderRef = useRef<HTMLDivElement>(null);
  const diskRef = useRef<HTMLInputElement>(null);
  const adderKey = adder ? `${adder.kind}:${adder.path.join('/')}` : '';

  // 입력 줄이 다른 자리로 옮겨 가면 값을 비우고 그 자리로 스크롤한다
  useEffect(() => {
    setFile('');
    setName('');
    setCount('1');
    setSplit(false);
    setImporting(false);
    if (adderKey) adderRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' }); // jsdom엔 없다
  }, [adderKey]);

  const findChildren = (path: readonly string[]): readonly DraftNode[] => {
    let list: readonly DraftNode[] = nodes;
    for (const part of path) {
      const found = list.find((node) => node.name === part);
      if (!found) return [];
      list = found.children;
    }
    return list;
  };

  const countN = Math.max(1, Number(count) || 1);
  const open = (path: string[], kind: Adder['kind']): void => onAdderChange({ path, kind });
  const close = (): void => onAdderChange(undefined);

  const renderAdder = (path: string[]): React.JSX.Element => {
    const siblings = findChildren(path).map((node) => node.name);
    if (adder?.kind === 'group') {
      const ok = nodeNameOk(name, siblings);
      const commit = (): void => {
        if (!ok) return;
        onAddGroup(path, name);
        setName(''); // 줄은 열어 둔다 — 공정 여러 개를 연달아
      };
      return (
        <div className="build-adder" ref={adderRef}>
          <span className="build-mark">▦</span>
          <input
            autoFocus
            aria-label={fill(tr('{0} 이름'), { 0: t(terms.group) })}
            value={name}
            placeholder={t(terms.groupPlaceholder)}
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                commit();
              }
              if (event.key === 'Escape') close();
            }}
          />
          <button
            type="button"
            className="primary"
            disabled={!ok || busy}
            title={tr('이 줄 아래에 넣습니다')}
            onClick={commit}
          >
            {tr('넣기')}
          </button>
          <button type="button" onClick={close} disabled={busy}>
            {tr('닫기')}
          </button>
          {name !== '' && !NODE_NAME_RE.test(name) && (
            <p className="warn">{tr('영문으로 시작, 영문·숫자·밑줄 2자 이상.')}</p>
          )}
          {name !== '' && NODE_NAME_RE.test(name) && siblings.includes(name) && (
            <p className="warn">{tr('같은 자리에 같은 이름이 이미 있습니다.')}</p>
          )}
        </div>
      );
    }
    // 설비 — 올려 둔 파일에서 고르거나, 이름만
    const picked = candidates.find((c) => c.packageId === file);
    const fileNameTaken = picked !== undefined && siblings.includes(picked.assetName ?? '');
    const canFile = file !== '' && !fileNameTaken;
    const canName = file === '' && nodeNameOk(name, siblings);
    const commit = (): void => {
      if (canFile) onAddFile(path, file, countN, split && countN > 1);
      else if (canName) onAddPlanned(path, name);
      else return;
      setFile('');
      setName('');
      setCount('1');
      setSplit(false);
    };
    return (
      <div className="build-adder" ref={adderRef}>
        <span className="build-mark">⚙</span>
        <select
          aria-label={tr('넣을 파일 고르기')}
          value={file}
          disabled={busy}
          onChange={(event) => setFile(event.target.value)}
        >
          <option value="">{candidates.length === 0 ? tr('— 올려 둔 파일 없음 —') : tr('— 올려 둔 파일에서 —')}</option>
          {candidates.map((candidate) => (
            <option key={candidate.packageId} value={candidate.packageId}>
              {candidate.assetName ?? candidate.name ?? candidate.packageId}
              {candidate.name ? ` (${candidate.name})` : ''}
            </option>
          ))}
        </select>
        {onImportFile && (
          <>
            <input
              ref={diskRef}
              type="file"
              accept=".aasx"
              hidden
              onChange={(event) => {
                const chosen = event.target.files?.[0];
                event.target.value = ''; // 같은 파일을 다시 골라도 change가 오게
                if (!chosen) return;
                setImporting(true);
                void onImportFile(chosen)
                  .then((packageId) => {
                    if (packageId === undefined) return; // 실패는 밖(App)이 알린다
                    setFile(packageId); // 올리자마자 골라진 상태 — 「넣기」만 누르면 된다
                    setName('');
                  })
                  .finally(() => setImporting(false));
              }}
            />
            <button
              type="button"
              disabled={busy || importing}
              title={tr('이 PC의 폴더에서 .aasx를 골라 올린 뒤 바로 넣습니다')}
              onClick={() => diskRef.current?.click()}
            >
              {importing ? tr('올리는 중…') : tr('PC에서 가져오기')}
            </button>
          </>
        )}
        <span className="dim">{tr('또는')}</span>
        <input
          aria-label={fill(tr('새 {0} 이름'), { 0: t(terms.asset) })}
          value={name}
          placeholder={t(terms.assetPlaceholder)}
          disabled={busy || file !== ''}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              commit();
            }
            if (event.key === 'Escape') close();
          }}
        />
        {file !== '' && (
          <label className="build-count">
            {tr('대수')}
            <input type="number" min={1} value={count} onChange={(event) => setCount(event.target.value)} />
          </label>
        )}
        {file !== '' && countN > 1 && (
          <label className="pick-split" title={tr('×n 한 줄 대신 이름_1…_n 파일로 각각 — 대별 수집이 목적이면 이쪽')}>
            <input type="checkbox" checked={split} onChange={() => setSplit((c) => !c)} />
            {tr('호기별')}
          </label>
        )}
        <button
            type="button"
            className="primary"
            disabled={!(canFile || canName) || busy}
            title={tr('고른 파일 또는 적은 이름으로 넣습니다')}
            onClick={commit}>
          {tr('넣기')}
        </button>
        <button type="button" onClick={close} disabled={busy}>
          {tr('닫기')}
        </button>
        {fileNameTaken && <p className="warn"><T k={'같은 자리에 같은 {0}이(가) 이미 있습니다 — 대수를 올리십시오.'} v={[t(terms.asset)]} /></p>}
        {file === '' && name !== '' && !NODE_NAME_RE.test(name) && (
          <p className="warn">{tr('영문으로 시작, 영문·숫자·밑줄 2자 이상.')}</p>
        )}
      </div>
    );
  };

  const renderNodes = (list: readonly DraftNode[], path: string[]): React.JSX.Element[] =>
    list.map((node) => {
      const here = [...path, node.name];
      const focus = adder !== undefined && same(adder.path, here);
      return (
        <li key={here.join('/')}>
          <div className={`build-row${focus ? ' focus' : ''}`}>
            {node.kind === 'group' ? (
              <>
                <span className="build-mark" title={t(terms.groupMark)}>▦</span>
                <span className="build-name">{node.name}</span>
                <span className="dim">{t(terms.group)}</span>
                <button
              type="button"
              className="act"
              disabled={busy}
              title={tr('이 줄 아래에 설비(또는 부품)를 넣습니다')}
              onClick={() => open(here, 'asset')}
            >
                  ＋ {t(terms.asset)}
                </button>
              </>
            ) : (
              <>
                <span
                  className="build-mark"
                  title={
                    node.kind === 'file'
                      ? fill(tr('{0} — 올려 둔 파일'), { 0: t(terms.asset) })
                      : node.kind === 'planned'
                        ? fill(tr('{0} — 이름만. 같은 이름으로 파일을 만들면 이어집니다'), { 0: t(terms.asset) })
                        : fill(tr('{0} — 파일이 열려 있지 않습니다'), { 0: t(terms.asset) })
                  }
                >
                  ⚙
                </span>
                <span className="build-name">{node.name}</span>
                {node.count > 1 && (
                  <span className="hier-count">{node.split ? `_1…_${node.count} ${t('호기별')}` : `×${node.count}${t('대')}`}</span>
                )}
                {node.kind === 'file' && <span className="dim pick-file">{node.fileName}</span>}
                {node.kind === 'planned' && terms.fileBadges && (
                  <span className="hier-count planned" title={tr('같은 이름으로 설비 파일을 만들면 저절로 이어집니다')}>
                    {tr('예정')}
                  </span>
                )}
                {node.kind === 'unopened' && terms.fileBadges && (
                  <span className="hier-count unopened" title={tr('이 설비 파일이 올라와 있지 않습니다 — 올리면 이어집니다')}>
                    {tr('파일 안 열림')}
                  </span>
                )}
                {leafExtra?.(node, here)}
              </>
            )}
            <button
              type="button"
              className="act danger"
              disabled={busy}
              title={node.kind === 'group' ? fill(tr('{0}을(를) 빼면 그 밑 {1}은(는) 한 층 위로 올라옵니다'), { 0: t(terms.group), 1: t(terms.asset) }) : tr('이 목록에서 뺍니다 — 파일은 지워지지 않습니다')}
              onClick={() => onRemove(here, node)}
            >
              ✕
            </button>
          </div>
          {node.kind === 'group' && (
            <ul>
              {renderNodes(node.children, here)}
              {adder && same(adder.path, here) && <li>{renderAdder(here)}</li>}
            </ul>
          )}
        </li>
      );
    });

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
          {renderNodes(nodes, [])}
          {adder && adder.path.length === 0 && <li>{renderAdder([])}</li>}
        </ul>
      </li>
    </ul>
  );
}
