/** English dictionary — linter DPP rules (IDTA 02099-1). Key = the original Korean text verbatim, value = English. Placeholders ({0} · <b>) must match the original exactly */
export const EN_LINTER_DPP: Record<string, string> = {
  '제품 여권(DPP) 필수 항목 — 여권 ID · 제품 식별자 · 단위 · 스키마 판 · 상태 · 갱신 시각 · 경제 주체 ID 가 있고 비어 있지 않다':
    'Product passport (DPP) required data — passport ID, product identifier, granularity, schema version, status, last update and economic operator ID are present and not blank',
  '제품 여권 필수 항목 {0} 이(가) 없습니다.':
    'The required product passport element {0} is missing.',
  'IDTA 02099-1 서식대로 Property {0} (semanticId {1}) 를 넣으십시오.':
    'Add the Property {0} (semanticId {1}) as the IDTA 02099-1 template defines it.',
  '제품 여권 항목 {0} 은(는) Property 여야 하는데 {1} 입니다.':
    'The product passport element {0} must be a Property but is a {1}.',
  'IDTA 02099-1 서식의 항목 종류(Property)로 바꾸십시오.':
    'Change it to the element kind of the IDTA 02099-1 template (Property).',
  '제품 여권 필수 항목 {0} 이(가) 비어 있습니다 — 서식(Template)이라 지금은 경고지만, 여권을 내기 전에 채워야 합니다.':
    'The required product passport value {0} is blank — a warning for now because this is a template, but it must be filled before the passport is issued.',
  '제품 여권 필수 항목 {0} 이(가) 비어 있습니다.':
    'The required product passport value {0} is blank.',
  '값을 채우십시오. 이 항목이 비어 있으면 여권을 낼 수 없습니다(카디널리티 One).':
    'Fill in the value. A passport cannot be issued while this element is blank (cardinality One).',
  '제품 여권 단위(granularity)는 Model · Item · Batch 중 하나다':
    'The product passport granularity is one of Model, Item or Batch',
  '제품 여권 단위(granularity) 값이 정해진 값이 아닙니다: {0}':
    'The product passport granularity is not one of the defined values: {0}',
  'Model(모델 전체) · Batch(같은 공장 · 같은 때 만든 묶음) · Item(낱개) 중 하나를 대소문자 그대로 적으십시오.':
    'Write one of Model (the whole model), Batch (made in the same plant at the same time) or Item (a single unit), with exactly this capitalization.',
  '제품 여권 갱신 시각(lastUpdate)은 UTC 기준 ISO 8601 시각이다':
    'The product passport last update (lastUpdate) is an ISO 8601 timestamp in UTC',
  '제품 여권 갱신 시각(lastUpdate)이 UTC 기준 ISO 8601 시각이 아닙니다: {0}':
    'The product passport last update (lastUpdate) is not an ISO 8601 timestamp in UTC: {0}',
  '2025-08-22T03:12:00Z 처럼 날짜와 시각 사이에 T 를 넣고 끝에 Z(협정 세계시)를 붙이십시오. 한국 시각이면 9시간을 빼서 적습니다.':
    'Write it like 2025-08-22T03:12:00Z — a T between date and time and a Z (Coordinated Universal Time) at the end. Convert local time to UTC first (for Korean time, subtract 9 hours).',
  '제품 여권 내용 명세 목록(contentSpecificationIds)을 넣었다면 비어 있지 않은 항목이 하나 이상 있다':
    'If the product passport content specification list (contentSpecificationIds) is present, it has at least one non-blank entry',
  '제품 여권 내용 명세 목록(contentSpecificationIds)에 항목이 하나도 없습니다.':
    'The product passport content specification list (contentSpecificationIds) has no entries.',
  '이 여권을 이루는 서브모델 서식의 semanticId 를 하나 이상 넣거나, 쓰지 않으면 목록 자체를 지우십시오(0..1).':
    'Add at least one semanticId of the submodel templates that make up this passport, or remove the list if it is not used (0..1).',
  '제품 여권 내용 명세 목록(contentSpecificationIds)의 {0}번째 항목이 비어 있습니다.':
    'Entry {0} of the product passport content specification list (contentSpecificationIds) is blank.',
  '이 여권을 이루는 서브모델 서식의 semanticId 를 적으십시오(예: https://admin-shell.io/idta/CarbonFootprint/1/0).':
    'Write the semanticId of a submodel template that makes up this passport (e.g. https://admin-shell.io/idta/CarbonFootprint/1/0).',
  '제품 여권 단위는 {0} 인데 AAS 의 assetKind 는 {1} 입니다 — 규격은 {0} 을(를) {2} 와(과) 짝지웁니다.':
    'The product passport granularity is {0} but the AAS assetKind is {1} — the specification maps {0} to {2}.',
};
