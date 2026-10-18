/** English dictionary — bundle. Key = the Korean source text verbatim, value = English. Placeholders ({0} · <b>) exactly as in the source */
export const EN_BUNDLE: Record<string, string> = {
  // ── routes/bundle.ts — category names (translated only in the README; manifest values and folder names stay Korean) ──
  '생산최적화/품질관리': 'Production optimization / quality management',
  '에너지효율/지속가능성': 'Energy efficiency / sustainability',
  '유연생산/자산관리': 'Flexible production / asset management',
  '데이터통합/보안': 'Data integration / security',
  '지능형 자율제조/AI 에이전트': 'Intelligent autonomous manufacturing / AI agents',
  '설비 예지보전(PdM)': 'Predictive maintenance (PdM)',
  '공급망 디지털 연결': 'Digital supply chain connectivity',

  // ── routes/bundle.ts — request errors ──
  '번들은 공정(묶음) 파일에서 만듭니다 — 이 파일은 설비 한 대 파일입니다.':
    'Bundles are made from a process (composite) file — this file describes a single machine.',
  'evidenceMinutes는 양수(분)입니다: {0}': 'evidenceMinutes must be a positive number (minutes): {0}',
  '번들 코드는 RB01 형식입니다.': 'The bundle code must look like RB01.',
  '버전은 1.0.0 형식입니다(운영 가이드라인과 같은 3자리).': 'The version must look like 1.0.0 (three parts, as in the operating guideline).',
  '증빙 수준은 A·B·C·auto·none 중 하나입니다.': 'The evidence level must be one of A·B·C·auto·none.',

  // ── routes/bundle.ts — structure tree · guidance for slots to fill ──
  '×{0}대': '×{0} units',
  '(파일 없음 — 예정)': '(no file — planned)',
  '> 이 파일은 **채울 자리 안내**입니다. 도구가 문서를 대신 쓰지 않습니다.':
    '> This file is a **guide to what goes here**. The tool does not write the document for you.',
  '{0} (공정 구성 — 사전 점검)': '{0} (process structure — pre-check)',
  '{0} (사전 점검)': '{0} (pre-check)',
  '# 데이터 연계 — 확인할 점': '# Data linkage — points to check',
  '분석 대상: 설비 {0}대의 OperationalData · 공통 항목(2대 이상) {1}개':
    'Analyzed: OperationalData of {0} machines · {1} common items (shared by 2 or more)',
  '분석에서 빠진 설비(파일 없음): {0}': 'Machines left out of the analysis (no file): {0}',
  '연계 매핑은 **semanticId만으로 잡지 말고 경로(idShort 경로)를 함께** 적습니다.':
    'Do not map linkage **by semanticId alone — record the path (idShort path) as well**.',
  '같은 semanticId를 서로 다른 개념이 쓰는 사례가 실측으로 확인됐습니다(사업 참조모델 30종, 2026-09-30).':
    'Cases where different concepts share the same semanticId were confirmed by measurement (30 program reference models, 2026-09-30).',
  '- 확인할 점 없음': '- Nothing to check',
  'Use-Case 문서 (hwpx 또는 docx + pdf)': 'Use-case document (hwpx or docx + pdf)',
  '목차(안) — 추진방안 §2.2': 'Draft table of contents — implementation plan §2.2',
  '1. 개요: 카테고리, 대상 업종·공정, 현장 문제, **데이터 출처와 증빙 수준(A 현장 적용 / B 실장비 재현 / C 시뮬레이션)**':
    '1. Overview: category, target industry and process, shop-floor problem, **data source and evidence level (A field application / B real-equipment reproduction / C simulation)**',
  '2. 공정 흐름과 장비 구성 — `README.md`의 구성 트리, 「문서용 자료」의 구성도':
    '2. Process flow and equipment structure — the structure tree in `README.md`, the structure diagram from "Document material"',
  '3. Use-Case 시나리오: 붙임6 매핑 근거, 액터, 단계별 흐름': '3. Use-case scenario: basis for the Attachment 6 mapping, actors, step-by-step flow',
  '4. 데이터 연계 구조 — `{0}`': '4. Data linkage structure — `{0}`',
  '5. KPI 산출: 산식, 필요한 Property, 샘플 계산': '5. KPI calculation: formulas, required Properties, sample calculation',
  '6. 실증: BaSyx 통합 적재, REST 조회 예시, 시연 화면': '6. Demonstration: integrated loading into BaSyx, REST query examples, demo screens',
  '7. 중소기업 도입 절차: 다운로드 → 자사 값 입력 → 연동': '7. Adoption steps for SMEs: download → enter your own values → integrate',
  '8. 부록: 용어, 참조 표준, 용어사전 버전': '8. Appendix: terms, reference standards, dictionary version',
  '가이던스 (장비별 1:1)': 'Guidance (one per machine)',
  '아래 설비마다 작성한 가이던스를 넣습니다. 참조모델과 **같은 버전**이어야 합니다.':
    'Add the guidance written for each machine below. It must have **the same version** as the reference model.',
  '샘플 데이터 (KPI 산출용)': 'Sample data (for KPI calculation)',
  '- 🔴 실데이터는 **기업 동의·비식별화 후**에만 넣습니다(GitHub 공개 대상).':
    '- Add real data only **after company consent and de-identification** (it is published on GitHub).',
  '- 가상 PLC 데이터는 파일명과 본문에 **「시뮬레이션」** 을 표기합니다.':
    '- Mark virtual PLC data as **"simulation"** in the file name and the content.',

  // ── routes/bundle.ts — manifest notes ──
  '모델의 공식 검증(KOSMO Validator)은 장비별 AASX를 만들 때 받는 것이다. 여기 lint는 번들에 넣은 모델을 이 도구가 다시 확인한 참고 기록이다.':
    'The official model validation (KOSMO Validator) is obtained when each machine AASX is made. The lint here is a reference record of this tool re-checking the models put in the bundle.',
  '번들 자체의 확인은 해시 대조 · 공정 구성(HIER) · 데이터 연계 · 실동작 증빙으로 한다.':
    'The bundle itself is verified by hash comparison · process structure (HIER) · data linkage · operation evidence.',
  '공정 구성 파일은 참조모델에 포함하지 않는다(설비 필수 서브모델 4종이 없다).':
    'Process structure files are not counted as reference models (they lack the four mandatory machine submodels).',

  // ── routes/bundle.ts — README ──
  '# {0} {1} — 레퍼런스 번들 v{2}': '# {0} {1} — Reference bundle v{2}',
  '- 카테고리: {0}': '- Category: {0}',
  '(미지정)': '(not set)',
  '- 만든 날: {0} · 도구: {1} {2}': '- Created: {0} · Tool: {1} {2}',
  '- 내보낸 사람: {0}': '- Exported by: {0}',
  '- 증빙 수준: **{0}** — {1}': '- Evidence level: **{0}** — {1}',
  '- 증빙 수준: **(사람이 채움 — A 현장 적용 / B 실장비 재현 / C 시뮬레이션)**':
    '- Evidence level: **(to be filled in by a person — A field application / B real-equipment reproduction / C simulation)**',
  '## 공정 구성': '## Process structure',
  '## 포함 참조모델': '## Included reference models',
  '| 파일 | 버전 | SHA256(앞 12자) | 원본 | 사전 점검 |': '| File | Version | SHA256 (first 12) | Original | Pre-check |',
  '| {0} | {1}.{2} | `{3}` | {4} | {5} · 경고 {6} |': '| {0} | {1}.{2} | `{3}` | {4} | {5} · {6} warnings |',
  '올린 파일 그대로': 'As uploaded',
  '⚠ 도구에서 고쳐 다시 포장': 'Edited in the tool and repackaged',
  통과: 'Passed',
  '위반 {0}': '{0} violations',
  '**파일이 없는 설비(예정)**: {0} — 번들 완성 전에 채웁니다.': '**Machines without a file (planned)**: {0} — fill them in before the bundle is complete.',
  '> ⚡ **시연본 포함**: {0} — 수집 연결(AID)이 붙어 있습니다.': '> **Includes demo copies**: {0} — a collection link (AID) is attached.',
  '> 정식 번들에는 수집 연결이 없는 **원본 참조모델**을 넣으십시오.': '> For the official bundle, include the **original reference models** without collection links.',
  '## 실동작 증빙': '## Operation evidence',
  '> 이전 번들({0} v{1})에서 **이어받은 수집 기록**입니다 — 이번에 새로 모은 값은 없습니다.':
    '> This is the **collection record carried over** from the previous bundle ({0} v{1}) — no new values were collected this time.',
  '시연 대신 **수집 기록**을 싣습니다 — `{0}`(인쇄하면 PDF), 전체 값은 `{1}`.':
    'Instead of a live demo, the bundle carries a **collection record** — `{0}` (print it to get a PDF); all values are in `{1}`.',
  '| 설비(형식) | 값을 모은 파일 | 수집 연결 | 기간 | 건수 |': '| Machine (type) | File the values were collected on | Collection link | Period | Samples |',
  '(파생 호기)': '(derived unit)',
  '수집 기록이 없습니다. 이 번들의 설비(또는 「호기별로 나누기」로 만든 호기)를 수집한 뒤 다시 내보내면 여기에 실립니다.':
    'There is no collection record. Collect from the machines in this bundle (or units made with "Split by unit") and export again to include it here.',
  '### 재현 방법 — 누구나 직접 돌려 볼 수 있습니다': '### How to reproduce — anyone can run it',
  '1. AAS 저작 도구(설치판)를 띄우고 **「번들 열기」**로 이 ZIP을 엽니다 — 알림 띠에 해시 일치가 나옵니다':
    '1. Start the AAS authoring tool (installed edition) and open this ZIP with **"Open bundle"** — the notice bar shows the hash match',
  '2. 공정 트리에서 설비를 열고, 오른쪽 수집 칸의 **「가상 PLC로 연결」**을 누릅니다 — 도구 안의 가상 PLC(시뮬레이션)가 그 설비의 운전 데이터 이름대로 태그를 만들고 수집 연결을 만듭니다':
    '2. Open a machine in the process tree and press **"Connect a virtual PLC"** in the collection panel on the right — the built-in virtual PLC (simulation) creates tags named after the machine\'s operational data and makes a collection link',
  '3. **「수집」**을 누르면 값이 들어옵니다(🟢 연결됨). 원본을 건드리지 않으려면 먼저 「호기별로 나누기」로 호기를 만들어 그쪽에서 하십시오':
    '3. Press **"Collect"** and values come in (connected). To leave the original untouched, first make a unit with "Split by unit" and do it there',
  '## 사람이 넣은 문서': '## Documents added by people',
  '| 파일 | 크기 |': '| File | Size |',
  '아직 없습니다 — Use-Case 문서와 장비별 가이던스를 해당 폴더에 넣으십시오(도구 「레퍼런스 번들 → 문서·첨부」에서 올리면 다시 열어도 보존됩니다).':
    'None yet — put the use-case document and the per-machine guidance into their folders (files uploaded in the tool under "Reference bundle → Documents & attachments" are kept when the bundle is reopened).',
  '## 폴더': '## Folders',
  '| 폴더 | 내용 |': '| Folder | Contents |',
  '| {0} | 공정 구성 파일(HierarchicalStructures). 참조모델에 포함하지 않음 |':
    '| {0} | Process structure files (HierarchicalStructures). Not counted as reference models |',
  '| {0} | Use-Case 문서 — 작성 안내 |': '| {0} | Use-case document — writing guide |',
  '| {0} | 설비 참조모델 AASX (해시는 {1}) |': '| {0} | Machine reference model AASX (hashes in {1}) |',
  '| {0} | 장비별 가이던스 — 넣을 목록 |': '| {0} | Per-machine guidance — list of what to add |',
  '| {0} | 연계 항목 초안(CSV) · 확인할 점 |': '| {0} | Draft linkage items (CSV) · points to check |',
  '| {0} | KPI 산출용 샘플 데이터(수집값 CSV) — 비식별화 |': '| {0} | Sample data for KPI calculation (collected-value CSV) — de-identified |',
  '| {0} | 사전 점검 결과서(참고) · 수집 기록서(HTML) |': '| {0} | Pre-check reports (reference) · collection record (HTML) |',
  '> 참조모델의 공식 검증(KOSMO Validator)은 **장비별 AASX를 만들 때** 받은 것입니다. 이 번들의 사전 점검은 넣은 모델을 다시 확인한 참고 기록이고,':
    '> The official validation of the reference models (KOSMO Validator) was obtained **when each machine AASX was made**. The pre-checks in this bundle are reference records of re-checking the included models,',
  '> 번들 자체는 해시 대조 · 공정 구성(HIER) · 데이터 연계 · 실동작 증빙으로 확인합니다.':
    '> and the bundle itself is verified by hash comparison · process structure (HIER) · data linkage · operation evidence.',

  // ── routes/bundle.ts — opening bundles · attachments ──
  '{0}가 없습니다 — 이 도구로 만든 레퍼런스 번들이 아닙니다.': '{0} is missing — this is not a reference bundle made by this tool.',
  '{0}를 읽을 수 없습니다.': 'Cannot read {0}.',
  '지원하지 않는 번들 형식입니다: {0}': 'Unsupported bundle format: {0}',
  '{0}: manifest의 해시와 다릅니다 — 번들을 만든 뒤 파일이 바뀌었습니다.':
    '{0}: does not match the hash in the manifest — the file changed after the bundle was made.',
  '{0}: manifest에 없는 파일입니다.': '{0}: not listed in the manifest.',
  '{0}: manifest에 있는데 번들에 없습니다.': '{0}: listed in the manifest but missing from the bundle.',
  '{0}: 번들 폴더(01·03~06) 밖이라 보관하지 않았습니다.': '{0}: not kept because it is outside the bundle folders (01 · 03–06).',
  '첨부가 없습니다: {0}': 'No such attachment: {0}',
  '본문이 ZIP 바이트가 아닙니다.': 'The body is not ZIP bytes.',

  // ── routes/bundle-files.ts ──
  '쓸 수 없는 경로입니다: {0}': 'This path cannot be used: {0}',
  '첨부는 {0} 폴더 안에만 둡니다.': 'Attachments go only inside the {0} folders.',
  '{0}은(는) 도구가 내보낼 때마다 새로 만드는 파일입니다.': '{0} is a file the tool regenerates on every export.',

  // ── routes/evidence.ts — evidence level · collected-value CSV · collection record ──
  '현장 적용 — Pilot 기업 실제 설비의 수집값(비식별화)': 'Field application — values collected from the pilot company\'s real equipment (de-identified)',
  '실장비 기반 재현 — 실제 태그 구조, 값은 가공': 'Reproduction on real equipment — real tag structure, processed values',
  '시뮬레이션 — 가상 PLC 값': 'Simulation — virtual PLC values',
  '(주소 없음)': '(no address)',
  '(비공개)': '(hidden)',
  시각: 'Time',
  '설비(형식)': 'Machine (type)',
  호기: 'Unit',
  인터페이스: 'Interface',
  항목: 'Item',
  '읽은 주소': 'Read address',
  값: 'Value',
  품질: 'Quality',
  '증빙 수준 {0} — {1}': 'Evidence level {0} — {1}',
  '증빙 수준 미지정 — 사람이 채울 것(A 현장 / B 재현 / C 시뮬레이션)':
    'Evidence level not set — to be filled in by a person (A field / B reproduction / C simulation)',
  '최소 {0} · 평균 {1} · 최대 {2}': 'min {0} · avg {1} · max {2}',
  전부: 'All',
  '형식 모델': 'Type model',
  '값을 모은 파일': 'File the values were collected on',
  '(형식 파일에 직접 연결)': '(connected directly to the type file)',
  '(형식에서 파생된 호기 — derivedFrom)': '(unit derived from the type — derivedFrom)',
  '수집 연결': 'Collection link',
  '(연결 정보 없음)': '(no connection info)',
  기간: 'Period',
  '(약 {0}분)': '(about {0} min)',
  '수집 건수': 'Samples collected',
  '{0}건{1} · 항목 {2}개': '{0} samples{1} · {2} items',
  '(상한에 걸려 최근 것만)': '(limit reached — most recent only)',
  정상: 'Good',
  '마지막 값': 'Last value',
  분포: 'Distribution',
  추이: 'Trend',
  '수집 기록서 — {0}': 'Collection record — {0}',
  '만든 시각 {0} · {1} · 설비 {2}곳 · 수집 {3}건': 'Created {0} · {1} · machines: {2} · samples: {3}',
  '· 값은 이 도구가 수집 연결(AID, IDTA 02017)로 읽어 저장소에 쌓은 기록 그대로입니다. 모델(AASX)에는 되쓰지 않습니다(값 동기화 A안).':
    '· Values are the records this tool read through collection links (AID, IDTA 02017) and stored, unchanged. They are not written back to the model (AASX) (value sync option A).',
  '· 전체 값은 <code>{0}</code>에 있습니다. KPI(가동률 등) 계산은 그 CSV로 합니다.':
    '· All values are in <code>{0}</code>. Calculate KPIs (availability, etc.) from that CSV.',
  '· 현장 설비 주소는 공개 번들이므로 가렸습니다. 자기 PC 주소(127.0.0.1)는 재현용으로 그대로 둡니다.':
    '· Field equipment addresses are hidden because the bundle is public. The local PC address (127.0.0.1) is kept for reproduction.',
};
