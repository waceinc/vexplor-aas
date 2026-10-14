/** English dictionary - core. Key = the Korean source text verbatim, value = English. Placeholders ({0}, <b>) must match the source exactly */
export const EN_CORE: Record<string, string> = {
  // ── json/deserialize.ts — reading AAS JSON ──
  'AAS JSON 파싱 실패 ({0}건)': 'AAS JSON parsing failed ({0} issues)',
  'SubmodelElement는 객체여야 합니다.': 'A SubmodelElement must be an object.',
  'modelType이 없습니다.': 'modelType is missing.',
  '알 수 없는 modelType입니다: {0}': 'Unknown modelType: {0}',
  '{0}는 배열이어야 합니다.': '{0} must be an array.',
  '{0}는 객체여야 합니다.': '{0} must be an object.',
  'id가 없습니다. Identifiable은 전역 id가 필수입니다.': 'id is missing. An Identifiable must have a global id.',
  'modelType 불일치: {0} (기대값 {1})': 'modelType mismatch: {0} (expected {1})',
  '최상위는 객체여야 합니다.': 'The top level must be an object.',
  'submodelElements는 배열이어야 합니다.': 'submodelElements must be an array.',
  // ── pointer.ts ──
  'JSON Pointer는 /로 시작해야 합니다: {0}': 'A JSON Pointer must start with /: {0}',
};
