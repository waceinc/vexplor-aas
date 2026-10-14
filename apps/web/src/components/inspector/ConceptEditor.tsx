/**
 * 용어 정의(ConceptDescription) 편집 — preferredName · definition(en·ko) · dataType · unit.
 * components/Inspector.tsx 에서 떼어 냈다(2026-10-13 컴포넌트화) — 마크업·주석은 옮기기 전 글자 그대로다.
 * 입력 중인 값은 이 부품의 상태다. 다른 요소로 옮기거나 저장으로 내용이 바뀌면 Inspector 가 key 를 바꿔
 * 새로 그리므로 처음 값으로 돌아간다(예전 「지문이 바뀌면 초기화」 효과와 같은 결과).
 */
import { useState } from 'react';
import { IEC61360_DATA_TYPES, readConcept, writeConcept, type ConceptForm } from './conceptForm.js';

interface Props {
  raw: Record<string, unknown>;
  busy: boolean;
  onSaveConcept: (concept: Record<string, unknown>) => void;
  t: (text: string) => string;
}

export function ConceptEditor({ raw, busy, onSaveConcept, t }: Props): React.JSX.Element {
  const [concept, setConcept] = useState<ConceptForm>(() => readConcept(raw));
  return (
    <div className="editor">
      {/*
        🔴 「자동 고치기」가 만든 CD는 definition에 idShort를 그대로 넣는다(KOSMO-CD-3을 넘기는
           자리 채움). 그 문장이 문서용 자료의 「정의」 열에 실리므로 사람이 채워야 한다 —
           그런데 고칠 자리가 없어 CD를 지우고 다시 만드는 사람이 있었다(전문가 시연 실측).
      */}
      {concept.definitionEn.trim() !== '' &&
        concept.definitionEn.trim() === String(raw['idShort'] ?? '').trim() && (
          <p className="note warning">
            {t('정의가 idShort와 같습니다 — 도구가 임시로 채운 것입니다. 뜻풀이를 적어 주십시오.')}
          </p>
        )}
      <label className="stack">
        preferredName (en)
        <input
          value={concept.preferredNameEn}
          aria-label="preferredName (en)"
          onChange={(event) => setConcept({ ...concept, preferredNameEn: event.target.value })}
        />
      </label>
      <label className="stack">
        {t('definition (en) — KOSMO-CD-3 필수')}
        <textarea
          value={concept.definitionEn}
          aria-label="definition (en)"
          rows={2}
          onChange={(event) => setConcept({ ...concept, definitionEn: event.target.value })}
        />
      </label>
      <label className="stack">
        {t('definition (ko) — 문서용, 비워도 됨')}
        <textarea
          value={concept.definitionKo}
          aria-label="definition (ko)"
          rows={2}
          onChange={(event) => setConcept({ ...concept, definitionKo: event.target.value })}
        />
      </label>
      <div className="row">
        <label className="stack">
          dataType
          <select
            value={concept.dataType}
            aria-label="dataType"
            onChange={(event) => setConcept({ ...concept, dataType: event.target.value })}
          >
            <option value="">{t('(없음)')}</option>
            {IEC61360_DATA_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </label>
        <label className="stack">
          unit
          <input
            value={concept.unit}
            aria-label="unit"
            placeholder={t('예: mm · kg · °C')}
            onChange={(event) => setConcept({ ...concept, unit: event.target.value })}
          />
        </label>
      </div>
      <button
        className="primary"
        disabled={busy || concept.definitionEn.trim() === ''}
        title={concept.definitionEn.trim() === '' ? t('영문 정의가 비면 KOSMO-CD-3 위반입니다') : undefined}
        onClick={() => onSaveConcept(writeConcept(raw, concept))}
      >
        {t('저장')}
      </button>
    </div>
  );
}
