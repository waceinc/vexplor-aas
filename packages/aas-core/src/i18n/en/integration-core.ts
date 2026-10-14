/** English dictionary — integration contracts (config validation, shared store errors). Key = the original Korean text verbatim */
export const EN_INTEGRATION_CORE: Record<string, string> = {
  // ── config validation (integration/config.ts) ──
  '객체여야 합니다.': 'Must be an object.',
  '알 수 없는 항목입니다.': 'Unknown field.',
  '필수 항목입니다.': 'Required.',
  '비어 있지 않은 문자열이어야 합니다.': 'Must be a non-empty string.',
  '{0}자 이하여야 합니다.': 'Must be at most {0} characters.',
  '{0}~{1} 사이의 정수여야 합니다.': 'Must be an integer from {0} to {1}.',
  '유한한 숫자여야 합니다.': 'Must be a finite number.',
  '0보다 큰 정수여야 합니다.': 'Must be an integer greater than 0.',
  '0보다 큰 숫자여야 합니다.': 'Must be a number greater than 0.',
  '0 이상의 숫자여야 합니다.': 'Must be a number of 0 or more.',
  '다음 중 하나여야 합니다: {0}': 'Must be one of: {0}',
  '배열이어야 합니다.': 'Must be an array.',
  '항목은 {0}개 이하여야 합니다.': 'At most {0} items are allowed.',
  'ID는 영문자 또는 숫자로 시작하고 영문자, 숫자, 점, 밑줄, 하이픈만 쓸 수 있습니다(64자 이하).':
    'An ID starts with a letter or digit and uses only letters, digits, dots, underscores and hyphens (64 characters or fewer).',
  '같은 ID가 이미 있습니다: {0}': 'Duplicate ID: {0}',
  '같은 값이 두 상태에 들어 있습니다: {0} ({1}, {2})': 'The same value is listed under two states: {0} ({1}, {2})',
  '"{0}"이어야 합니다.': 'Must be "{0}".',
  '12자리 16진수(소문자)여야 합니다.': 'Must be 12 lowercase hexadecimal characters.',
  '알 수 없는 시간대입니다: {0}': 'Unknown time zone: {0}',
  '같은 이름이 이미 있습니다: {0}': 'Duplicate name: {0}',
  '시작 시각과 끝 시각이 같습니다.': 'The start and end times are the same.',
  '시각은 HH:MM 형식(00:00~23:59)이어야 합니다.': 'Times must use the HH:MM format (00:00 to 23:59).',
  '"{0}"은(는) 예약된 ID입니다.': '"{0}" is a reserved ID.',
  '노드 경로가 비어 있습니다.': 'The node path is empty.',
  '값이 하나 이상 있어야 합니다.': 'At least one value is required.',
  '"truthy" 또는 equals 목록이어야 합니다.': 'Must be "truthy" or an equals list.',
  // ── store contract errors (packages/store/src/integration-types.ts) ──
  '외부 참조가 이미 다른 대상에 연결되어 있습니다: {0}': 'An external reference is already linked to another subject: {0}',
};
