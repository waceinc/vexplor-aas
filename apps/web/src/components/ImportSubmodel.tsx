/**
 * Import submodel — the substance of spec Phase 3 "IDTA standard template import".
 *
 * We cannot ship the official IDTA template files ourselves. Instead we import from **an AASX that has already passed validation**
 * — the way it was actually done when building many equipment types, and, since the source passed KOSMO Validator,
 * even more reliable than a standard template.
 * Re-minting ids for the new equipment and bringing the CDs along is done by the server (referential integrity).
 */
import { useEffect, useState } from 'react';
import { api, type PackageDescription } from '../api.js';
import type { Submodel } from '../model.js';
import { fill, tr } from '../i18n.js';
import { T } from './T.js';

export type DuplicatePolicy = 'reject' | 'replace' | 'alongside';

interface Props {
  packages: PackageDescription[];
  currentPackageId: string;
  /** Submodels in the current file — to ask what to do when the same name exists */
  existing: readonly Submodel[];
  busy: boolean;
  onCancel: () => void;
  onImport: (sourcePackageId: string, submodelId: string, onDuplicate: DuplicatePolicy) => void;
}

export function ImportSubmodel({
  packages,
  currentPackageId,
  existing,
  busy,
  onCancel,
  onImport,
}: Props): React.JSX.Element {
  const sources = packages.filter((item) => item.packageId !== currentPackageId);
  const [sourceId, setSourceId] = useState(sources[0]?.packageId ?? '');
  const [submodels, setSubmodels] = useState<Submodel[]>([]);
  const [picked, setPicked] = useState('');
  const [onDuplicate, setOnDuplicate] = useState<DuplicatePolicy>('replace');

  const pickedName = submodels.find((item) => item.id === picked)?.idShort;
  const duplicate = pickedName !== undefined && existing.some((item) => item.idShort === pickedName);

  useEffect(() => {
    if (!sourceId) return;
    let alive = true;
    void api.submodels(sourceId).then((result) => {
      if (!alive) return;
      setSubmodels(result.result);
      setPicked(result.result[0]?.id ?? '');
    });
    return () => {
      alive = false;
    };
  }, [sourceId]);

  if (sources.length === 0) {
    return (
      <div className="add-form">
        <h3>{tr('서브모델 가져오기')}</h3>
        <p className="hint">
          {tr('가져올 원본이 없습니다. 검증을 통과한 다른 AASX를 먼저 열어 두십시오.')}
        </p>
        <div className="row-buttons">
          <button onClick={onCancel}>{tr('닫기')}</button>
        </div>
      </div>
    );
  }

  return (
    <div className="add-form">
      <h3>{tr('서브모델 가져오기')}</h3>
      <label>
        {tr('원본 파일')}
        <select value={sourceId} aria-label={tr('원본 파일')} onChange={(event) => setSourceId(event.target.value)}>
          {sources.map((item) => (
            <option key={item.packageId} value={item.packageId}>
              {item.name ?? item.packageId}
            </option>
          ))}
        </select>
      </label>
      <label>
        {tr('서브모델')}
        <select value={picked} aria-label={tr('서브모델')} onChange={(event) => setPicked(event.target.value)}>
          {submodels.map((item) => (
            <option key={item.id} value={item.id}>
              {item.idShort ?? item.id}
            </option>
          ))}
        </select>
      </label>
      <p className="hint">
        {tr('id는 이 파일의 장비명에 맞게 다시 짓고, 쓰이는 ConceptDescription도 함께 가져옵니다.')}
      </p>
      {/* Important: with two of the same name, nobody decides which is the submission — ask before importing */}
      {duplicate && (
        <fieldset className="choice">
          <legend><T k={'이 파일에 이미 「{0}」이(가) 있습니다'} v={[pickedName]} /></legend>
          <label>
            <input
              type="radio"
              name="onDuplicate"
              checked={onDuplicate === 'replace'}
              onChange={() => setOnDuplicate('replace')}
            />
            {tr('바꾸기 — 지금 것을 지우고 가져온 것으로 대체합니다 (지금 것의 값은 사라집니다)')}
          </label>
          <label>
            <input
              type="radio"
              name="onDuplicate"
              checked={onDuplicate === 'alongside'}
              onChange={() => setOnDuplicate('alongside')}
            />
            {fill(tr('나란히 두기 — 「{0}_2」로 가져옵니다 (견줘 보고 하나를 지우십시오)'), { 0: pickedName })}
          </label>
        </fieldset>
      )}
      <div className="row-buttons">
        <button
          className="primary"
          disabled={!picked || busy}
          title={tr('고른 서브모델을 통째로 복사해 옵니다 — id는 이 설비에 맞게 다시 지어지고 용어(CD)도 함께 옵니다')}
          onClick={() => onImport(sourceId, picked, duplicate ? onDuplicate : 'reject')}
        >
          {tr('가져오기')}
        </button>
        <button onClick={onCancel} disabled={busy}>
          {tr('취소')}
        </button>
      </div>
    </div>
  );
}
