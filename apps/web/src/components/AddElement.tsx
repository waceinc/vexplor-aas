/**
 * 요소 추가 폼.
 *
 * 만들 수 있는 종류를 KOSMO가 쓰는 것으로 좁혔다 — Operation·BasicEventElement·Capability는
 * 본 사업에서 쓰지 않기로 한 종류라(KOSMO-SME-2) 애초에 만들 수 없게 둔다.
 * semanticId는 여기서 받지 않는다. 만들면 린터가 KOSMO-SME-3으로 지적하고,
 * 「자동 고치기」가 규약대로 붙여 준다 — 사람이 IRI를 손으로 적는 일을 줄인다.
 */
import { useState } from 'react';
import { tr } from '../i18n.js';
import { T } from './T.js';

/** 새 요소를 담을 수 있는 부모 종류 */
export const CONTAINER_TYPES = new Set([
  'Submodel',
  'SubmodelElementCollection',
  'SubmodelElementList',
  'Entity',
]);

/**
 * 만들 수 있는 종류 — **트리에 쌓이는 순서**로 늘어놓는다(2026-08-26 사용자 요청).
 * 먼저 묶음(폴더 역할)을 만들고 그 안에 잎(값)을 채우는 것이 실제 작업 순서라,
 * 고르는 목록도 그 순서여야 헤매지 않는다. 설명을 붙여 이름만으로 못 고르는 일을 줄인다.
 */
const CREATABLE = [
  ['SubmodelElementCollection', tr('묶음: 요소들을 폴더처럼 담습니다')],
  ['SubmodelElementList', tr('목록: 같은 종류를 순서 있게 담습니다')],
  ['Property', tr('값 하나 (숫자·글자 등)')],
  ['MultiLanguageProperty', tr('여러 언어 글 (한/영 이름·설명)')],
  ['Range', tr('범위: 최소~최대 (온도·압력)')],
  ['File', tr('첨부 파일 (사진·PDF·도면)')],
  /* ReferenceElement는 뺐다(2026-09-04) — 만들어도 오른쪽에 value(참조)를 채울 편집기가 없어
     빈 껍데기가 남았다. 설비 20종 산출물에도 쓰인 곳이 없다. 편집기가 생기면 되살린다 */
] as const;

const VALUE_TYPES = [
  ['xs:string', tr('글자')],
  ['xs:boolean', tr('참/거짓')],
  ['xs:int', tr('정수')],
  ['xs:double', tr('소수')],
  ['xs:date', tr('날짜')],
  ['xs:dateTime', tr('날짜+시각')],
  ['xs:anyURI', tr('주소 (URL·IRI)')],
] as const;

type CreatableType = (typeof CREATABLE)[number][0];
type ValueType = (typeof VALUE_TYPES)[number][0];

interface Props {
  parentLabel: string;
  busy: boolean;
  onCancel: () => void;
  onCreate: (content: Record<string, unknown>) => void;
}

export function AddElement({ parentLabel, busy, onCancel, onCreate }: Props): React.JSX.Element {
  const [modelType, setModelType] = useState<CreatableType>('Property');
  const [idShort, setIdShort] = useState('');
  const [valueType, setValueType] = useState<ValueType>('xs:string');

  // AASd-002 — 영문자로 시작하는 2자 이상. 린터가 잡기 전에 여기서 막는다
  const valid = /^[a-zA-Z][a-zA-Z0-9_-]*[a-zA-Z0-9_]+$/.test(idShort);

  const build = (): Record<string, unknown> => {
    const base: Record<string, unknown> = { modelType, idShort };
    if (modelType === 'Property' || modelType === 'Range') base['valueType'] = valueType;
    if (modelType === 'Property') base['value'] = '';
    if (modelType === 'File') base['contentType'] = 'application/pdf';
    // 🔴 담는 요소라도 `value: []`를 넣지 않는다. 공식 스키마는 빈 배열을 허용하지 않는다
    //    (PKG-EMPTY-ARRAY). 자식을 넣을 때 서버가 배열을 만들어 붙인다
    if (modelType === 'SubmodelElementList') {
      base['typeValueListElement'] = 'SubmodelElementCollection';
    }
    return base;
  };

  return (
    <div className="add-form">
      <h3><T k={'{0} 아래에 추가'} v={[parentLabel]} /></h3>
      <label>
        {tr('종류')}
        <select value={modelType} onChange={(event) => setModelType(event.target.value as typeof modelType)}>
          {CREATABLE.map(([type, description]) => (
            <option key={type} value={type}>
              {type} — {description}
            </option>
          ))}
        </select>
      </label>
      {/* 속성 칸의 「이름 (idShort)」(부모 요소의 이름 바꾸기)와 같은 화면에 선다 — 새것임을 라벨에 적는다 */}
      <label>
        {tr('새 요소 이름 (idShort)')}
        <input
          value={idShort}
          autoFocus
          onChange={(event) => setIdShort(event.target.value)}
          placeholder={tr('CamelCase 영문')}
        />
      </label>
      {(modelType === 'Property' || modelType === 'Range') && (
        <label>
          valueType
          <select value={valueType} onChange={(event) => setValueType(event.target.value as typeof valueType)}>
            {VALUE_TYPES.map(([type, description]) => (
              <option key={type} value={type}>
                {type} — {description}
              </option>
            ))}
          </select>
        </label>
      )}
      {idShort !== '' && !valid && (
        <p className="warn">{tr('영문자로 시작하는 2자 이상이어야 합니다(AASd-002).')}</p>
      )}
      <p className="hint">
        {tr('semanticId는 붙이지 않습니다. 만든 뒤 린터가 지적하면 「자동 고치기」가 규약대로 채웁니다.')}
      </p>
      <div className="row-buttons">
        <button
          className="primary"
          disabled={!valid || busy}
          title={tr('고른 종류로 요소를 만들어 지금 자리에 넣습니다')}
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
