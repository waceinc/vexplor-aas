/**
 * 서브모델 추가.
 *
 * 만들자마자 KOSMO 규칙을 지키도록 기본값을 채운다 — kind=Template(SM-4),
 * semanticId=자기 id(SM-3), administration과 id 접미 일치(SM-2).
 * 규약의 뿌리(iriBase)는 **서버(린터 정책)에서 받아 온다**. UI에 복사해 두면 규칙이 둘이 된다.
 */
import { useState } from 'react';
import type { Policy } from '../api.js';
import { tr } from '../i18n.js';
import { T } from './T.js';

interface Props {
  policy?: Policy;
  /** id를 만들 때 쓰는 장비명 — AAS의 idShort */
  assetName: string;
  /** 지금 파일에 있는 서브모델 이름들 — 같은 이름·9종 초과를 미리 알린다 */
  existing?: readonly string[];
  busy: boolean;
  onCancel: () => void;
  onCreate: (content: Record<string, unknown>) => void;
}

export function AddSubmodel({ policy, assetName, existing = [], busy, onCancel, onCreate }: Props): React.JSX.Element {
  const [idShort, setIdShort] = useState('');
  const [version, setVersion] = useState('1');
  const [revision, setRevision] = useState('0');

  const valid = /^[a-zA-Z][a-zA-Z0-9_-]*[a-zA-Z0-9_]+$/.test(idShort);
  const base = policy?.iriBase ?? '';
  const id = valid ? `${base}/sm/${assetName}/${idShort}/${version}/${revision}` : '';

  const build = (): Record<string, unknown> => ({
    modelType: 'Submodel',
    id,
    idShort,
    kind: 'Template',
    administration: { version, revision },
    semanticId: { type: 'ExternalReference', keys: [{ type: 'GlobalReference', value: id }] },
    // 🔴 `submodelElements: []`를 넣지 않는다 — 공식 스키마가 빈 배열을 허용하지 않는다
    //    (PKG-EMPTY-ARRAY). 요소를 넣을 때 서버가 배열을 만들어 붙인다
  });

  return (
    <div className="add-form">
      <h3>{tr('서브모델 추가')}</h3>
      <label>
        {tr('이름 (idShort)')}
        <input
          value={idShort}
          autoFocus
          onChange={(event) => setIdShort(event.target.value)}
          placeholder={tr('예: RollFormingSafety')}
        />
      </label>
      <label><T k={'버전 · 리비전 (administration){0}'} v={[<span className="pair">
          <input value={version} aria-label="version" onChange={(event) => setVersion(event.target.value)} />
          <input value={revision} aria-label="revision" onChange={(event) => setRevision(event.target.value)} />
        </span>]} />
      </label>
      {id && <p className="mono hint">{id}</p>}
      {policy && policy.requiredSubmodels.includes(idShort) && (
        <p className="hint">{tr('필수 서브모델 4종 중 하나입니다(KOSMO-AAS-4).')}</p>
      )}
      {existing.includes(idShort) && (
        <p className="note warning"><T k={'이미 「{0}」이(가) 있습니다 — 같은 이름이 둘이면 어느 것이 맞는 것인지 정해지지 않습니다.'} v={[idShort]} /></p>
      )}
      {existing.length >= 8 && (
        <p className="note warning"><T k={'지금 {0}종입니다 — 하나 더 넣으면 KOSMO 상한(8종)을 넘어 위반(KOSMO-AAS-4)이 됩니다.'} v={[existing.length]} /></p>
      )}
      <div className="row-buttons">
        <button
          className="primary"
          disabled={!valid || busy || !policy}
          title={tr('이 설비에 서브모델을 새로 만듭니다 — id는 규약대로 지어집니다')}
          onClick={() => onCreate(build())}
        >
          {tr('추가')}
        </button>
        <button onClick={onCancel} disabled={busy}>
          {tr('취소')}
        </button>
      </div>
    </div>
  );
}
