/** English dictionary - core. Key = the Korean source text verbatim, value = English. Placeholders ({0}, <b>) must match the source exactly */
export const EN_CORE: Record<string, string> = {
  // ── json/deserialize.ts — reading AAS JSON ──
  'AAS JSON 파싱 실패 ({0}건)': 'AAS JSON parsing failed ({0} issues)',
  '요소가 너무 깊게 겹쳐 있습니다 — {0}단계까지 받습니다.':
    'Elements are nested too deeply — up to {0} levels are accepted.',
  'SubmodelElement는 객체여야 합니다.': 'A SubmodelElement must be an object.',
  'modelType이 없습니다.': 'modelType is missing.',
  '알 수 없는 modelType입니다: {0}': 'Unknown modelType: {0}',
  '{0}는 배열이어야 합니다.': '{0} must be an array.',
  '{0}는 객체여야 합니다.': '{0} must be an object.',
  'id가 없습니다. Identifiable은 전역 id가 필수입니다.': 'id is missing. An Identifiable must have a global id.',
  'modelType 불일치: {0} (기대값 {1})': 'modelType mismatch: {0} (expected {1})',
  '최상위는 객체여야 합니다.': 'The top level must be an object.',
  'submodelElements는 배열이어야 합니다.': 'submodelElements must be an array.',
  // ── metamodel/convert.ts — writing an older metamodel version ──
  'V{0}으로 쓸 수 없는 값이 {1}건 있습니다.': '{1} value(s) cannot be written as V{0}.',
  'V{0}으로 쓰면 빠지는 칸이 {1}건 있습니다 — 보고서를 함께 받는 쓰기로 저장하십시오.':
    'Writing V{0} would remove {1} field(s) — save with a write that returns the report.',
  '{field}는 V{since}에서 생긴 칸이라 V{target}에는 없습니다 — 뺐고, 값은 이 보고서에 남겼습니다.':
    '{field} was introduced in V{since} and does not exist in V{target} — removed; the value is kept in this report.',
  '단위 데이터 사양(DataSpecificationUom)은 V{since}에서 생겨 V{target}에는 없습니다 — 이 사양 항목을 뺐고, 내용은 이 보고서에 남겼습니다.':
    'The unit-of-measure data specification (DataSpecificationUom) was introduced in V{since} and does not exist in V{target} — this entry was removed; its content is kept in this report.',
  'assetKind {value}는 V{since}에서 생긴 값이라 V{target}에는 없습니다. 다른 값으로 바꾸면 자산의 성격이 달라집니다.':
    'assetKind {value} was introduced in V{since} and does not exist in V{target}. Replacing it with another value would change what the asset is.',
  'entityType이 없습니다. V{since}부터는 비워 둘 수 있지만 V{target}에서는 필수이고, 대신 넣을 값을 알 수 없습니다.':
    'entityType is missing. It is optional from V{since} but required in V{target}, and there is no way to know which value to put in.',
  '{field}가 없습니다. V{since}부터는 비워 둘 수 있지만 V{target}에서는 필수이고, 가리킬 대상을 지어낼 수 없습니다.':
    '{field} is missing. It is optional from V{since} but required in V{target}, and a target cannot be made up.',
  'contentType이 없습니다. V{since}부터는 비워 둘 수 있지만 V{target}에서는 필수이고, 파일 형식을 짐작해 넣을 수 없습니다.':
    'contentType is missing. It is optional from V{since} but required in V{target}, and the file type cannot be guessed.',
  'contentType이 100자를 넘습니다. V{since}부터 128자까지 되지만 V{target}은 100자까지입니다.':
    'contentType is longer than 100 characters. V{since} allows up to 128, V{target} only 100.',
  'idShort {value}에 하이픈(-)이 있습니다. V{since}부터 되지만 V{target}에서는 안 됩니다. 이름을 바꾸면 이 요소를 가리키는 참조가 끊깁니다.':
    'idShort {value} contains a hyphen (-). Allowed from V{since}, not in V{target}. Renaming it would break the references that point to this element.',
  '{field}가 2000자를 넘습니다. V{since}부터 2048자까지 되지만 V{target}은 2000자까지이고, 자르면 다른 식별자가 됩니다.':
    '{field} is longer than 2000 characters. V{since} allows up to 2048, V{target} only 2000, and shortening it would make it a different identifier.',
  '값 목록 항목에 valueId가 없습니다. V{since}부터는 비워 둘 수 있지만 V{target}에서는 필수입니다.':
    'A value list entry has no valueId. It is optional from V{since} but required in V{target}.',
  'idShort {value}는 한 글자입니다. V3.0에서는 되지만 V{target}은 두 글자 이상이어야 합니다. 이름을 바꾸면 이 요소를 가리키는 참조가 끊깁니다.':
    'idShort {value} is a single character. V3.0 allows it, V{target} needs at least two. Renaming it would break the references that point to this element.',
  '{field} {value}는 URI 형식이 아닙니다(공백 · 한글 등). V3.0에서는 되지만 V{target}은 RFC 3986 형식만 받습니다. 바꾸면 패키지 안의 파일 이름과 어긋납니다.':
    '{field} {value} is not a URI (spaces, non-ASCII letters, …). V3.0 allows it, V{target} only accepts RFC 3986 references. Changing it would no longer match the file name inside the package.',
  '{field}에 XML에서 쓸 수 없는 제어 문자가 있습니다. V3.0에서는 되지만 V{target}에서는 안 됩니다.':
    '{field} contains control characters XML does not allow. V3.0 accepts them, V{target} does not.',
  // ── pointer.ts ──
  'JSON Pointer는 /로 시작해야 합니다: {0}': 'A JSON Pointer must start with /: {0}',
};
