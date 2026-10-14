/**
 * Concept definition (ConceptDescription) editing — preferredName · definition (en · ko) · dataType · unit.
 * Split out of components/Inspector.tsx (2026-10-13 componentization) — markup and comments were moved verbatim.
 * Values being typed are this part's state. When moving to another element or when a save changes the content, Inspector changes
 * the key and redraws it, so it returns to the initial values (same result as the old "reset when the fingerprint changes").
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
        Important: a CD made by "Auto fix" puts the idShort into definition as is (a placeholder that passes
           KOSMO-CD-3). That sentence lands in the "Definition" column of the documentation material, so a person must fill it —
           yet there was nowhere to fix it, and some people deleted and recreated the CD (measured in an expert demo).
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
