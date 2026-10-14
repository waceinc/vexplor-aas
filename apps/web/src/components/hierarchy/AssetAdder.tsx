/**
 * Composition tree — equipment (or part) add row — pick from uploaded files · import from the PC · or just type a name. Count and per-unit.
 * Split out of components/HierarchyTree.tsx (2026-10-13 componentization) — markup and comments were moved verbatim.
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
  /** Uploading from the PC — a few MB takes a few seconds. Meanwhile the same button cannot be pressed again */
  const [importing, setImporting] = useState(false);
  const adderRef = useRef<HTMLDivElement>(null);
  const diskRef = useRef<HTMLInputElement>(null);
  // Scroll to that spot (when the input row moves elsewhere, Hierarchy changes the key and redraws it — the value is cleared too)
  // Wrapped in braces so nothing is returned — current Chrome's scrollIntoView returns a Promise; returning it made
  // React treat it as a cleanup function and call it when the row closed, freezing the whole screen (measured 2026-10-14). jsdom has no scrollIntoView
  useEffect(() => {
    void adderRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, []);
  const countN = Math.max(1, Number(count) || 1);
  // Equipment — pick from uploaded files, or just a name
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
              event.target.value = ''; // so change fires even when the same file is picked again
              if (!chosen) return;
              setImporting(true);
              void onImportFile(chosen)
                .then((packageId) => {
                  if (packageId === undefined) return; // failures are reported by the outside (App)
                  setFile(packageId); // selected as soon as it is uploaded — just press "Add"
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
