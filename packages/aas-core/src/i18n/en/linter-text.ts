/** English dictionary — linter-text. Key = the Korean source text verbatim, value = English. Placeholders ({0} · <b>) exactly as in the source */
export const EN_LINTER_TEXT: Record<string, string> = {
  // ── Shared short strings — do not put these in other dictionaries (the check stops if two files have the same key).
  //    '없음' is in packages.ts, '계층 구조에 진입점(EntryNode)이 없습니다.' is in linter-rules.ts ──
  위반: 'Error',
  경고: 'Warning',
  참고: 'Info',
  단위: 'Unit',
  설비: 'Equipment',
  경로: 'Path',
  '{0}건': '{0}',

  // ── fix/index.ts — auto-fix results · reasons for skipping ─────────────────
  '대상 AssetAdministrationShell을 찾을 수 없습니다.': 'The target AssetAdministrationShell could not be found.',
  '패키지 정보가 없어 썸네일 파트를 찾을 수 없습니다. AASX를 읽을 때의 opc 정보를 함께 넘기십시오.':
    'The thumbnail part cannot be located because no package information was provided. Pass the OPC information obtained when reading the AASX.',
  '패키지에 이미지 파트가 없습니다. 썸네일 파일을 먼저 추가해야 합니다.':
    'The package contains no image part. Add a thumbnail file first.',
  '이미 해당 파트를 가리키고 있습니다.': 'It already points to that part.',
  'defaultThumbnail을 패키지 파트 {0}로 지정했습니다.': 'Set defaultThumbnail to package part {0}.',
  '대상 Identifiable을 찾을 수 없습니다.': 'The target Identifiable could not be found.',
  'id의 끝 두 세그먼트가 버전 형식이 아니어서 administration을 유추할 수 없습니다: {0}. version·revision을 직접 입력하십시오.':
    'The last two segments of the id are not a version, so administration cannot be inferred: {0}. Enter version and revision manually.',
  'id 접미에서 administration을 만들었습니다: version={0}, revision={1}':
    'Created administration from the id suffix: version={0}, revision={1}',
  'administration이 없어 기대 id를 만들 수 없습니다.': 'The expected id cannot be built because administration is missing.',
  '이미 administration과 일치합니다.': 'Already consistent with administration.',
  '같은 id를 쓰는 다른 요소가 있습니다: {0}': 'Another element already uses the same id: {0}',
  'id를 administration에 맞추고 참조 {0}건을 함께 갱신했습니다.':
    'Aligned the id with administration and updated {0} reference(s).',
  'AAS에 idShort가 없어 asset IRI를 만들 수 없습니다.': 'The asset IRI cannot be built because the AAS has no idShort.',
  '이미 같은 값입니다.': 'The value is already the same.',
  'globalAssetId를 {0}로 지정했습니다.': 'Set globalAssetId to {0}.',
  '이미 Type입니다.': 'Already Type.',
  'assetKind를 Type으로 바꿨습니다.': 'Changed assetKind to Type.',
  '대상 Submodel을 찾을 수 없습니다.': 'The target Submodel could not be found.',
  '이미 Template입니다.': 'Already Template.',
  'kind를 Template으로 바꿨습니다.': 'Changed kind to Template.',
  'semanticId 키가 없습니다.': 'The semanticId has no key.',
  '이미 GlobalReference입니다.': 'Already GlobalReference.',
  'semanticId 키 타입을 GlobalReference로 되돌렸습니다(basyx가 서브모델을 버리지 않게).':
    'Reverted the semanticId key type to GlobalReference (prevents BaSyx from dropping the submodel).',
  '이미 자신의 id를 가리키고 있습니다.': 'It already points to its own id.',
  'semanticId를 자신의 id({0})로 지정했습니다.': 'Set semanticId to its own id ({0}).',
  'semanticId를 자신의 id로 옮기고 원본 IRI를 이관 대장에 기록했습니다.':
    'Moved semanticId to its own id and recorded the original IRI in the relocation ledger.',
  '대상 ConceptDescription을 찾을 수 없습니다.': 'The target ConceptDescription could not be found.',
  'CD에 idShort가 없어 새 id를 만들 수 없습니다. KOSMO-CD-1을 먼저 고치십시오.':
    'A new id cannot be built because the CD has no idShort. Fix KOSMO-CD-1 first.',
  '이미 규약에 맞는 id입니다.': 'The id already follows the convention.',
  '같은 idShort의 CD가 이미 {0}를 쓰고 있습니다. 중복 CD를 하나로 합친 뒤 다시 시도하십시오.':
    'A CD with the same idShort already uses {0}. Merge the duplicate CDs into one and try again.',
  'CD id를 자체 IRI 규약으로 옮기고 참조 {0}건을 갱신했습니다. 원본은 이관 대장에 남겼습니다.':
    'Moved the CD id to the in-house IRI convention and updated {0} reference(s). The original is kept in the relocation ledger.',
  'CD에 idShort가 없어 데이터 명세를 만들 수 없습니다.': 'A data specification cannot be created because the CD has no idShort.',
  '이미 IEC 61360 명세가 있습니다.': 'An IEC 61360 data specification already exists.',
  'IEC 61360 데이터 명세를 STRING으로 만들었습니다.': 'Created an IEC 61360 data specification with dataType STRING.',
  'IEC 61360 명세가 없습니다.': 'There is no IEC 61360 data specification.',
  '이미 STRING입니다.': 'Already STRING.',
  'dataType을 STRING으로 지정했습니다.': 'Set dataType to STRING.',
  '허용 목록 밖 dataType({0})을 STRING으로 정규화했습니다.': 'Normalized dataType {0}, which is outside the allowed list, to STRING.',
  '대상 SubmodelElement를 찾을 수 없습니다.': 'The target SubmodelElement could not be found.',
  'idShort가 없고 부모 리스트에서도 이름을 빌릴 수 없어 CD id를 만들 수 없습니다.':
    'A CD id cannot be built: the element has no idShort and no name can be borrowed from the parent list.',
  'idShort가 없어 ConceptDescription을 만들 수 없습니다.': 'A ConceptDescription cannot be created because there is no idShort.',
  '이미 대응하는 ConceptDescription이 있습니다.': 'A matching ConceptDescription already exists.',
  'semanticId를 지정하고 ConceptDescription을 생성했습니다: {0}. 정의는 idShort를 그대로 둔 자리표시자이므로 개발계획서 원문으로 대체하십시오.':
    'Set semanticId and created a ConceptDescription: {0}. The definition is a placeholder copied from the idShort; replace it with the wording from the development plan.',
  'ConceptDescription을 생성했습니다: {0}. 정의는 idShort를 그대로 둔 자리표시자이므로 개발계획서 원문으로 대체하십시오.':
    'Created a ConceptDescription: {0}. The definition is a placeholder copied from the idShort; replace it with the wording from the development plan.',
  'semanticId를 지정했습니다: {0}. 정의는 idShort를 그대로 둔 자리표시자이므로 개발계획서 원문으로 대체하십시오.':
    'Set semanticId: {0}. The definition is a placeholder copied from the idShort; replace it with the wording from the development plan.',
  '이미 단위가 있습니다.': 'A unit is already present.',
  '알 수 없는 dataType은 단위를 빼고 표현할 수 없습니다 — 단위를 직접 넣으십시오.':
    'An unknown dataType cannot be expressed without a unit — enter the unit manually.',
  '{0} dataType은 단위를 빼고 표현할 수 없습니다 — 단위를 직접 넣으십시오.':
    'dataType {0} cannot be expressed without a unit — enter the unit manually.',
  '단위를 모르므로 dataType을 {0} → {1}로 낮췄습니다. 주의 — 실제로 단위가 있는 측정값이라면 unit을 넣고 {0}로 되돌리십시오.':
    'The unit is unknown, so dataType was downgraded from {0} to {1}. Important: if this is a measured value that has a unit, enter the unit and change the dataType back to {0}.',
  '대상 Property를 찾을 수 없습니다.': 'The target Property could not be found.',
  'semanticId가 없습니다. KOSMO-SME-3을 먼저 고치십시오.': 'There is no semanticId. Fix KOSMO-SME-3 first.',
  '대응하는 ConceptDescription이 없습니다. KOSMO-SME-3을 먼저 고치십시오.':
    'There is no matching ConceptDescription. Fix KOSMO-SME-3 first.',
  '외부 CD에 dataType이 없어 맞출 기준이 없습니다.': 'The external CD has no dataType, so there is nothing to align with.',
  'dataType {0}에 대응하는 valueType이 없습니다. 사람이 판단해야 합니다.':
    'No valueType corresponds to dataType {0}. This needs a human decision.',
  '이미 일치합니다.': 'Already consistent.',
  '외부 표준 사전 CD는 그대로 두고 Property의 valueType을 {0}로 맞췄습니다.':
    'Kept the external standard dictionary CD as is and set the Property valueType to {0}.',
  '자체 CD에 IEC 61360 명세가 없습니다. KOSMO-CD-4를 먼저 고치십시오.':
    'The in-house CD has no IEC 61360 data specification. Fix KOSMO-CD-4 first.',
  'valueType {0}에 대응하는 dataType 매핑이 없습니다.': 'There is no dataType mapping for valueType {0}.',
  'KOSMO 허용 목록 안에서 고를 dataType이 없습니다.': 'No suitable dataType exists in the KOSMO allowed list.',
  '자체 CD이므로 CD의 dataType을 {0}로 맞췄습니다.': 'This is an in-house CD, so its dataType was set to {0}.',
  '이미 idShort가 없습니다.': 'There is already no idShort.',
  '리스트 자식의 idShort를 지웠습니다(AASd-120). 리스트 자식은 인덱스로 가리킵니다.':
    'Removed the idShort of the list child (AASd-120). List children are referenced by index.',
  '이미 category가 없습니다.': 'There is already no category.',
  'category를 비웠습니다(AASd-090). 어느 값이 맞는지는 의미 판단이라 사람이 정해야 합니다.':
    'Cleared category (AASd-090). Which value is correct is a semantic decision that a person must make.',
  '대상 File을 찾을 수 없습니다.': 'The target File could not be found.',
  '값이 비어 있어 URI를 만들 수 없습니다.': 'A URI cannot be built because the value is empty.',
  '이미 URI 스킴이 있습니다.': 'The value already has a URI scheme.',
  'File.value를 file:// URI 형식으로 바꿨습니다.': 'Converted File.value to a file:// URI.',
  '대상 자리를 찾을 수 없습니다.': 'The target location could not be found.',
  '배열이 아닙니다.': 'It is not an array.',
  '이미 항목이 들어 있습니다.': 'It already contains items.',
  '배열 안의 빈 배열은 손대지 않습니다.': 'An empty array inside an array is left untouched.',
  '빈 배열 {0}을(를) 지웠습니다.': 'Removed the empty array {0}.',
  '대상 다국어 필드를 찾을 수 없습니다.': 'The target multi-language field could not be found.',
  '중복 언어 태그가 없습니다.': 'There are no duplicate language tags.',
  '중복 언어 태그 {0}건을 제거했습니다(먼저 나온 항목을 남깁니다).':
    'Removed {0} duplicate language tag(s) (the first occurrence is kept).',
  '리스트 안의 타입·semanticId 불일치는 어느 쪽이 맞는지 사람이 정해야 합니다.':
    'For type or semanticId mismatches inside a list, a person must decide which side is correct.',
  '대상 리스트를 찾을 수 없습니다.': 'The target list could not be found.',
  '자식들의 valueType이 하나로 모이지 않습니다({0}) — 리스트 안의 값 타입을 먼저 통일하십시오.':
    'The children do not share a single valueType ({0}) — unify the value types in the list first.',
  'valueTypeListElement를 자식들의 valueType({0})으로 지정했습니다.':
    'Set valueTypeListElement to the valueType of the children ({0}).',
  '이 규칙에는 자동 교정기가 없습니다. 사람이 판단해야 합니다.':
    'This rule has no automatic fix. It needs a human decision.',
  '교정 중 오류: {0}': 'Error while fixing: {0}',

  // ── catalog.ts — rule screen layers · regulation conflicts · conventions · judging party ──
  'L1 — 패키지·직렬화': 'L1 — Package and serialization',
  'AASX 파일 자체가 규격대로 만들어졌는가 (공식 JSON 스키마·OPC 패키징)':
    'Whether the AASX file itself is built to the specification (official JSON schema, OPC packaging)',
  'L2 — 메타모델 제약(AASd·AASc)': 'L2 — Metamodel constraints (AASd, AASc)',
  'AAS V3.0 규격이 정한 제약. 표준 도구(aas-test-engines·BaSyx)가 강제한다':
    'Constraints defined by the AAS V3.0 specification, enforced by standard tools (aas-test-engines, BaSyx)',
  'L3 — KOSMO 사업 규칙': 'L3 — KOSMO program rules',
  'KOSMO가 요구하는 것. 실측(설비 20종 × Validator 4회)으로 확정했다':
    'What KOSMO requires, confirmed by measurement (20 equipment types × 4 Validator runs)',
  '① IDTA 공식 IRI': '① Official IDTA IRIs',
  'KTL §4는 IDTA 공식 IRI 보존을 요구하고, KOSMO는 admin-shell.io IRI를 거부한다':
    'KTL §4 requires official IDTA IRIs to be preserved, while KOSMO rejects admin-shell.io IRIs',
  '허용 목록 밖 IRI는 위반 (KOSMO 우선)': 'IRIs outside the allowed list are errors (KOSMO first)',
  'IDTA 공식 IRI는 통과, 경고로만 표시': 'Official IDTA IRIs pass and are reported as warnings only',
  '② 개념정의의 영문 definition': '② English definition of concept descriptions',
  'KTL §8은 정의가 없으면 공란 유지, KOSMO-CD-3은 영문 definition 필수':
    'KTL §8 keeps the field blank when no definition exists; KOSMO-CD-3 requires an English definition',
  '영문 정의가 없으면 위반': 'A missing English definition is an error',
  '공란 허용, 참고로만 남긴다': 'Blank is allowed and reported as info only',
  '③ 언어태그 오타': '③ Language tag typos',
  'KTL §7은 IDTA 템플릿 오류도 원본 유지, 그러나 오타는 AASd 위반을 부른다':
    'KTL §7 keeps the original even where the IDTA template is wrong, but typos cause AASd violations',
  '중복 언어태그를 위반으로 보고 교정한다': 'Treat duplicate language tags as errors and fix them',
  '경고로만 표시한다': 'Report as warnings only',
  '④ 리스트 자식의 idShort (AASd-120)': '④ idShort of list children (AASd-120)',
  'KOSMO Validator는 검사하지 않지만, aas-test-engines는 오류로 떨어뜨리고 basyx는 그 가지를 잃는다':
    'The KOSMO Validator does not check this, but aas-test-engines fails it as an error and BaSyx loses that branch',
  '경고 — 상호운용이 깨진다고 알린다': 'Warning — report that interoperability breaks',
  '위반 — 표준 도구 통과가 목표인 배포': 'Error — for deployments that must pass the standard tools',
  '참고 — 알고도 두겠다는 선택': 'Info — a deliberate choice to keep it',
  '⑤ 표준 템플릿의 용어 (AID 등)': '⑤ Terms of standard templates (AID, etc.)',
  'IDTA 공식 템플릿에는 ConceptDescription이 딸려 오지 않아 KOSMO-SME-3이 요소 수만큼 걸린다. 「고치기」로 없앨 수 있지만 표준 용어가 자체 IRI로 덮인다':
    'Official IDTA templates ship without ConceptDescriptions, so KOSMO-SME-3 fires once per element. "Fix" can clear them, but the standard terms are then replaced by in-house IRIs',
  '위반으로 본다 (KOSMO 우선)': 'Treat as errors (KOSMO first)',
  '표준 용어를 지키고 참고로만 남긴다 (KTL §7·상호운용)':
    'Keep the standard terms and report as info only (KTL §7, interoperability)',
  '자체 IRI 뿌리': 'In-house IRI root',
  'KOSMO 허용 접두 (02_Validator_대응규칙 §110)': 'KOSMO allowed prefix (02_Validator response rules §110)',
  '표준 사전 IRDI 접두': 'Standard dictionary IRDI prefixes',
  'KOSMO가 인정하는 표준 사전': 'Standard dictionaries recognized by KOSMO',
  '필수 서브모델': 'Required submodels',
  '서브모델 개수': 'Number of submodels',
  '{0}종 이상 {1}종 이하': 'At least {0} and at most {1}',
  'AAS id 짓는 법': 'AAS id pattern',
  장비명: 'equipmentName',
  '03_AASX_생성규약': '03_AASX creation conventions',
  '서브모델 id 짓는 법': 'Submodel id pattern',
  서브모델명: 'submodelName',
  'KOSMO-SM-2 (id 접미와 administration 일치)': 'KOSMO-SM-2 (id suffix matches administration)',
  '자산 종류': 'Asset kind',
  'Type (형식) — 본 사업 산출물은 개별 장비가 아니라 형식이다':
    'Type — deliverables of this program describe equipment types, not individual units',
  '값 동기화': 'Value synchronization',
  'A안 — 파일(AASX)이 원본. 수집값은 시계열에만 쌓이고 모델로 되쓰지 않는다':
    'Option A — the AASX file is the source of truth. Collected values go only to the time series and are not written back to the model',
  '공식 판정 주체. 오류 0건이 기준이다': 'Official verdict authority. The criterion is zero errors',
  '합격 판정 주체(표준). KOSMO와 판정이 다를 수 있다 — AASd-120이 그 예다':
    'Pass/fail authority (standard). Its verdict can differ from KOSMO — AASd-120 is an example',
  '이 도구의 린터': "This tool's linter",
  '미리 걸러 주는 사전 점검. 위 둘을 대신하지 않는다': 'A pre-submission check that screens in advance. It does not replace the two above',
  '뷰어 전용. V2 스키마 오탐이 있어 검증에 쓰지 않는다': 'Viewer only. Not used for validation because of false positives against the V2 schema',
  '적재·상호운용 시연 도구. 검증 도구가 아니다': 'A loading and interoperability demonstration tool, not a validation tool',

  // ── report/html.ts · report/text.ts — validation report ───────────────────
  '자동 교정 가능': 'Auto-fixable',
  '사람 판단': 'Manual review',
  'IRI 이관 대장 ({0}건)': 'IRI relocation ledger ({0})',
  'KOSMO Validator가 IDTA 공식 IRI를 거부하므로 자체 IRI로 옮겼다(KTL §4와 충돌하는 자리 — 정책 KOSMO 우선). 원본은 여기 남아 있어 언제든 되돌릴 수 있다.':
    'Because the KOSMO Validator rejects official IDTA IRIs, they were moved to in-house IRIs (this conflicts with KTL §4 — policy: KOSMO first). The originals are kept here and can be restored at any time.',
  '지금 IRI': 'Current IRI',
  '원본 IRI': 'Original IRI',
  'AAS 검증 결과서 — {0}': 'AAS validation report — {0}',
  '표가 쪽을 넘어갈 때 행이 잘리지 않게 한다': 'Keep rows intact when a table spans pages',
  '회사 표시 — 인쇄해서 제출하는 문서다': 'Company mark — this document is printed and submitted',
  'AAS 검증 결과서': 'AAS validation report',
  요약: 'Summary',
  '검사 규칙': 'Rules checked',
  '{0}종 (L1 패키지 · L2 AASd/AASc · L3 KOSMO)': '{0} (L1 package · L2 AASd/AASc · L3 KOSMO)',
  계층별: 'By layer',
  'L1 {0}건 · L2 {1}건 · L3 {2}건': 'L1 {0} · L2 {1} · L3 {2}',
  '규칙별 집계': 'Findings by rule',
  규칙: 'Rule',
  건수: 'Count',
  '지적 목록': 'Findings',
  '지적사항이 없습니다.': 'No findings.',
  등급: 'Severity',
  대상: 'Element',
  위치: 'Location',
  '내용과 조치': 'Finding and remedy',
  교정: 'Fix',
  '적용한 규정 해석': 'Applied rule interpretations',
  'KTL 규정·KOSMO Validator·표준 도구가 서로 어긋나는 5건은 정책에 따라 판정이 달라진다. 어느 쪽을 골랐는지 함께 남긴다.':
    'The 5 points where the KTL regulation, the KOSMO Validator and the standard tools disagree are decided by policy. The choices made are recorded here.',
  '① IRI 충돌': '① IRI conflict',
  'KOSMO 우선 — 화이트리스트 밖 IRI를 위반으로 본다': 'KOSMO first — IRIs outside the allowed list are errors',
  'IDTA 보존 — 공식 IRI는 경고로만': 'Preserve IDTA — official IRIs are warnings only',
  '② CD 정의': '② CD definition',
  '영문 definition 필수': 'English definition required',
  '공란 허용(KTL §8)': 'Blank allowed (KTL §8)',
  '③ 언어 태그': '③ Language tags',
  '중복 태그를 교정 대상으로 본다': 'Duplicate tags are fixed',
  '원본 유지(KTL §7)': 'Keep the original (KTL §7)',
  '④ SML 자식 idShort (AASd-120)': '④ SML child idShort (AASd-120)',
  '경고 — KOSMO 판정에는 영향 없음': 'Warning — no effect on the KOSMO verdict',
  '위반 — 표준 도구·BaSyx 적재가 목표': 'Error — target is passing the standard tools and loading into BaSyx',
  '참고 — 알고도 둔다': 'Info — kept deliberately',
  '⑤ 표준 템플릿 용어': '⑤ Standard template terms',
  'KOSMO 우선 — CD 없는 표준 용어를 위반으로 본다': 'KOSMO first — standard terms without a CD are errors',
  '보존 — 표준 용어는 참고로만': 'Preserve — standard terms are info only',
  '자체 IRI 접두': 'In-house IRI prefix',
  '인정 IRDI 접두': 'Recognized IRDI prefixes',
  '이 문서는 <b>자체 규칙 린터</b>의 결과입니다. KOSMO Validator가 출력한 결과서가 아닙니다.':
    'This document is the output of an <b>in-house rule linter</b>. It is not a report produced by the KOSMO Validator.',
  'Validator 실행 결과와 함께 확인하십시오.': 'Review it together with the results of a Validator run.',
  '검사 규칙 {0}종 · 위반 {1}건 · 경고 {2}건 · 참고 {3}건': '{0} rules checked · {1} errors · {2} warnings · {3} info',
  '계층별: L1 패키지 {0}건 · L2 제약조건 {1}건 · L3 KOSMO {2}건':
    'By layer: L1 package {0} · L2 constraints {1} · L3 KOSMO {2}',
  상세: 'Details',
  '외 {0}건': 'and {0} more',
  '위반 {0}건 · 경고 {1}건': '{0} errors · {1} warnings',

  // ── docs/table.ts · docs/uml.ts — documentation material (tables · UML) ───
  '장비 특화 요소 {0}개를 담고 있습니다(자체 IRI semanticId).':
    'Contains {0} equipment-specific element(s) (semanticId with an in-house IRI).',
  '장비 특화 요소가 없는 IDTA 표준 템플릿입니다 — 규정 §13 주의사항 5에 따라 표는 생략합니다.':
    'An IDTA standard template with no equipment-specific elements — the table is omitted per regulation §13, note 5.',
  구분: 'Level',
  종류: 'Kind',
  데이터타입: 'Data type',
  '예시 값': 'Example value',
  설명: 'Description',
  'IDTA 표준 템플릿 용어': 'IDTA standard template terms',
  '용어사전 버전 (주의사항 1 — 파일에는 IRDI만 있고 사전 버전은 없습니다)':
    'Dictionary version (note 1 — the file contains only IRDIs, not the dictionary version)',
  '템플릿 원본 링크 (주의사항 2 — IDTA Content Hub에서 최신 버전 확인)':
    'Link to the original template (note 2 — check the latest version on the IDTA Content Hub)',
  '서브모델 및 주요 구성요소 특징': 'Characteristics of the submodel and its main elements',
  '서브모델 활용방안': 'How the submodel is used',
  '활용 시나리오 (주의사항 4)': 'Usage scenario (note 4)',
  'IDTA 원본: {0}': 'IDTA original: {0}',
  '표 {0} {1} - {2}': 'Table {0} {1} - {2}',
  '… 그 밖 {0}개': '… {0} more',

  // ── bundle.ts — data linkage definition table · linkage findings ──────────
  'semanticId 하나를 서로 다른 이름 {0}개가 함께 사용합니다: {1}. 같은 개념인지 확인하십시오 — 연계 매핑은 semanticId만으로 잡지 말고 경로를 함께 적습니다.':
    'One semanticId is used by {0} different names: {1}. Check that they are the same concept — record the path in the linkage mapping instead of relying on the semanticId alone.',
  '「{0}」 — 이름은 같은데 semanticId가 {1}종입니다. KPI를 모을 때 하나로 볼지 매핑표에서 정하십시오.':
    '"{0}" — the same name has {1} different semanticIds. Decide in the mapping table whether to treat them as one when aggregating KPIs.',
  '연계 키(사람이 채움)': 'Linkage key (filled in by a person)',
  'KPI 용도(사람이 채움)': 'KPI use (filled in by a person)',
  '대표 이름': 'Primary name',
  '정의 이름': 'Defined name',
  '보유 설비 수': 'Equipment count',

  // ── clone.ts · scaffold.ts · hierarchy.ts — create new · clone · hierarchy editing ──
  '복제할 파일에 AAS가 없습니다.': 'The file to clone contains no AAS.',
  '복제할 파일의 AAS에 idShort가 없습니다.': 'The AAS in the file to clone has no idShort.',
  '장비명은 영문으로 시작하고 영문·숫자·밑줄만 씁니다: {0}':
    'The equipment name must start with a letter and contain only letters, digits and underscores: {0}',
  '이름이 비었습니다.': 'The name is empty.',
  '설비의 Asset 주소가 비었습니다.': 'The asset address of the equipment is empty.',
  '넣을 자리를 찾지 못했습니다: {0}': 'Could not find the place to insert: {0}',
  '라인은 맨 위(회사 바로 밑)에만 둡니다.': 'Lines can only be placed at the top level (directly under the company).',
  '이미 있는 이름입니다: {0}': 'The name already exists: {0}',
  '이미 매달린 설비입니다: {0}': 'The equipment is already attached here: {0}',
  '자리를 찾지 못했습니다: {0}': 'Could not find the location: {0}',
  '없는 이름입니다: {0}': 'No such name: {0}',

  // ── policy-file.ts — policy file errors ──────────────────────────────────
  '정책 파일이 JSON이 아닙니다: {0}': 'The policy file is not valid JSON: {0}',
  '정책 파일은 객체 하나여야 합니다.': 'The policy file must contain a single object.',
  '모르는 정책 항목입니다: {0} — 쓸 수 있는 것: {1}': 'Unknown policy key: {0} — allowed keys: {1}',
  '{0}에 쓸 수 없는 값입니다: {1} — 쓸 수 있는 것: {2}': 'Invalid value for {0}: {1} — allowed values: {2}',
  '{0}는 비어 있지 않은 글자여야 합니다.': '{0} must be a non-empty string.',
  '{0}는 글자 목록이어야 합니다.': '{0} must be a list of strings.',
  'submodelCountRange는 정수 두 개여야 합니다. 예: [6, 8]': 'submodelCountRange must be two integers, e.g. [6, 8]',
  'submodelCountRange의 최솟값이 최댓값보다 큽니다.': 'The minimum of submodelCountRange is greater than its maximum.',
  '아직 정책 파일로 바꿀 수 없는 항목입니다: {0}': 'This key cannot be changed through a policy file yet: {0}',
  // Rule source document names (catalog.ts sourceText) — internal documents, so the English UI describes what they are
  '02_Validator_대응규칙.md': 'Validator response rules (doc 02)',
  '04_린터_규칙_명세.md': 'Linter rule specification (doc 04)',
  'AAS 참조모델 제약조건 spec_260812.pdf': 'AAS reference model constraints (spec 2026-08-12)',
};
