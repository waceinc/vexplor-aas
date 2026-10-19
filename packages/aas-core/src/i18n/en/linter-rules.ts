/** English dictionary — linter-rules. Key = the original Korean text verbatim, value = English. Placeholders ({0} · <b>) must match the original exactly */
export const EN_LINTER_RULES: Record<string, string> = {
  'File.value가 URI 형식이 아닙니다: {0}':
    'File.value is not a URI: {0}',
  'file:///파일명 형태로 바꾸십시오. 단순 상대경로는 공식 스키마 위반이며, ArrayItemNotValid로 상위 SMC·Submodel까지 연쇄 실패 표시를 유발합니다.':
    'Change it to the form file:///filename. A plain relative path violates the official schema and, via ArrayItemNotValid, makes the parent SMC and Submodel show cascading failures.',
  '썸네일은 파트 · 관계 · Content_Types 세 곳에 모두 있어야 한다':
    'The thumbnail must be present in all three places: part, relationship and Content_Types',
  'ZIP 파트':
    'ZIP part',
  '_rels 관계 선언':
    '_rels relationship',
  '썸네일 {0}의 형식이 파일별(Override)이 아니라 확장자 기본값(Default .{1})으로 선언돼 있습니다.':
    'Thumbnail {0} is declared by the extension default (Default .{1}) rather than per file (Override).',
  'OPC 규격상 유효한 선언입니다. 이 도구로 저장하면 파일별 선언이 함께 들어갑니다(writeAasx). Validator가 이 형태를 떨어뜨린 실측은 아직 없습니다.':
    'This declaration is valid under OPC. Saving with this tool also adds a per-file declaration (writeAasx). No Validator run has rejected this form so far.',
  '썸네일 {0}에서 빠진 항목이 있습니다: {1}':
    'Thumbnail {0} is missing entries: {1}',
  '세 곳이 모두 있어야 Validator를 통과합니다. 하나라도 빠지면 열리기는 하나 검증에서 떨어집니다.':
    'All three must be present to pass the Validator. If any one is missing, the file still opens but fails validation.',
  '같은 LangString 안에 동일 언어 태그가 중복될 수 없다':
    'The same language tag must not appear twice in one LangString',
  '{0} (IDTA 원본 CD의 en 태그 오타가 따라오는 사례)':
    '{0} (an en-tag typo carried over from the original IDTA CD)',
  '{0}에 동일한 언어 태그가 중복됩니다: {1}':
    'Duplicate language tag in {0}: {1}',
  '텍스트는 손대지 말고, 같은 항목의 다른 필드에서 근거가 확인될 때만 언어 태그를 교정하십시오. 근거가 없으면 중복 항목만 제거하십시오.':
    'Leave the text untouched. Correct the language tag only when another field of the same item confirms it; otherwise just remove the duplicate entry.',
  'KTL §7(템플릿 원본 유지)을 따르는 정책(preserve)이라 경고로만 표시했습니다.':
    'Shown only as a warning because the policy (preserve) follows KTL §7 (keep the template original).',
  '빈 배열을 남기지 않는다 (공식 스키마 minItems: 1)':
    'Do not leave empty arrays (official schema minItems: 1)',
  '빈 배열이 남아 있습니다: {0}':
    'An empty array remains: {0}',
  '항목을 넣거나 키를 지우십시오. 공식 스키마는 빈 배열을 허용하지 않습니다 (KOSMO Validator는 검사하지 않지만 aas-test-engines가 오류로 떨어뜨립니다).':
    'Add an item or remove the key. The official schema does not allow empty arrays (the KOSMO Validator does not check this, but aas-test-engines fails it as an error).',
  'version 없이 revision을 지정할 수 없다':
    'revision must not be set without version',
  '{0} 1장':
    '{0} ch. 1',
  'version 없이 revision만 지정되어 있습니다.':
    'Only revision is set, without version.',
  'administration에 version을 함께 입력하십시오.':
    'Enter a version in administration as well.',
  'SelfManagedEntity에는 globalAssetId 또는 specificAssetId가 있어야 한다':
    'A SelfManagedEntity must have a globalAssetId or a specificAssetId',
  'SelfManagedEntity에 globalAssetId도 specificAssetIds도 없습니다.':
    'The SelfManagedEntity has neither a globalAssetId nor specificAssetIds.',
  '자산 식별자를 지정하거나 entityType을 CoManagedEntity로 바꾸십시오.':
    'Set an asset identifier, or change entityType to CoManagedEntity.',
  '같은 네임스페이스 안에서 idShort는 고유해야 한다 (대소문자 구분)':
    'idShort must be unique within a namespace (case-sensitive)',
  '같은 네임스페이스에 동일한 idShort가 이미 있습니다: {0}':
    'An element with the same idShort already exists in this namespace: {0}',
  '형제 요소끼리 이름이 겹치지 않도록 바꾸십시오. 대소문자만 다른 것도 허용되지 않습니다.':
    'Rename it so that sibling elements do not share a name. Names that differ only in case are not allowed either.',
  'SubmodelElementList 직계 자식의 타입·semanticId·valueType 일관성':
    'Consistency of type, semanticId and valueType among direct children of a SubmodelElementList',
  '자식 요소의 타입이 typeValueListElement와 다릅니다: {0} (선언값 {1})':
    'Child element type differs from typeValueListElement: {0} (declared {1})',
  'SubmodelElementList에는 한 가지 타입만 담을 수 있습니다.':
    'A SubmodelElementList can hold only one type.',
  'Property/Range를 담는 리스트인데 valueTypeListElement가 없습니다.':
    'The list holds Property/Range but has no valueTypeListElement.',
  '자식들이 공통으로 쓰는 valueType을 valueTypeListElement에 지정하십시오.':
    'Set the valueType shared by the children in valueTypeListElement.',
  '자식의 valueType이 valueTypeListElement와 다릅니다: {0} (선언값 {1})':
    'Child valueType differs from valueTypeListElement: {0} (declared {1})',
  '리스트 안의 값 타입을 통일하십시오.':
    'Use a single value type within the list.',
  '직계 자식들의 semanticId가 서로 다릅니다: {0}종':
    'Direct children have different semanticIds: {0} kinds',
  '리스트 자식은 semanticId가 모두 같아야 합니다(AASd-114).':
    'All list children must have the same semanticId (AASd-114).',
  '자식의 semanticId가 semanticIdListElement와 다릅니다: {0} (선언값 {1})':
    'Child semanticId differs from semanticIdListElement: {0} (declared {1})',
  '둘 중 맞는 쪽으로 맞추십시오 — 대개 표준 사전 값(0173-/0112/로 시작)이 맞고 자식 쪽이 오타입니다. 자식 요소를 골라 semanticId 칸에서 선언값을 넣으면 됩니다(AASd-107).':
    'Align them to whichever is correct. Usually the standard dictionary value (starting with 0173- or 0112/) is right and the child has a typo. Select the child element and enter the declared value in its semanticId field (AASd-107).',
  'Reference 키 사슬 — 첫 키·뒤 키·Fragment 자리의 타입 제약':
    'Reference key chain: type constraints on the first key, subsequent keys and the Fragment position',
  'Reference의 첫 키가 GloballyIdentifiable이 아닙니다: {0}':
    'The first key of the Reference is not GloballyIdentifiable: {0}',
  '첫 키 타입을 {0} 중 하나로 바꾸십시오(AASd-121).':
    'Change the first key type to one of {0} (AASd-121).',
  'ModelReference의 첫 키가 AAS 식별 대상이 아닙니다: {0}':
    'The first key of the ModelReference is not an AAS identifiable: {0}',
  '첫 키 타입을 {0} 중 하나로 바꾸십시오(AASd-123).':
    'Change the first key type to one of {0} (AASd-123).',
  'FragmentReference 앞 키가 File·Blob이 아닙니다: {0}':
    'The key before FragmentReference is not File or Blob: {0}',
  'Fragment는 파일 안 위치를 가리킵니다 — 앞 키를 File 또는 Blob으로(AASd-127).':
    'A Fragment points to a location inside a file. Make the preceding key File or Blob (AASd-127).',
  'SubmodelElementList 키 뒤의 값이 정수 색인이 아닙니다: {0}':
    'The value after a SubmodelElementList key is not an integer index: {0}',
  '리스트 자식은 위치로 가리킵니다 — 0부터 시작하는 숫자를 쓰십시오(AASd-128).':
    'List children are addressed by position. Use a zero-based number (AASd-128).',
  'ModelReference의 {0}번째 키 타입이 요소류가 아닙니다: {1}':
    'Key {0} of the ModelReference is not a SubmodelElement type: {1}',
  '둘째 키부터는 Property·SubmodelElementCollection 같은 요소 타입이어야 합니다(AASd-125).':
    'From the second key on, keys must be element types such as Property or SubmodelElementCollection (AASd-125).',
  'ExternalReference의 첫 키가 GlobalReference가 아닙니다: {0}':
    'The first key of the ExternalReference is not GlobalReference: {0}',
  'GlobalReference로 바꾸십시오. Submodel로 두면 AASd-122 위반이며 basyx가 해당 서브모델을 통째로 버립니다(실측 7→5).':
    'Change it to GlobalReference. Leaving it as Submodel violates AASd-122, and basyx drops the whole submodel (measured: 7 to 5).',
  'ExternalReference의 마지막 키가 GlobalReference가 아닙니다: {0}':
    'The last key of the ExternalReference is not GlobalReference: {0}',
  '마지막 키 타입을 GlobalReference로 바꾸십시오(AASd-124).':
    'Change the last key type to GlobalReference (AASd-124).',
  'ConceptDescription의 preferredName에 영문이 있어야 한다':
    'The preferredName of a ConceptDescription must include English',
  '{0} 2장':
    '{0} ch. 2',
  'preferredName에 영문(en) 항목이 없습니다.':
    'preferredName has no English (en) entry.',
  '영문 표기를 en 태그로 추가하십시오.':
    'Add the English name with the en tag.',
  'dataType이 MEASURE/CURRENCY 계열이면 unit 또는 unitId가 필요하다':
    'A MEASURE/CURRENCY dataType requires unit or unitId',
  'dataType이 {0}인데 unit도 unitId도 없습니다.':
    'dataType is {0}, but there is neither unit nor unitId.',
  '단위를 지정하십시오. 무차원 값(개수·비율·역률)이라면 단위를 억지로 붙이지 말고 dataType을 REAL_COUNT / INTEGER_COUNT로 바꿔야 맞습니다.':
    'Specify a unit. For dimensionless values (counts, ratios, power factor), do not force a unit; change dataType to REAL_COUNT / INTEGER_COUNT instead.',
  'SubmodelElementList 직계 자식에는 idShort를 붙일 수 없다':
    'Direct children of a SubmodelElementList must not have an idShort',
  'SubmodelElementList의 직계 자식에 idShort가 있습니다: {0}':
    'A direct child of a SubmodelElementList has an idShort: {0}',
  'idShort를 지우십시오. 리스트 자식은 인덱스로 가리킵니다(AASd-120). 지워도 KOSMO 규칙에는 영향이 없고, BaSyx 적재와 표준 검증기 통과가 열립니다. 단, 이미 Validator를 받은 파일은 고치면 파일이 달라지므로 다음 버전에서 고치고 Validator를 다시 받으십시오.':
    'Remove the idShort. List children are addressed by index (AASd-120). Removing it does not affect the KOSMO rules, and lets the file load in BaSyx and pass standard validators. However, changing a file that already received a Validator result changes the file, so fix it in the next version and have it validated again.',
  '정책(forbid) — 표준 준수·상호운용을 우선합니다.':
    'Policy (forbid): standard compliance and interoperability come first.',
  'KOSMO Validator는 이 제약을 검사하지 않지만, aas-test-engines는 오류로, basyx-python-sdk는 읽기 실패로 처리합니다. 정책(warn)에 따라 경고로 표시했습니다.':
    'The KOSMO Validator does not check this constraint, but aas-test-engines treats it as an error and basyx-python-sdk fails to read the file. Shown as a warning according to the policy (warn).',
  'DataElement의 category는 CONSTANT · PARAMETER · VARIABLE 중 하나여야 한다':
    'The category of a DataElement must be CONSTANT, PARAMETER or VARIABLE',
  'DataElement의 category가 허용값이 아닙니다: {0}':
    'The DataElement category is not an allowed value: {0}',
  '{0} 중 하나로 바꾸거나 비워 두십시오(AASd-090).':
    'Change it to one of {0}, or leave it empty (AASd-090).',
  'supplementalSemanticIds가 있으면 semanticId도 있어야 한다':
    'If supplementalSemanticIds is present, semanticId must be present too',
  '보조 semanticId만 있고 주 semanticId가 없습니다.':
    'Only supplemental semanticIds are set; the main semanticId is missing.',
  'semanticId를 채우거나 supplementalSemanticIds를 지우십시오(AASd-118).':
    'Fill in semanticId or remove supplementalSemanticIds (AASd-118).',
  'SpecificAssetId — 예약 이름 globalAssetId 금지, externalSubjectId는 ExternalReference':
    'SpecificAssetId: the reserved name globalAssetId is not allowed; externalSubjectId must be an ExternalReference',
  'specificAssetId의 이름으로 예약어 globalAssetId를 쓸 수 없습니다.':
    'The reserved word globalAssetId cannot be used as a specificAssetId name.',
  '그 값은 assetInformation.globalAssetId 필드에 두십시오(AASd-116).':
    'Put that value in the assetInformation.globalAssetId field (AASd-116).',
  'externalSubjectId가 ExternalReference가 아닙니다: {0}':
    'externalSubjectId is not an ExternalReference: {0}',
  'Reference/type을 ExternalReference로 바꾸십시오(AASd-133).':
    'Change Reference/type to ExternalReference (AASd-133).',
  'IEC 61360의 value와 valueList는 함께 쓸 수 없다':
    'IEC 61360 value and valueList must not be used together',
  'IEC 61360에 value와 valueList가 함께 있습니다.':
    'IEC 61360 has both value and valueList.',
  '둘 중 하나만 남기십시오(AASc-3a-010) — 고정값이면 value, 선택지면 valueList.':
    'Keep only one of them (AASc-3a-010): value for a fixed value, valueList for a set of choices.',
  'TemplateQualifier가 붙은 요소는 kind=Template 서브모델 안에 있어야 한다':
    'Elements with a TemplateQualifier must be inside a submodel with kind=Template',
  'TemplateQualifier가 있는데 서브모델 kind가 Template이 아닙니다: {0}':
    'There is a TemplateQualifier, but the submodel kind is not Template: {0}',
  'Submodel.kind를 Template으로 바꾸거나 qualifier를 지우십시오(AASd-119·129).':
    'Change Submodel.kind to Template or remove the qualifier (AASd-119, AASd-129).',
  '문자열에 XML 1.0에서 금지된 문자(제어문자 등)를 쓸 수 없다':
    'Strings must not contain characters forbidden in XML 1.0 (control characters, etc.)',
  '문자열에 XML에서 금지된 문자(제어문자 등)가 들어 있습니다.':
    'A string contains characters forbidden in XML (control characters, etc.).',
  '해당 문자를 지우십시오(AASd-130). 복사·붙여넣기로 섞여 들어오는 일이 흔합니다.':
    'Remove those characters (AASd-130). They often slip in through copy and paste.',
  'Operation의 입·출력 변수 idShort는 서로 달라야 한다':
    'Input and output variable idShorts of an Operation must differ',
  'Operation 변수 idShort가 겹칩니다: {0}':
    'Operation variable idShorts overlap: {0}',
  '입·출력 변수의 idShort를 서로 다르게 지으십시오(AASd-134).':
    'Give the input and output variables different idShorts (AASd-134).',
  '계층 구조 진입점 검사 — EntryNode와 ArcheType이 있어야 한다':
    'Hierarchy entry point check: EntryNode and ArcheType must exist',
  '무엇의 계층인지 나타내는 Entity를 최상위에 하나 두십시오.':
    'Place one Entity at the top level that shows what this hierarchy describes.',
  '계층 구조에 진입점(EntryNode)이 없습니다.':
    'The hierarchy has no entry point (EntryNode).',
  'ArcheType이 없습니다 — 계층을 어느 방향으로 적었는지 알 수 없습니다.':
    'ArcheType is missing, so the direction in which the hierarchy was written is unknown.',
  'ArcheType Property를 두고 Full · OneDown · OneUp 중 하나를 값으로 넣으십시오.':
    'Add an ArcheType Property with one of Full, OneDown or OneUp as its value.',
  'ArcheType 값이 규격에 없습니다: {0}':
    'The ArcheType value is not defined in the specification: {0}',
  'Full · OneDown · OneUp 중 하나여야 합니다.':
    'It must be one of Full, OneDown or OneUp.',
  '자식 노드 연결 검사 — 가리키는 설비 주소(globalAssetId)가 있어야 한다':
    'Child node link check: the referenced equipment address (globalAssetId) must exist',
  '가리키는 설비의 Asset 주소(globalAssetId)가 없습니다.':
    'The Asset address (globalAssetId) of the referenced equipment is missing.',
  '그 설비 파일의 AssetInformation.globalAssetId 값을 넣으십시오.':
    'Enter the AssetInformation.globalAssetId value from that equipment file.',
  '자기 자신을 부분품으로 매달았습니다.':
    'The node is attached to itself as a part.',
  '자식 노드는 다른 설비의 Asset을 가리켜야 합니다.':
    'A child node must point to the Asset of a different piece of equipment.',
  '같은 설비가 이미 매달려 있습니다: {0}':
    'The same equipment is already attached: {0}',
  '중복을 지우십시오. 같은 것이 여러 대면 BulkCount로 적습니다.':
    'Remove the duplicate. If there are several identical units, record them with BulkCount.',
  '부분품 관계 검사 — 자식마다 HasPart 관계가 있어야 한다':
    'Part relationship check: every child must have a HasPart relationship',
  '이 자식에 대응하는 HasPart 관계가 없습니다.':
    'There is no HasPart relationship for this child.',
  'second가 {0}를 가리키는 RelationshipElement를 두어 부모와 연결해 주십시오.':
    'Add a RelationshipElement whose second points to {0} to link it to the parent.',
  '관계가 가리키는 자식이 없습니다: {0}':
    'The child referenced by the relationship does not exist: {0}',
  '자식을 되살리거나 이 관계를 지우십시오.':
    'Restore the child or remove this relationship.',
  'Thumbnail 이미지 검사 — defaultThumbnail 설정 및 패키지 파트 일치':
    'Thumbnail image check: defaultThumbnail is set and matches a package part',
  'AssetInformation에 defaultThumbnail이 설정되어 있지 않습니다.':
    'defaultThumbnail is not set in AssetInformation.',
  '패키지의 썸네일 파트와 같은 경로로 defaultThumbnail을 지정하십시오. 예: path=/thumbnail.png, contentType=image/png':
    'Set defaultThumbnail to the same path as the thumbnail part in the package. Example: path=/thumbnail.png, contentType=image/png',
  'defaultThumbnail이 가리키는 파트가 패키지에 없습니다: {0}':
    'The part referenced by defaultThumbnail is not in the package: {0}',
  '썸네일 파일을 패키지에 넣고 _rels/.rels 관계와 Content_Types Override를 함께 추가하십시오.':
    'Add the thumbnail file to the package, together with the _rels/.rels relationship and the Content_Types Override.',
  'AAS idShort 설정 및 명명 규칙 검사':
    'AAS idShort presence and naming rule check',
  'AAS에 idShort가 없습니다.':
    'The AAS has no idShort.',
  '장비 영문명을 CamelCase로 지정하십시오.':
    'Set the equipment\'s English name in CamelCase.',
  'idShort가 명명 규칙에 맞지 않습니다: {0}':
    'idShort does not follow the naming rule: {0}',
  '영문자로 시작하는 2자 이상 CamelCase로 바꾸십시오. 한글·공백·특수문자는 쓸 수 없고 하이픈으로 끝날 수 없습니다.':
    'Rename it to CamelCase, at least 2 characters, starting with a letter. Hangul, spaces and special characters are not allowed, and it must not end with a hyphen.',
  'AAS Id 형식 검사 — administration의 version·revision과 Id 접미 일치':
    'AAS Id format check: the Id suffix must match administration version and revision',
  '{0} (실측 1·2차 위반)':
    '{0} (violated in Validator runs 1 and 2)',
  'Version 정보가 부족하여 Id 형식을 검증할 수 없습니다.':
    'Version information is incomplete, so the Id format cannot be verified.',
  'administration에 version과 revision을 모두 입력하십시오.':
    'Enter both version and revision in administration.',
  'Id의 끝 두 세그먼트가 administration과 일치하지 않습니다: {0} (기대값 {1})':
    'The last two segments of the Id do not match administration: {0} (expected {1})',
  'Id가 {0} 로 끝나도록 맞추십시오.':
    'Make the Id end with {0}.',
  '필수 Submodel 포함 여부 검사 — DN·HD·TD·OD 4종 + 총 6~8종':
    'Required Submodel check: DN, HD, TD and OD plus 6 to 8 in total',
  'AAS 없음':
    'no AAS',
  '필수 Submodel이 없습니다: {0}':
    'Required Submodels are missing: {0}',
  '누락된 서브모델을 IDTA 표준 템플릿으로 추가하십시오.':
    'Add the missing submodels from the IDTA standard templates.',
  'Submodel 개수가 허용 범위를 벗어났습니다: {count}종 (허용 {min}~{max}종)':
    'The number of Submodels is out of range: {count} (allowed {min} to {max})',
  '서브모델을 {max}종 이하로 통합하십시오. {over}종 이상은 그 자체로 위반입니다.':
    'Merge the submodels down to {max} or fewer. {over} or more is a violation in itself.',
  '서브모델을 {min}종 이상으로 보강하십시오.':
    'Add submodels to reach at least {min}.',
  'globalAssetId 검사':
    'globalAssetId check',
  'globalAssetId가 없습니다.':
    'globalAssetId is missing.',
  '{0}/asset/{장비명}/{version}/{revision} 형식으로 지정하십시오.':
    'Set it in the form {0}/asset/{equipment-name}/{version}/{revision}.',
  'Type 유형 검사 — assetKind는 Type이어야 한다':
    'Type check: assetKind must be Type',
  'assetKind가 Type이 아닙니다: {0}':
    'assetKind is not Type: {0}',
  'assetKind를 Type으로 지정하십시오. 본 사업 산출물은 형식(Type) 단위입니다.':
    'Set assetKind to Type. Deliverables in this program are at the type (Type) level.',
  'ConceptDescription idShort 설정 및 명명 규칙 검사':
    'ConceptDescription idShort presence and naming rule check',
  'ConceptDescription에 idShort가 없습니다.':
    'The ConceptDescription has no idShort.',
  '대응하는 요소의 idShort와 같은 이름을 지정하십시오.':
    'Use the same name as the idShort of the corresponding element.',
  '영문자로 시작하는 2자 이상 CamelCase로 바꾸십시오.':
    'Rename it to CamelCase, at least 2 characters, starting with a letter.',
  'ConceptDescription Id 형식 검사 — IRDI 또는 자체 IRI 화이트리스트':
    'ConceptDescription Id format check: IRDI or an allow-listed own IRI',
  '{0} (실측 1·3차 위반)':
    '{0} (violated in Validator runs 1 and 3)',
  'CD의 id가 허용 목록 밖입니다: {0}':
    'The CD id is not on the allow list: {0}',
  'IRDI({0}) 또는 {1}/cd/{변수명}/{version}/{revision} 형식으로 바꾸십시오. 카테고리 자리(cd)에 장비명을 쓰면 안 됩니다.':
    'Change it to IRDI ({0}) or the form {1}/cd/{variable-name}/{version}/{revision}. Do not put the equipment name in the category position (cd).',
  'IDTA 공식 IRI라 정책(idta-preserve)에 따라 경고로만 표시했습니다.':
    'Shown only as a warning because it is an official IDTA IRI and the policy is idta-preserve.',
  'IDTA 공식 IRI이지만 정책(kosmo-first)에 따라 위반으로 봅니다. 교정 시 이관 대장에 원본 IRI를 기록하십시오.':
    'It is an official IDTA IRI, but the policy (kosmo-first) treats it as an error. When correcting it, record the original IRI in the relocation ledger.',
  'definition/description 작성 검사 — 영문 정의 필수':
    'definition/description check: an English definition is required',
  '{0} (실측 3차 위반, KTL §8과 충돌)':
    '{0} (violated in Validator run 3; conflicts with KTL §8)',
  '영문(en) definition 또는 description이 없습니다.':
    'There is no English (en) definition or description.',
  '개발계획서 원문의 정의를 그대로 인용해 en 태그로 채우십시오. 정의를 창작하지 마십시오.':
    'Fill it in with the en tag, quoting the definition from the development plan verbatim. Do not invent definitions.',
  'KTL §8(정의 없으면 공란 유지)을 따르는 정책(allow-empty)이라 참고 항목으로만 표시했습니다. KOSMO Validator는 이를 위반으로 봅니다.':
    'Shown only for reference because the policy (allow-empty) follows KTL §8 (leave empty if there is no definition). The KOSMO Validator treats this as an error.',
  'KTL §8은 임의 입력을 금지하나 KOSMO는 영문 정의를 요구합니다. 정책(require-en)에 따라 위반으로 봅니다.':
    'KTL §8 forbids arbitrary input, but KOSMO requires an English definition. The policy (require-en) treats this as an error.',
  'DataType 설정 검사 — 값 유무와 KOSMO 허용 목록':
    'DataType check: presence and the KOSMO allow list',
  '{0} (실측 3·4차 위반)':
    '{0} (violated in Validator runs 3 and 4)',
  'IEC 61360 데이터 명세가 없습니다.':
    'The IEC 61360 data specification is missing.',
  'DataSpecificationIec61360 내용을 embeddedDataSpecifications에 추가하십시오.':
    'Add DataSpecificationIec61360 content to embeddedDataSpecifications.',
  'dataType이 설정되어 있지 않습니다.':
    'dataType is not set.',
  '대응 Property의 valueType에 맞는 dataType을 지정하십시오.':
    'Set a dataType that matches the valueType of the corresponding Property.',
  '유효하지 않은 dataType 값입니다: {0}':
    'Invalid dataType value: {0}',
  'STRING으로 정규화하십시오. FILE·BLOB·HTML은 AASc-3a-006에서는 허용되지만 KOSMO는 더 좁게 봅니다.':
    'Normalize it to STRING. FILE, BLOB and HTML are allowed by AASc-3a-006, but KOSMO is stricter.',
  'ConceptDescription id·idShort 중복 검사':
    'ConceptDescription id and idShort duplicate check',
  'id가 같은 ConceptDescription이 {0}건 있습니다: {1}':
    '{0} ConceptDescriptions have the same id: {1}',
  '중복된 CD를 하나로 합치십시오.':
    'Merge the duplicate CDs into one.',
  '같은 이름의 표준 사전 항목이 {0}곳에 있습니다: {1}':
    'Standard dictionary entries with the same name exist in {0} places: {1}',
  'idShort가 같은 ConceptDescription이 {0}건 있습니다: {1}':
    '{0} ConceptDescriptions have the same idShort: {1}',
  '고치지 마십시오. 서로 다른 표준 사전(IEC CDD·ECLASS 등)이 같은 개념에 같은 이름을 붙인 것이고, 각각 다른 서브모델이 참조합니다. 합치면 한쪽이 표준 사전을 못 가리키게 됩니다.':
    'Do not fix this. Different standard dictionaries (IEC CDD, ECLASS, etc.) gave the same name to the same concept, and each is referenced by a different submodel. Merging them would leave one side no longer pointing to its standard dictionary.',
  '서로 다른 개념이면 idShort를 구분하고, 같은 개념이면 하나로 합치십시오.':
    'If they are different concepts, give them distinct idShorts; if they are the same concept, merge them into one.',
  '외부 표준 사전(IRDI) 항목이라 우리가 손댈 대상이 아닙니다. 사실만 알리고 지적하지 않습니다.':
    'This is an external standard dictionary (IRDI) entry, so it is not ours to change. It is reported as a fact, not as an issue.',
  'Submodel idShort 설정 및 명명 규칙 검사':
    'Submodel idShort presence and naming rule check',
  'Submodel에 idShort가 없습니다.':
    'The Submodel has no idShort.',
  'IDTA 표준 서브모델명(DigitalNameplate 등)을 지정하십시오.':
    'Set an IDTA standard submodel name (such as DigitalNameplate).',
  'Submodel Id 형식 검사 — administration의 version·revision과 Id 접미 일치':
    'Submodel Id format check: the Id suffix must match administration version and revision',
  '{0} (실측 2차 위반)':
    '{0} (violated in Validator run 2)',
  'administration에 version·revision을 입력하십시오. IDTA 템플릿 버전을 쓴다면(예: DigitalNameplate 3.0 rev1) Id도 그 값으로 끝나야 합니다.':
    'Enter version and revision in administration. If you use an IDTA template version (e.g. DigitalNameplate 3.0 rev1), the Id must end with those values too.',
  'Id가 {0} 로 끝나도록 맞추십시오. /1/0 고정은 위반입니다.':
    'Make the Id end with {0}. A fixed /1/0 is a violation.',
  'Submodel semanticId 설정 및 명명 규칙 검사 — IRDI 또는 자체 IRI 화이트리스트':
    'Submodel semanticId presence and naming rule check: IRDI or an allow-listed own IRI',
  '{0} (실측 1·3차 위반, KTL §4 주의1과 충돌)':
    '{0} (violated in Validator runs 1 and 3; conflicts with KTL §4 note 1)',
  'semanticId가 없습니다.':
    'semanticId is missing.',
  '자신의 Submodel Id를 semanticId로 지정하십시오.':
    'Set the Submodel\'s own Id as its semanticId.',
  'ExternalReference의 키 타입이 GlobalReference가 아닙니다: {0}':
    'The key type of the ExternalReference is not GlobalReference: {0}',
  'GlobalReference로 되돌리십시오. Submodel로 바꾸면 AASd-122/124 위반이 되고 basyx가 해당 서브모델을 예외 없이 통째로 버립니다(실측 7→5).':
    'Change it back to GlobalReference. Changing it to Submodel violates AASd-122/124, and basyx drops the whole submodel without exception (measured: 7 to 5).',
  'semanticId가 허용 목록 밖입니다: {0}':
    'semanticId is not on the allow list: {0}',
  'IRDI({0}) 또는 {1}/... 형식으로 바꾸십시오.':
    'Change it to IRDI ({0}) or the form {1}/... .',
  'IDTA 공식 IRI라 정책(idta-preserve)에 따라 경고로만 표시했습니다. KOSMO Validator는 이를 거부합니다.':
    'Shown only as a warning because it is an official IDTA IRI and the policy is idta-preserve. The KOSMO Validator rejects it.',
  'Kind 유형 검사 — Submodel.kind는 Template이어야 한다':
    'Kind check: Submodel.kind must be Template',
  'kind가 Template이 아닙니다: {0}':
    'kind is not Template: {0}',
  'kind를 Template으로 지정하십시오.':
    'Set kind to Template.',
  '한 파일 안에 같은 이름(idShort)의 Submodel이 둘 이상':
    'Two or more Submodels with the same name (idShort) in one file',
  '가져오기 실측 2026-09-03 · 문서 자료·수집 매핑이 이름으로 찾는다':
    'Observed on import 2026-09-03 · document data and collection mappings look submodels up by name',
  '같은 이름의 Submodel이 {0}개입니다: {1}':
    'There are {0} Submodels with the same name: {1}',
  '하나만 남기고 지우거나, 둘 다 필요하면 이름을 다르게 하십시오. 문서 자료와 수집 매핑은 이름으로 찾습니다.':
    'Keep one and remove the others, or give them different names if both are needed. Document data and collection mappings look submodels up by name.',
  'SubmodelElement idShort 설정 및 명명 규칙 검사':
    'SubmodelElement idShort presence and naming rule check',
  'idShort가 없습니다.':
    'idShort is missing.',
  'SubmodelElementList의 직계 자식을 제외한 모든 요소에는 idShort가 필요합니다(AASd-117).':
    'Every element except direct children of a SubmodelElementList needs an idShort (AASd-117).',
  '영문자로 시작하는 2자 이상 CamelCase로 바꾸십시오. 한글·공백·특수문자는 쓸 수 없습니다.':
    'Rename it to CamelCase, at least 2 characters, starting with a letter. Hangul, spaces and special characters are not allowed.',
  '특수 SME 배제 여부 검사 — Operation · BasicEventElement · Capability':
    'Excluded SME check: Operation, BasicEventElement, Capability',
  '본 사업에서 사용하지 않는 요소 종류입니다: {0}':
    'This element type is not used in this program: {0}',
  'Property·SubmodelElementCollection 등 표현 가능한 요소로 대체하십시오.':
    'Replace it with an element that can express the same thing, such as Property or SubmodelElementCollection.',
  'ConceptDescription 매핑 검사 — semanticId 유무와 같은 id의 CD 유무':
    'ConceptDescription mapping check: semanticId exists and a CD with the same id exists',
  '{0} (실측 최다 결함, 3·4차 위반)':
    '{0} (most frequent defect measured; violated in Validator runs 3 and 4)',
  '해당 {0}의 semanticId를 {1}/cd/{idShort}/1/0 형식으로 지정하고 같은 id의 ConceptDescription을 함께 생성하십시오.':
    'Set the semanticId of this {0} in the form {1}/cd/{idShort}/1/0 and create a ConceptDescription with the same id.',
  'semanticId에 대응하는 ConceptDescription이 없습니다: {0}':
    'No ConceptDescription matches the semanticId: {0}',
  '표준 템플릿의 용어입니다. 그대로 두십시오 — 자체 CD로 바꾸면 템플릿의 의미가 깨집니다.':
    'This is a standard template term. Leave it as is; replacing it with your own CD breaks the template\'s meaning.',
  '그 id의 ConceptDescription을 생성하거나, 기존 CD의 id를 가리키도록 고치십시오.':
    'Create a ConceptDescription with this id, or point it to the id of an existing CD.',
  '정책(preserve) — IDTA·W3C 표준 용어라 교정 대상에서 뺐습니다. KOSMO Validator가 이를 어떻게 판정하는지는 실측 자료가 없으니 Validator로 확인하십시오.':
    'Policy (preserve): excluded from correction because it is an IDTA or W3C standard term. There is no measured data on how the KOSMO Validator judges this, so check it with the Validator.',
  'Property value 값 존재 검사 (DigitalNameplate·HandoverDocumentation 제외)':
    'Property value presence check (except DigitalNameplate and HandoverDocumentation)',
  'Property에 값이 없습니다.':
    'The Property has no value.',
  '예시 데이터를 입력하십시오. 값이 비면 Validator가 위반으로 판정합니다.':
    'Enter sample data. The Validator treats an empty value as an error.',
  'Property valueType과 ConceptDescription dataType 정합 검사':
    'Property valueType and ConceptDescription dataType consistency check',
  '{0} (실측 3차 위반)':
    '{0} (violated in Validator run 3)',
  'valueType과 CD의 dataType이 맞지 않습니다: {0} 대 {1}':
    'valueType and the CD dataType do not match: {0} vs {1}',
  '외부 표준 사전 CD이므로 원본을 두고 Property의 valueType을 {0}에 맞는 값으로 바꾸십시오.':
    'This is an external standard dictionary CD, so keep the original and change the Property valueType to a value matching {0}.',
  ' 또는 ':
    ' or ',
  '자체 CD이므로 CD의 dataType을 {0} 중 하나로 바꾸십시오.':
    'This is our own CD, so change the CD dataType to one of {0}.',
  '외부 CD(IRDI)는 교정 방향이 반대입니다 — 우리 쪽 valueType을 맞춥니다.':
    'For external CDs (IRDI), the correction goes the other way: adjust our valueType.',
  "수집 연결 주소 검사 — 접속 주소(base)에 사용자 이름 · 암호를 넣지 않는다": "Collection link address check — no user name or password in the address (base)",
  "접속 주소에 사용자 이름 · 암호가 들어 있습니다: {0} — 파일을 받는 모든 사람에게 비밀번호가 함께 갑니다. 원격 수집기 목록에서도 빠집니다.": "The address carries a user name and password: {0} — the password goes to everyone who gets the file. It is also left out of the remote collector list.",
  "「연결수정」에서 주소의 사용자 이름 · 암호를 떼고 「로그인 필요」를 켜십시오. 사용자 이름 · 암호는 서버의 credentials 파일과 공장 PC 의 credentials.json 에 그 주소로 적습니다.": "In \"Edit link\", take the user name and password out of the address and turn on \"Login required\". Write the user name and password under that address in the server's credentials file and in credentials.json on the factory PC.",
};
