/**
 * 용어 정의(ConceptDescription · IEC 61360) 입력 양식과 CD 사이의 변환.
 * components/Inspector.tsx 에서 떼어 냈다(2026-10-13 컴포넌트화) — 코드는 옮기기 전 글자 그대로다.
 */
/** IEC 61360 dataType — 규격 열거값 중 산출물에서 쓰인 것들 */
export const IEC61360_DATA_TYPES = [
  'STRING',
  'STRING_TRANSLATABLE',
  'INTEGER_MEASURE',
  'INTEGER_COUNT',
  'INTEGER_CURRENCY',
  'REAL_MEASURE',
  'REAL_COUNT',
  'REAL_CURRENCY',
  'BOOLEAN',
  'DATE',
  'TIME',
  'TIMESTAMP',
  'IRI',
  'IRDI',
  'RATIONAL',
  'RATIONAL_MEASURE',
  'FILE',
  'BLOB',
  'HTML',
] as const;

export interface ConceptForm {
  preferredNameEn: string;
  definitionEn: string;
  definitionKo: string;
  dataType: string;
  unit: string;
}
export const EMPTY_CONCEPT: ConceptForm = { preferredNameEn: '', definitionEn: '', definitionKo: '', dataType: '', unit: '' };

const IEC61360_SPEC = 'http://admin-shell.io/DataSpecificationTemplates/DataSpecificationIEC61360/3/0';

function iec61360Content(raw: Record<string, unknown>): Record<string, unknown> | undefined {
  const specs = raw['embeddedDataSpecifications'] as
    | { dataSpecificationContent?: Record<string, unknown> }[]
    | undefined;
  return specs?.[0]?.dataSpecificationContent;
}

function langText(list: unknown, language: string): string {
  if (!Array.isArray(list)) return '';
  const hit = (list as { language?: string; text?: string }[]).find((e) => e.language === language);
  return hit?.text ?? '';
}

export function readConcept(raw: Record<string, unknown>): ConceptForm {
  const content = iec61360Content(raw);
  if (!content) return EMPTY_CONCEPT;
  return {
    preferredNameEn: langText(content['preferredName'], 'en'),
    definitionEn: langText(content['definition'], 'en'),
    definitionKo: langText(content['definition'], 'ko'),
    dataType: String(content['dataType'] ?? ''),
    unit: String(content['unit'] ?? ''),
  };
}

/** 폼 값을 CD에 되쓴다. 손대지 않은 언어·필드는 그대로 두고, 빈 값은 키를 지운다(빈 문자열을 남기지 않는다) */
export function writeConcept(raw: Record<string, unknown>, form: ConceptForm): Record<string, unknown> {
  const next = structuredClone(raw) as Record<string, unknown>;
  let specs = next['embeddedDataSpecifications'] as
    | { dataSpecification?: unknown; dataSpecificationContent?: Record<string, unknown> }[]
    | undefined;
  if (!Array.isArray(specs) || specs.length === 0) {
    specs = [
      {
        dataSpecification: { type: 'ExternalReference', keys: [{ type: 'GlobalReference', value: IEC61360_SPEC }] },
        dataSpecificationContent: { modelType: 'DataSpecificationIec61360' },
      },
    ];
    next['embeddedDataSpecifications'] = specs;
  }
  const content = (specs[0]!.dataSpecificationContent ??= { modelType: 'DataSpecificationIec61360' });
  const setLang = (key: string, language: string, text: string): void => {
    const list = (Array.isArray(content[key]) ? content[key] : []) as { language: string; text: string }[];
    const rest = list.filter((e) => e.language !== language);
    const trimmed = text.trim();
    const merged = trimmed === '' ? rest : [...rest, { language, text: trimmed }];
    // en을 앞에 — 표준 도구·문서 자료가 첫 항목을 대표로 읽는다
    merged.sort((a, b) => (a.language === 'en' ? -1 : b.language === 'en' ? 1 : 0));
    if (merged.length === 0) delete content[key];
    else content[key] = merged;
  };
  setLang('preferredName', 'en', form.preferredNameEn);
  setLang('definition', 'en', form.definitionEn);
  setLang('definition', 'ko', form.definitionKo);
  if (form.dataType === '') delete content['dataType'];
  else content['dataType'] = form.dataType;
  if (form.unit.trim() === '') delete content['unit'];
  else content['unit'] = form.unit.trim();
  return next;
}
