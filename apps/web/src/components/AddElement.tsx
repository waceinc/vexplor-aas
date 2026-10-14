/**
 * Add element form.
 *
 * The creatable kinds are narrowed to those KOSMO uses — Operation · BasicEventElement · Capability are
 * kinds this program decided not to use (KOSMO-SME-2), so they cannot be created at all.
 * semanticId is not taken here. Once created, the linter flags it as KOSMO-SME-3,
 * and "Auto fix" attaches one by convention — less hand-typing of IRIs for people.
 */
import { useState } from 'react';
import { tr } from '../i18n.js';
import { T } from './T.js';

/** Parent kinds that can hold a new element */
export const CONTAINER_TYPES = new Set([
  'Submodel',
  'SubmodelElementCollection',
  'SubmodelElementList',
  'Entity',
]);

/**
 * Creatable kinds — listed **in the order they stack in the tree** (user request, 2026-08-26).
 * The real work order is to create a collection (acting as a folder) first and then fill leaves (values) in it,
 * so the picker list must follow that order to avoid confusion. Descriptions are attached so people are not left picking by name alone.
 */
const CREATABLE = [
  ['SubmodelElementCollection', tr('묶음: 요소들을 폴더처럼 담습니다')],
  ['SubmodelElementList', tr('목록: 같은 종류를 순서 있게 담습니다')],
  ['Property', tr('값 하나 (숫자·글자 등)')],
  ['MultiLanguageProperty', tr('여러 언어 글 (한/영 이름·설명)')],
  ['Range', tr('범위: 최소~최대 (온도·압력)')],
  ['File', tr('첨부 파일 (사진·PDF·도면)')],
  /* ReferenceElement was removed (2026-09-04) — even when created, there was no editor on the right to fill the value (reference),
     so an empty shell remained. None of the 20 equipment deliverables use it either. Restore it when an editor exists */
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

  // AASd-002 — at least 2 characters starting with a letter. Blocked here before the linter catches it
  const valid = /^[a-zA-Z][a-zA-Z0-9_-]*[a-zA-Z0-9_]+$/.test(idShort);

  const build = (): Record<string, unknown> => {
    const base: Record<string, unknown> = { modelType, idShort };
    if (modelType === 'Property' || modelType === 'Range') base['valueType'] = valueType;
    if (modelType === 'Property') base['value'] = '';
    if (modelType === 'File') base['contentType'] = 'application/pdf';
    // Important: even for container elements, do not put `value: []`. The official schema does not allow an empty array
    //    (PKG-EMPTY-ARRAY). The server creates and attaches the array when a child is added
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
      {/* Sits on the same screen as the properties panel's "Name (idShort)" (renaming the parent element) — the label says this one is new */}
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
