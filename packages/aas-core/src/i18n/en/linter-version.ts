/** English dictionary — linter checks that depend on the metamodel version (3.0 · 3.1 · 3.2). Key = the original Korean text verbatim, value = English. Placeholders ({0} · <b>) must match the original exactly */
export const EN_LINTER_VERSION: Record<string, string> = {
  // ── PKG-FILE-URI ──
  'File.value 형식 — 3.0 은 file:// URI, 3.1 이상은 공식 스키마의 URI-reference(상대경로 포함)':
    'Form of File.value — a file:// URI in 3.0; from 3.1 a URI reference as the official schema defines it (relative paths included)',
  '{0} · 3.1 / 3.2 공식 JSON 스키마 PathType 패턴':
    '{0} · PathType pattern of the official 3.1 / 3.2 JSON schemas',
  'File.value에 URI에 쓸 수 없는 글자(공백 · 한글 등)가 있습니다: {0}':
    'File.value contains characters a URI cannot hold (spaces, non-ASCII letters): {0}',
  '메타모델 3.1 이상 스키마는 File.value를 URI 형식으로 받습니다. 내보낼 때 해당 글자를 퍼센트 인코딩(공백 → %20, 한글 → %ED%95%9C …)하면 됩니다. 패키지 안 파일 이름도 같은 이름으로 맞춰야 합니다.':
    'From metamodel 3.1 the schema takes File.value as a URI. Percent-encode those characters on export (space → %20, non-ASCII letters → their UTF-8 bytes such as %ED%95%9C). The file name inside the package must match the encoded name.',
  '경로 구분자는 /로 쓰십시오(역슬래시는 URI에서 폴더를 나누지 않습니다). 예: /aasx/files/manual.pdf':
    'Separate folders with / (a backslash does not separate folders in a URI). Example: /aasx/files/manual.pdf',
  '메타모델 3.1 이상 공식 스키마의 URI-reference 형식으로 고치십시오. 예: /aasx/files/manual.pdf · ./manual.pdf · file:///aasx/files/manual.pdf':
    'Rewrite it as a URI reference of the official metamodel 3.1+ schema. Examples: /aasx/files/manual.pdf · ./manual.pdf · file:///aasx/files/manual.pdf',

  // ── PKG-MM-VERSION ──
  '선언한 메타모델 판이 파일 내용을 담을 수 있어야 한다 — 3.0 선언 파일에 3.2 의 Batch · createdAt 등':
    'The declared metamodel version must be able to hold the content — e.g. a 3.2 Batch or createdAt in a file declared 3.0',
  '메타모델 V{0} 스키마가 받지 않는 값입니다: {1} = {2} (V{3} 까지만 허용)':
    'The metamodel V{0} schema does not accept this value: {1} = {2} (allowed up to V{3} only)',
  '값을 V{0} 에 맞게 고치거나 파일을 V{1} 로 내보내십시오.':
    'Change the value to fit V{0}, or export the file as V{1}.',
  '메타모델 V{0} 에서는 {1} 이(가) 필수인데 없습니다 (V{2} 부터 선택 항목).':
    '{1} is required in metamodel V{0} but missing (optional from V{2}).',
  '{0} 을(를) 채우거나 파일을 V{1} 이상으로 내보내십시오.':
    'Fill in {0}, or export the file as V{1} or later.',
  '메타모델 V{0} 파일에는 쓸 수 없는 값입니다: {1} = {2} (V{3} 부터)':
    'This value cannot appear in a metamodel V{0} file: {1} = {2} (available from V{3})',
  '파일을 V{0} 이상으로 내보내거나, V{1} 에 맞게 값을 고치십시오.':
    'Export the file as V{0} or later, or change the value to fit V{1}.',

  // ── AASd-090 · AASd-120 (3.0 only) ──
  'AAS 메타모델 V3.0 AASd-120 (aas-core-meta v3) · aas-test-engines 1.0.3 실측 — 3.0 파일만. V3.1 에서 삭제 (IDTA-01001 V3.2 변경 기록)':
    'AAS metamodel V3.0 AASd-120 (aas-core-meta v3) · measured with aas-test-engines 1.0.3 — 3.0 files only. Removed in V3.1 (IDTA-01001 V3.2 change notes)',
  '파일에 메타모델 판 표시가 없어 내용으로 3.0 이라고 보고 검사했습니다. 3.1 이상 파일에는 이 제약이 없습니다.':
    'The file carries no metamodel version, and its content reads as 3.0, so it was checked as 3.0. Files of version 3.1 or later do not have this constraint.',
  'AAS 메타모델 V3.0 AASd-090 (aas-core-meta v3) — 3.0 파일만. V3.1 에서 삭제 (IDTA-01001 V3.2 변경 기록)':
    'AAS metamodel V3.0 AASd-090 (aas-core-meta v3) — 3.0 files only. Removed in V3.1 (IDTA-01001 V3.2 change notes)',

  // ── AASd-137 · AASd-138 (new in 3.2) ──
  'ExternalReference 의 어느 키도 AAS 요소 종류(AasReferables)일 수 없다 — 메타모델 3.2':
    'No key of an ExternalReference may be an AAS element kind (AasReferables) — metamodel 3.2',
  '{0} 제약 AASd-137 (변경 기록 #592) — 3.2 파일만':
    '{0} constraint AASd-137 (change note #592) — 3.2 files only',
  'ExternalReference 의 {0}번째 키 타입이 AAS 요소 종류입니다: {1}':
    'Key {0} of the ExternalReference is an AAS element kind: {1}',
  '바깥 대상을 가리키는 참조의 키는 GlobalReference(또는 마지막 자리의 FragmentReference)만 쓸 수 있습니다(AASd-137). AAS 안의 요소를 가리키려면 ModelReference 로 바꾸십시오.':
    'A reference to something outside the AAS may only use GlobalReference keys (or FragmentReference as the last key) (AASd-137). To point at an element inside an AAS, make it a ModelReference.',
  'Template 서브모델 · Operation 변수 안의 SubmodelElementList 는 요소를 정확히 1개 가진다 — 메타모델 3.2':
    'A SubmodelElementList in a Template submodel or an Operation variable has exactly one element — metamodel 3.2',
  '{0} 제약 AASd-138 (변경 기록 #462) — 3.2 파일만':
    '{0} constraint AASd-138 (change note #462) — 3.2 files only',
  'Template 이나 Operation 변수 안의 SubmodelElementList 에 요소가 {0}개 있습니다 — 정확히 1개여야 합니다.':
    'The SubmodelElementList in a Template or an Operation variable has {0} elements — it must have exactly one.',
  '서식(Template)의 리스트는 항목 모양을 보여 주는 견본 1개만 둡니다(AASd-138). 실제 값을 여러 개 넣을 것이면 서브모델 kind 를 Instance 로 바꾸십시오.':
    'A list in a template holds a single sample showing the shape of its items (AASd-138). To hold several real values, change the submodel kind to Instance.',

  // ── DPP-5 (Batch pair, 3.2) ──
  '제품 여권 단위(granularity)와 AAS 의 assetKind 가 짝이 맞는다 — Model 은 Type, Item 은 Instance, Batch 는 Batch(메타모델 3.2)':
    'The product passport granularity matches the AAS assetKind — Model is Type, Item is Instance, Batch is Batch (metamodel 3.2)',
  '모델 단위 여권이면 assetKind 를 Type, 낱개 단위면 Instance, 묶음(Batch) 단위면 Batch 로 맞추거나, 여권 단위 값을 고치십시오.':
    'Set assetKind to Type for a model passport, Instance for an item passport or Batch for a batch passport — or correct the granularity.',

  // ── rule catalog ──
  'AAS 메타모델 규격(V3.0 · V3.1 · V3.2)이 정한 제약. 파일의 판을 기준으로 검사하며, 표준 도구(aas-test-engines·BaSyx)가 강제한다':
    'Constraints set by the AAS metamodel specification (V3.0 · V3.1 · V3.2). Checked against the version of the file; standard tools (aas-test-engines, BaSyx) enforce them',

  // ── idShort pattern of 3.0 ──
  '영문자로 시작하고 영문자 · 숫자 · 밑줄(_)만 쓰십시오. 메타모델 3.0 은 하이픈(-)을 받지 않습니다 — 하이픈을 쓰려면 파일을 3.1 이상으로 내보내십시오.':
    'Start with a letter and use only letters, digits and underscores (_). Metamodel 3.0 does not accept hyphens (-) — to use one, export the file as 3.1 or later.',
};
