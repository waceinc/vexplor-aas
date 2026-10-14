/**
 * 구성 트리 — 설비(또는 부품) 넣기 줄 — 올려 둔 파일에서 고르거나 · PC 에서 가져오거나 · 이름만 적는다. 대수와 호기별.
 * components/HierarchyTree.tsx 에서 떼어 냈다(2026-10-13 컴포넌트화) — 마크업·주석은 옮기기 전 글자 그대로다.
 */
import { useEffect, useRef, useState } from 'react';
import type { PackageDescription } from '../../api.js';
import { fill, tr } from '../../i18n.js';
import { T } from '../T.js';
import { NODE_NAME_RE, nodeNameOk, type Terms } from './terms.js';

interface Props {
  path: string[];
  siblings: readonly string[];
  terms: Terms;
  candidates: readonly PackageDescription[];
  onImportFile?: (file: File) => Promise<string | undefined>;
  busy: boolean;
  onAddFile: (parentPath: string[], packageId: string, count: number, split: boolean) => void;
  onAddPlanned: (parentPath: string[], name: string) => void;
  close: () => void;
  t: (text: string) => string;
}

export function AssetAdder({ path, siblings, terms, candidates, onImportFile, busy, onAddFile, onAddPlanned, close, t }: Props): React.JSX.Element {
  const [file, setFile] = useState('');
  const [name, setName] = useState('');
  const [count, setCount] = useState('1');
  const [split, setSplit] = useState(false);
  /** PC에서 올리는 중 — 몇 MB면 몇 초 걸린다. 그동안 같은 버튼을 다시 누르지 못하게 한다 */
  const [importing, setImporting] = useState(false);
  const adderRef = useRef<HTMLDivElement>(null);
  const diskRef = useRef<HTMLInputElement>(null);
  // 그 자리로 스크롤한다(입력 줄이 다른 자리로 옮겨 가면 Hierarchy 가 key 를 바꿔 새로 그린다 — 값도 비워진다)
  // 중괄호로 감싸 아무것도 돌려주지 않는다 — 요즘 크롬은 scrollIntoView 가 Promise 를 돌려줘, 그대로 돌려주면
  // React 가 그것을 정리 함수로 알고 줄이 닫힐 때 불러 화면 전체가 멈췄다(2026-10-14 실측). jsdom 에는 scrollIntoView 가 없다
  useEffect(() => {
    void adderRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, []);
  const countN = Math.max(1, Number(count) || 1);
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
}
