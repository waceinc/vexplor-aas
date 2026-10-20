[English](kosmo-compat.md) · **한국어**

# KOSMO 참조모델 호환 측정

KOSMO 공개 참조모델(장비별 AAS 참조모델)을 VEXPLOR AAS Studio 로 하나씩 열고 검사한 결과입니다.
쓰는 순서는 [README](../README.ko.md#kosmo-참조모델과-함께-쓰기) 와 [사용법 §10](사용법.md#kosmo-참조모델과-함께-쓰기) 에 있습니다.

## 무엇을 쟀나

| 항목 | 값 |
|---|---|
| 측정한 날 | 2026-10-20 |
| 대상 저장소 | [kosmo-AAS/kasmo-AAS_Pubilc](https://github.com/kosmo-AAS/kasmo-AAS_Pubilc) (저장소 이름의 철자 그대로) |
| 대상 커밋 | `6f6ac69aece946b9531c9051d5970a72bcbf81c6` (2026-06-23) |
| AAS Studio | 2.12.1 |
| 파일 | AASX **179개** — `2025_KPC_Public` 60 · `2025_MICUBE_Public` 60 · `ABH_MICUBE_IMPIX-main` 32 · `LSELECTRIC_OCUBY-main` 27 |

파일마다 아래 순서로 쟀습니다. 모두 이 저장소의 라이브러리(`@aas/aasx` · `@aas/linter` · `@aas/core`)를 그대로 불렀습니다.

1. **열기** — `readAasx(파일)`. 판정된 메타모델 버전과 그 출처(`metamodel.version` · `source`)를 남깁니다.
2. **검사** — `lint(environment, ALL_RULES, { package: opc, metamodel })`. 규칙 52종 전부를 **파일의 버전으로** 판정합니다(2.9.0 이후 방식).
3. **왕복** — 읽은 그대로 `writeAasx` 로 쓰고 다시 `readAasx` 로 읽어, 본문(정렬한 JSON)이 같은지 봅니다.
4. **3.1 내보내기** — `writeAasxWithReport(pkg, { version: '3.1', encodePaths: true })`. 잃는 값의 수를 세고, 다시 읽은 본문이 원래와 같은지, 3.1 공식 JSON 스키마(`tests/fixtures/idta-metamodel/3.1`, ajv draft 2019-09)를 통과하는지 봅니다.

### 측정 방법 — 다시 재려면

참조모델 파일은 이 저장소에 없으므로 원 저장소를 따로 내려받아 그 폴더를 넘깁니다. 아래 두 번째 명령이 요약 표의 열림 · 검사 · 왕복 · 3.1 내보내기 숫자를 냅니다.

```bash
git clone https://github.com/kosmo-AAS/kasmo-AAS_Pubilc /tmp/kosmo
git -C /tmp/kosmo checkout 6f6ac69aece946b9531c9051d5970a72bcbf81c6
# 이 저장소에서
npm ci && npx tsc -b
node scripts/lint.mjs /tmp/kosmo     # 파일별 지적 (하위 폴더 포함, 파일 자신의 버전으로 판정)
node --input-type=module -e '
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readAasx, writeAasx, writeAasxWithReport } from "@aas/aasx";
import { canonicalJson, writeEnvironment } from "@aas/core";
import { ALL_RULES, lint } from "@aas/linter";
import { Ajv2019 } from "ajv/dist/2019.js";
const schema31 = new Ajv2019({ strict: false, unicodeRegExp: false })
  .compile(JSON.parse(readFileSync("tests/fixtures/idta-metamodel/3.1/aas.schema.json", "utf8")));
const files = readdirSync(process.argv[1], { recursive: true }).filter((f) => f.endsWith(".aasx"));
const n = { files: files.length, checked: 0, sameAfterRoundTrip: 0, written31: 0, dropped31: 0, refused31: 0, schema31: 0 };
for (const f of files) {
  const pkg = readAasx(new Uint8Array(readFileSync(join(process.argv[1], f))));
  lint(pkg.environment, ALL_RULES, { package: pkg.opc, metamodel: pkg.metamodel }); n.checked++;
  if (canonicalJson(readAasx(writeAasx(pkg)).environment) === canonicalJson(pkg.environment)) n.sameAfterRoundTrip++;
  try {
    const { data, report } = writeAasxWithReport(pkg, { version: "3.1", encodePaths: true });
    n.written31++; n.dropped31 += report.entries.filter((e) => e.kind === "dropped").length;
    if (schema31(JSON.parse(writeEnvironment(readAasx(data).environment, { version: "3.1" }).text))) n.schema31++;
  } catch { n.refused31++; }
}
console.log(n);' /tmp/kosmo
```

## 요약

| 항목 | 결과 |
|---|---|
| 열림 | **179 / 179** — 본문은 모두 XML 이고, 열 때 JSON 으로 바뀝니다 |
| 메타모델 버전 | **3.0 — 179개 모두** (XML 네임스페이스 `https://admin-shell.io/aas/3/0` 로 선언). 3.1 · 3.2 선언 파일 0개 |
| 검사가 끝까지 돈 파일 | **179 / 179** |
| 오류 0 인 파일 | 0 / 179 |
| 지적 수 (179개 합계) | L1 오류 12,182 · 정보 35 / L2 오류 48,117 · 경고 77 / L3 오류 152,445 · 경고 5,769 · 정보 2,561 |
| 오류 212,744건의 내용 | 빈 Property 값(`KOSMO-SME-4`) 64,357 — 참조모델이 값을 비워 둔 틀이라 생기며 설비 값을 채우면 줄어듭니다 · **자동 고치기 대상 146,106** · 나머지 2,281 은 사람이 고칩니다 |
| 왕복 | **179 / 179 같음** — 저장한 사본은 모두 다시 열립니다 |
| 3.1 내보내기 | 잃는 값 0 으로 씀 **156** (다시 읽은 본문이 원래와 같음) · 거부 23 (한 글자 idShort `Q` · `T` · `X` 등 3.1 이 받지 않는 값 — 이름을 먼저 바꿔야 함) |
| 3.1 공식 스키마 | 내보낸 156개 중 **33 통과**. 나머지는 원본에 빈 값이 있어서입니다 — 빈 LangString text · 빈 unit · 빈 idShort 같은 빈 문자열과, 항목 없이 닫힌 목록(`<description />` 등 — 스키마는 1개 이상을 요구). 자동 고치기와 값 채우기로 대부분 없어집니다 |

### 지적이 많은 규칙 (179개 합계)

| 규칙 | 단계 · 등급 | 건수 | 파일 | 자동 고치기 | 내용 |
|---|---|---|---|---|---|
| `KOSMO-SME-4` | L3 오류 | 64,357 | 179 | 아니오 | Property 에 값이 없음 — 설비 값을 채울 자리 |
| `AASd-121~128` | L2 오류 | 42,091 | 60 | 예 | Reference 키 사슬 — ExternalReference 의 첫 · 끝 키가 GlobalReference 가 아님(대개 `ConceptDescription`) |
| `KOSMO-CD-2` | L3 오류 | 35,046 | 176 | 예 | ConceptDescription id 가 IRDI 나 허용한 자체 IRI 가 아님 |
| `KOSMO-CD-4` | L3 오류 | 28,378 | 179 | 예 | dataType 이 없거나 KOSMO 허용 목록 밖 |
| `KOSMO-SME-5` | L3 오류 | 13,411 | 164 | 예 | Property valueType 과 CD dataType 불일치 |
| `PKG-EMPTY-ARRAY` | L1 오류 | 9,197 | 61 | 예 | 항목 없이 닫힌 목록이 남아 있음 |
| `KOSMO-CD-5` | L3 경고 · 오류 · 정보 | 5,719 · 2,897 · 2,561 | 178 | 일부 | 같은 id · idShort 의 CD 중복 |
| `KOSMO-SME-3` | L3 오류 | 4,231 | 146 | 예 | semanticId 가 없거나 같은 id 의 CD 가 없음 |
| `AASc-3a-002` | L2 오류 | 4,005 | 103 | 예 | CD preferredName 에 영문이 없음 |
| `PKG-LANG-DUP` | L1 오류 | 2,965 | 173 | 예 | 한 LangString 안에 같은 언어 태그(대개 `en`)가 두 번 |
| `KOSMO-CD-3` | L3 오류 | 1,350 | 100 | 아니오 | 영문 정의(definition)가 없음 |

규칙의 근거와 정책은 [규칙 목록](규칙_목록.md) 과 [사용법 §10](사용법.md) 에 있습니다. **최종 합격 판정은 제출처의 검증기가 합니다.**

## 2.12.1 에서 고친 것 — 빈 목록 요소

일부 파일의 XML 에는 항목 없이 닫힌 목록 요소가 있습니다(예: `<qualifiers />` · `<description />` · `<keys />` · 컬렉션의
`<value />`). 2.12.0 은 이것을 빈 목록이 아니라 빈 문자열로 읽어, 이런 요소가 있는 61개 파일 가운데 45개에서 검사가 중간에
멈추고 27개는 저장한 사본을 다시 열지 못했습니다. **2.12.1 에서 고쳤습니다** — 빈 목록으로 읽고, 검사는 그 자리를
`PKG-EMPTY-ARRAY` 로 알려 줍니다(자동 고치기로 지울 수 있음). 위 숫자는 고친 뒤에 잰 것입니다.
고치기 전에 가려져 있던 지적(그 45개 파일의 `AASd-121~128` 등)이 함께 드러나, 지적 합계는 2.12.0 때보다 큽니다.

## 라이선스

측정한 커밋의 대상 저장소에는 라이선스 표시가 없습니다(LICENSE 파일 없음, GitHub 라이선스 칸 비어 있음).
그래서 이 저장소는 그 AASX 파일을 싣지 않고(시험 파일로도 넣지 않음) 링크만 둡니다. 파일은 원 저장소에서 내려받고,
다시 배포하려면 제공처의 조건을 먼저 확인하십시오.

## 파일별 결과

- **검사**: 완료 = 규칙 52종이 끝까지 돎
- **L1 · L2 · L3**: 오류 / 경고 건수(정보는 빼고 셈)
- **왕복**: 읽은 그대로 쓰고 다시 읽은 본문이 같은가
- **3.1 내보내기**: 잃는 값 수와 3.1 공식 스키마 결과. 거부 = 3.1 이 받지 않는 값이 있어 쓰지 않음(다운로드 화면의 「쓸 수 없는 값」과 같음)

| # | 파일 (저장소 안 경로) | 메타모델 | 검사 | L1 오류 / 경고 | L2 오류 / 경고 | L3 오류 / 경고 | 왕복 | 3.1 내보내기 |
|---|---|---|---|---|---|---|---|---|
| 1 | `2025_KPC_Public/INTERX/01. 수치제어 방전가공기/[공.9]NumericalControlElectricalDischargeMachine.aasx` | 3.0 | 완료 | 9 / 0 | 31 / 0 | 1143 / 53 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 2 | `2025_KPC_Public/INTERX/02. 스피닝기/[공.11]SpinningMachine.aasx` | 3.0 | 완료 | 8 / 0 | 37 / 0 | 1574 / 41 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 3 | `2025_KPC_Public/INTERX/03. 전해가공기/[공.13]ElectrochemicalMachine.aasx` | 3.0 | 완료 | 8 / 0 | 28 / 0 | 1309 / 40 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 4 | `2025_KPC_Public/INTERX/04. 플레이너/[공.14]Planner.aasx` | 3.0 | 완료 | 8 / 0 | 32 / 0 | 1403 / 42 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 5 | `2025_KPC_Public/INTERX/05. 세이핑기/[공.15]ShapingMachine.aasx` | 3.0 | 완료 | 8 / 0 | 13 / 0 | 1428 / 42 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 6 | `2025_KPC_Public/INTERX/06. 브로칭기/[공.17]BroachingMachine.aasx` | 3.0 | 완료 | 8 / 0 | 33 / 0 | 1473 / 43 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 7 | `2025_KPC_Public/INTERX/07. 유압식 프레스/[공.26]HydraulicPress.aasx` | 3.0 | 완료 | 9 / 0 | 70 / 0 | 1671 / 64 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 8 | `2025_KPC_Public/INTERX/08. 복사파식(복사식) 건조기/[범.23]RadiantHeatDryer.aasx` | 3.0 | 완료 | 8 / 0 | 37 / 0 | 1439 / 40 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 9 | `2025_KPC_Public/INTERX/09. 플라즈마식 절단기/[범.40]PlasmaCuttingMachine.aasx` | 3.0 | 완료 | 8 / 0 | 44 / 0 | 1554 / 46 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 10 | `2025_KPC_Public/INTERX/10. 레이저식 절단기/[범.41]LaserCuttingMachine.aasx` | 3.0 | 완료 | 9 / 0 | 17 / 0 | 1466 / 41 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 11 | `2025_KPC_Public/INTERX/11. 수치제어 절단기/[범.43]NumericalControlCuttingMachine.aasx` | 3.0 | 완료 | 8 / 0 | 36 / 0 | 1479 / 40 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 12 | `2025_KPC_Public/INTERX/12. 기계식 절단기/[범.44]MechanicalCuttingMachine.aasx` | 3.0 | 완료 | 8 / 0 | 32 / 0 | 1439 / 40 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 13 | `2025_KPC_Public/INTERX/13. 교류직류전원 공급장치/[범.70]Rectifier.aasx` | 3.0 | 완료 | 8 / 0 | 23 / 0 | 1263 / 40 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 14 | `2025_KPC_Public/INTERX/14. 자동전압조정장치/[범.72]AutomaticVoltageRegulator.aasx` | 3.0 | 완료 | 8 / 0 | 33 / 0 | 1269 / 43 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 15 | `2025_KPC_Public/INTERX/15. 아크 용접용 로봇/[로.7]ArcWeldingRobot.aasx` | 3.0 | 완료 | 8 / 0 | 36 / 0 | 1373 / 40 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 16 | `2025_KPC_Public/INTERX/16. 스폿 용접용 로봇/[로.8]SpotWeldingRobot.aasx` | 3.0 | 완료 | 8 / 0 | 36 / 0 | 1358 / 40 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 17 | `2025_KPC_Public/INTERX/17. 부품 조립 및 분해 로봇/[로.10]PartAssemblyDisassemblyRobot.aasx` | 3.0 | 완료 | 8 / 0 | 39 / 0 | 1424 / 39 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 18 | `2025_KPC_Public/INTERX/18. 마킹 및 라벨링용 로봇/[로.12]MarkingLabelingRobot.aasx` | 3.0 | 완료 | 8 / 0 | 52 / 0 | 1554 / 41 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 19 | `2025_KPC_Public/INTERX/19. 절단용 로봇/[로.15]CuttingRobot.aasx` | 3.0 | 완료 | 8 / 0 | 44 / 0 | 1564 / 42 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 20 | `2025_KPC_Public/INTERX/20. 벨트식 컨베이어/[기.1]BeltConveyor.aasx` | 3.0 | 완료 | 8 / 0 | 9 / 0 | 1042 / 39 | 같음 | 잃는 값 0 · 스키마 합격 |
| 21 | `2025_KPC_Public/INTERX/21. 로울러식 컨베이어/[기.2]RollerTypeConveyor.aasx` | 3.0 | 완료 | 8 / 0 | 31 / 0 | 1024 / 40 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 22 | `2025_KPC_Public/INTERX/22. 체인식 컨베이어/[기.3]ChainTypeConveyor.aasx` | 3.0 | 완료 | 11 / 0 | 10 / 0 | 1031 / 41 | 같음 | 잃는 값 0 · 스키마 합격 |
| 23 | `2025_KPC_Public/INTERX/23. 무전해 도금조/[뿌.10]ElectrolessPlatingBath.aasx` | 3.0 | 완료 | 8 / 0 | 30 / 0 | 1364 / 43 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 24 | `2025_KPC_Public/INTERX/24. 질화로/[뿌.37]NitridingFurnace.aasx` | 3.0 | 완료 | 8 / 0 | 38 / 0 | 1500 / 41 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 25 | `2025_KPC_Public/INTERX/25. 침탄로/[뿌.40]CarburizingFurnace.aasx` | 3.0 | 완료 | 8 / 0 | 33 / 0 | 1581 / 39 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 26 | `2025_KPC_Public/INTERX/26. 탈지조/[뿌.46]DegreasingTank.aasx` | 3.0 | 완료 | 8 / 0 | 37 / 0 | 1443 / 41 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 27 | `2025_KPC_Public/INTERX/27. 템퍼링로/[뿌.60]TemperingFurnance.aasx` | 3.0 | 완료 | 8 / 0 | 37 / 0 | 1461 / 41 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 28 | `2025_KPC_Public/INTERX/28. 용체화로/[뿌.61]SolutionHeatTreatmentFurnace.aasx` | 3.0 | 완료 | 8 / 0 | 11 / 0 | 1527 / 40 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 29 | `2025_KPC_Public/INTERX/29. 균질화로/[뿌.62]HomogenizingFurnace.aasx` | 3.0 | 완료 | 8 / 0 | 46 / 0 | 1483 / 39 | 같음 | 잃는 값 0 · 스키마 합격 |
| 30 | `2025_KPC_Public/INTERX/30. 이산화탄소 용접기/[뿌.76]Co2WeldingMachine.aasx` | 3.0 | 완료 | 8 / 0 | 38 / 0 | 1302 / 41 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 31 | `2025_KPC_Public/INTERX/31. 마찰교반 용접기/[뿌.78]FrictionStirWeldingMachine.aasx` | 3.0 | 완료 | 8 / 0 | 42 / 0 | 1338 / 40 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 32 | `2025_KPC_Public/INTERX/32. 반도체회로 에칭장비/[일.6]SemiconductorCircuitEtchingEquipment.aasx` | 3.0 | 완료 | 8 / 0 | 36 / 0 | 1458 / 43 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 33 | `2025_KPC_Public/INTERX/33. 도금두께 측정기/[신규.1]PlatingThicknessGauge.aasx` | 3.0 | 완료 | 8 / 0 | 43 / 0 | 1779 / 45 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 34 | `2025_KPC_Public/INTERX/34. 산수세기/[신규.3]AcidRinsingMachine.aasx` | 3.0 | 완료 | 8 / 0 | 31 / 0 | 1386 / 43 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 35 | `2025_KPC_Public/INTERX/35. 전해 도금조/[신규.2]ElectroplatingBath.aasx` | 3.0 | 완료 | 8 / 0 | 13 / 0 | 1361 / 43 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 36 | `2025_KPC_Public/KPC/01. 코팅기/코팅기.aasx` | 3.0 | 완료 | 13 / 0 | 0 / 0 | 1140 / 19 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 37 | `2025_KPC_Public/KPC/02. 래핑기/래핑기.aasx` | 3.0 | 완료 | 12 / 0 | 0 / 0 | 1127 / 18 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 38 | `2025_KPC_Public/KPC/03. AMR/AMR.aasx` | 3.0 | 완료 | 16 / 0 | 0 / 0 | 1144 / 16 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 39 | `2025_KPC_Public/KPC/04. 크레인/crane.aasx` | 3.0 | 완료 | 12 / 0 | 0 / 0 | 1130 / 18 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 40 | `2025_KPC_Public/KPC/05. 레이저스캐너/레이저스캐너.aasx` | 3.0 | 완료 | 12 / 0 | 0 / 0 | 1125 / 18 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 41 | `2025_KPC_Public/KPC/06. 산세처리기/산세처리기.aasx` | 3.0 | 완료 | 12 / 0 | 0 / 0 | 1293 / 59 | 같음 | 거부 — 한 글자 idShort 등 15건 |
| 42 | `2025_KPC_Public/KPC/07. 핫러너장치/핫러너장치.aasx` | 3.0 | 완료 | 12 / 0 | 0 / 0 | 1152 / 18 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 43 | `2025_KPC_Public/KPC/08. 전조기/전조기.aasx` | 3.0 | 완료 | 13 / 0 | 0 / 0 | 1107 / 16 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 44 | `2025_KPC_Public/KPC/09. 정련기/정련기.aasx` | 3.0 | 완료 | 12 / 0 | 0 / 0 | 1140 / 18 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 45 | `2025_KPC_Public/KPC/10. 표면처리기/표면처리기.aasx` | 3.0 | 완료 | 13 / 0 | 0 / 0 | 1281 / 59 | 같음 | 거부 — 한 글자 idShort 등 15건 |
| 46 | `2025_KPC_Public/한국생산기술연구원/01. 기계식 프레스/01_MachinePress_V0.9.9.aasx` | 3.0 | 완료 | 13 / 0 | 14 / 0 | 252 / 9 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 47 | `2025_KPC_Public/한국생산기술연구원/02. 열전도식(전도식) 건조기/04_HeatConductionDryer_V0.9.8.aasx` | 3.0 | 완료 | 13 / 0 | 8 / 0 | 650 / 60 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 48 | `2025_KPC_Public/한국생산기술연구원/03. 플라스틱사출품 취출로봇/02_PartRemovalRobot_V0.9.8.aasx` | 3.0 | 완료 | 14 / 0 | 19 / 0 | 1118 / 278 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 49 | `2025_KPC_Public/한국생산기술연구원/04. 보온로/03_HoldingFurnace_V0.9.8.aasx` | 3.0 | 완료 | 13 / 0 | 18 / 0 | 1139 / 260 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 50 | `2025_KPC_Public/한국생산기술연구원/05. 분말성형장치/02_PowderCompactingPress_V0.9.8.aasx` | 3.0 | 완료 | 14 / 0 | 14 / 0 | 236 / 21 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 51 | `2025_KPC_Public/한국생산기술연구원/06. 소결로/02_VaccumSinteringFurnace_V0.9.8.aasx` | 3.0 | 완료 | 13 / 0 | 5 / 0 | 536 / 21 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 52 | `2025_KPC_Public/한국생산기술연구원/07. 언코일러/01_Uncoiler_V0.9.8.aasx` | 3.0 | 완료 | 13 / 0 | 14 / 0 | 143 / 5 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 53 | `2025_KPC_Public/한국생산기술연구원/08. 취출기/03_Ejector_V0.9.8.aasx` | 3.0 | 완료 | 13 / 0 | 19 / 0 | 1121 / 269 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 54 | `2025_KPC_Public/한국생산기술연구원/09. 탈지수세전처리기/04_DegreasingPreWashMachine_V0.9.8.aasx` | 3.0 | 완료 | 13 / 0 | 19 / 0 | 1109 / 252 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 55 | `2025_KPC_Public/한국생산기술연구원/10. 플라즈마전처리기/04_PlasmaPretreatementEquipment_V0.9.8.aasx` | 3.0 | 완료 | 14 / 0 | 28 / 0 | 1182 / 281 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 56 | `2025_KPC_Public/한국생산기술연구원/11. 혼련기/02_PowderMixer_V0.9.8.aasx` | 3.0 | 완료 | 15 / 0 | 9 / 0 | 539 / 31 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 57 | `2025_KPC_Public/한국생산기술연구원/12. 냉가압식 다이캐스팅/03_ColdChamberDiecastingMachine_V0.9.8.aasx` | 3.0 | 완료 | 14 / 0 | 14 / 0 | 236 / 11 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 58 | `2025_KPC_Public/한국생산기술연구원/13. 사상기/03_DeburringMachine_V0.9.8.aasx` | 3.0 | 완료 | 7 / 0 | 9 / 0 | 540 / 13 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 59 | `2025_KPC_Public/한국생산기술연구원/14. 레벨러/01_Leveller_V0.9.8.aasx` | 3.0 | 완료 | 14 / 0 | 14 / 0 | 155 / 7 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 60 | `2025_KPC_Public/한국생산기술연구원/15. 피더/01_NC_Roll_Feeder_V0.9.8.aasx` | 3.0 | 완료 | 14 / 0 | 14 / 0 | 143 / 5 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 61 | `2025_MICUBE_Public/ABH/01. 선반(터닝센터)/1. TurningCenter.aasx` | 3.0 | 완료 | 23 / 0 | 0 / 0 | 668 / 24 | 같음 | 잃는 값 0 · 스키마 합격 |
| 62 | `2025_MICUBE_Public/ABH/02. 밀링기/2. MillingMachine.aasx` | 3.0 | 완료 | 23 / 0 | 0 / 0 | 670 / 22 | 같음 | 잃는 값 0 · 스키마 합격 |
| 63 | `2025_MICUBE_Public/ABH/03. 드릴링기/16. DrillingMachine.aasx` | 3.0 | 완료 | 23 / 0 | 0 / 0 | 910 / 20 | 같음 | 잃는 값 0 · 스키마 합격 |
| 64 | `2025_MICUBE_Public/ABH/04. 보링기/10. BoringMachine.aasx` | 3.0 | 완료 | 23 / 0 | 0 / 0 | 831 / 28 | 같음 | 잃는 값 0 · 스키마 합격 |
| 65 | `2025_MICUBE_Public/ABH/05. 기어가공기/6. GearMachiningMachine.aasx` | 3.0 | 완료 | 23 / 0 | 0 / 0 | 1057 / 29 | 같음 | 잃는 값 0 · 스키마 합격 |
| 66 | `2025_MICUBE_Public/ABH/06. 와이어 컷 방전 가공기/19. WirecutElectricalDischargeMachining.aasx` | 3.0 | 완료 | 9 / 0 | 0 / 0 | 679 / 17 | 같음 | 잃는 값 0 · 스키마 합격 |
| 67 | `2025_MICUBE_Public/ABH/07. 초음파 가공기/15. UltrasonicDrillingMachine.aasx` | 3.0 | 완료 | 6 / 0 | 0 / 0 | 630 / 0 | 같음 | 잃는 값 0 · 스키마 합격 |
| 68 | `2025_MICUBE_Public/ABH/08. 슬로팅기/7. SlottingMachine.aasx` | 3.0 | 완료 | 23 / 0 | 0 / 0 | 1008 / 38 | 같음 | 잃는 값 0 · 스키마 합격 |
| 69 | `2025_MICUBE_Public/ABH/09. 호닝기/11. HoningMachine.aasx` | 3.0 | 완료 | 23 / 0 | 0 / 0 | 1010 / 81 | 같음 | 잃는 값 0 · 스키마 합격 |
| 70 | `2025_MICUBE_Public/ABH/10. 키홈가공기/3. KeywayMachine.aasx` | 3.0 | 완료 | 23 / 0 | 0 / 0 | 673 / 25 | 같음 | 잃는 값 0 · 스키마 합격 |
| 71 | `2025_MICUBE_Public/ABH/11. 버핑기/9. BuffingMachine.aasx` | 3.0 | 완료 | 23 / 0 | 0 / 0 | 1164 / 81 | 같음 | 잃는 값 0 · 스키마 합격 |
| 72 | `2025_MICUBE_Public/ABH/12. 슈퍼피니싱기/12. SuperFinishing.aasx` | 3.0 | 완료 | 23 / 0 | 0 / 0 | 827 / 28 | 같음 | 잃는 값 0 · 스키마 합격 |
| 73 | `2025_MICUBE_Public/ABH/13. 금속 3D프린터(소형)/20. Metal3DPrinter.aasx` | 3.0 | 완료 | 9 / 0 | 0 / 0 | 672 / 17 | 같음 | 잃는 값 0 · 스키마 합격 |
| 74 | `2025_MICUBE_Public/ABH/14. 세척기/5. PartsWasher.aasx` | 3.0 | 완료 | 23 / 0 | 0 / 0 | 670 / 24 | 같음 | 잃는 값 0 · 스키마 합격 |
| 75 | `2025_MICUBE_Public/ABH/15. 절곡기/14. BendingMachine.aasx` | 3.0 | 완료 | 23 / 0 | 0 / 0 | 994 / 24 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 76 | `2025_MICUBE_Public/ABH/16. 리파이너/18. Refiner.aasx` | 3.0 | 완료 | 23 / 0 | 0 / 0 | 1010 / 24 | 같음 | 잃는 값 0 · 스키마 합격 |
| 77 | `2025_MICUBE_Public/ABH/17. 유체정화기/13. FluidPurifier.aasx` | 3.0 | 완료 | 23 / 0 | 0 / 0 | 1066 / 85 | 같음 | 잃는 값 0 · 스키마 합격 |
| 78 | `2025_MICUBE_Public/ABH/18. 연마용 및 디버링 로봇/4. PolishingAndDeburringRobot.aasx` | 3.0 | 완료 | 23 / 0 | 0 / 0 | 668 / 26 | 같음 | 잃는 값 0 · 스키마 합격 |
| 79 | `2025_MICUBE_Public/ABH/19. 초음파 용접기/17. UltrasonicWeldingMachine.aasx` | 3.0 | 완료 | 23 / 0 | 0 / 0 | 999 / 24 | 같음 | 잃는 값 0 · 스키마 합격 |
| 80 | `2025_MICUBE_Public/ABH/20. 샷피닝기/8. ShotPeeningMachine.aasx` | 3.0 | 완료 | 23 / 0 | 0 / 0 | 897 / 26 | 같음 | 잃는 값 0 · 스키마 합격 |
| 81 | `2025_MICUBE_Public/IMPIX/01.  라벨기/라벨기.aasx` | 3.0 | 완료 | 47 / 0 | 0 / 4 | 766 / 21 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 82 | `2025_MICUBE_Public/IMPIX/02. 멸균기/멸균기.aasx` | 3.0 | 완료 | 47 / 0 | 0 / 4 | 866 / 37 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 83 | `2025_MICUBE_Public/IMPIX/03. 염색가공기/염색가공기.aasx` | 3.0 | 완료 | 50 / 0 | 0 / 4 | 762 / 20 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 84 | `2025_MICUBE_Public/IMPIX/04. 염지기/염지기.aasx` | 3.0 | 완료 | 50 / 0 | 0 / 3 | 735 / 19 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 85 | `2025_MICUBE_Public/IMPIX/05. 원단적재기/원단적재기.aasx` | 3.0 | 완료 | 47 / 0 | 0 / 3 | 769 / 21 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 86 | `2025_MICUBE_Public/IMPIX/06. 텐터기/텐터기.aasx` | 3.0 | 완료 | 47 / 0 | 0 / 3 | 769 / 21 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 87 | `2025_MICUBE_Public/IMPIX/07. 과립기/과립기.aasx` | 3.0 | 완료 | 47 / 0 | 0 / 4 | 734 / 18 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 88 | `2025_MICUBE_Public/IMPIX/08. 러버코팅기/러버코팅기.aasx` | 3.0 | 완료 | 47 / 0 | 0 / 4 | 802 / 18 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 89 | `2025_MICUBE_Public/IMPIX/09. 숙성기/숙성기.aasx` | 3.0 | 완료 | 47 / 0 | 0 / 4 | 736 / 18 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 90 | `2025_MICUBE_Public/IMPIX/10. 정제코팅기/정제코팅기.aasx` | 3.0 | 완료 | 47 / 0 | 0 / 4 | 734 / 18 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 91 | `2025_MICUBE_Public/IMPIX/11. 칭량기/칭량기.aasx` | 3.0 | 완료 | 47 / 0 | 0 / 4 | 800 / 18 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 92 | `2025_MICUBE_Public/IMPIX/12. 커팅기/커팅기.aasx` | 3.0 | 완료 | 47 / 0 | 0 / 4 | 802 / 18 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 93 | `2025_MICUBE_Public/IMPIX/13. 타정기/타정기.aasx` | 3.0 | 완료 | 47 / 0 | 0 / 4 | 736 / 18 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 94 | `2025_MICUBE_Public/IMPIX/14. 파우칭기/파우칭기.aasx` | 3.0 | 완료 | 47 / 0 | 0 / 4 | 711 / 18 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 95 | `2025_MICUBE_Public/IMPIX/15. 혼합기/혼합기.aasx` | 3.0 | 완료 | 47 / 0 | 0 / 4 | 736 / 18 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 96 | `2025_MICUBE_Public/IMPIX/16. IV테스트기/iv테스트기.aasx` | 3.0 | 완료 | 47 / 0 | 0 / 4 | 782 / 18 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 97 | `2025_MICUBE_Public/IMPIX/17. 라미네이션/라미네이션.aasx` | 3.0 | 완료 | 47 / 0 | 0 / 4 | 712 / 18 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 98 | `2025_MICUBE_Public/IMPIX/18. 태빙기/태빙기.aasx` | 3.0 | 완료 | 47 / 0 | 0 / 4 | 763 / 18 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 99 | `2025_MICUBE_Public/IMPIX/19. 트리밍기/트리밍기.aasx` | 3.0 | 완료 | 47 / 0 | 0 / 4 | 788 / 18 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 100 | `2025_MICUBE_Public/IMPIX/20. 프레임조립기/프레임조립기.aasx` | 3.0 | 완료 | 47 / 0 | 0 / 4 | 741 / 18 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 101 | `2025_MICUBE_Public/MICUBE/01. 연삭기/GrindingMachine.aasx` | 3.0 | 완료 | 20 / 0 | 0 / 0 | 688 / 14 | 같음 | 거부 — 한 글자 idShort 등 10건 |
| 102 | `2025_MICUBE_Public/MICUBE/02. 연마기/PolishingMachine.aasx` | 3.0 | 완료 | 20 / 0 | 0 / 0 | 683 / 11 | 같음 | 거부 — 한 글자 idShort 등 10건 |
| 103 | `2025_MICUBE_Public/MICUBE/03. 통기식(대류식) 건조기/ConvectionDryer.aasx` | 3.0 | 완료 | 20 / 0 | 0 / 0 | 684 / 12 | 같음 | 거부 — 한 글자 idShort 등 10건 |
| 104 | `2025_MICUBE_Public/MICUBE/04. 입자유동식(대류식) 건조기/FluidizedBedDryer.aasx` | 3.0 | 완료 | 20 / 0 | 0 / 0 | 686 / 12 | 같음 | 거부 — 한 글자 idShort 등 10건 |
| 105 | `2025_MICUBE_Public/MICUBE/05. 분진용 집진장치/DustCollector.aasx` | 3.0 | 완료 | 22 / 0 | 0 / 0 | 549 / 10 | 같음 | 잃는 값 0 · 스키마 합격 |
| 106 | `2025_MICUBE_Public/MICUBE/06. 흄 집진장치/FumeExtractor.aasx` | 3.0 | 완료 | 22 / 0 | 0 / 0 | 545 / 10 | 같음 | 잃는 값 0 · 스키마 합격 |
| 107 | `2025_MICUBE_Public/MICUBE/07. 오일미스트식 집진장치/OilMistCollector.aasx` | 3.0 | 완료 | 19 / 0 | 0 / 0 | 552 / 8 | 같음 | 잃는 값 0 · 스키마 합격 |
| 108 | `2025_MICUBE_Public/MICUBE/08. 히터/Heater.aasx` | 3.0 | 완료 | 20 / 0 | 0 / 0 | 690 / 11 | 같음 | 거부 — 한 글자 idShort 등 10건 |
| 109 | `2025_MICUBE_Public/MICUBE/09. 자동권선기/AutomaticWindingMachine.aasx` | 3.0 | 완료 | 38 / 0 | 0 / 0 | 699 / 18 | 같음 | 잃는 값 0 · 스키마 합격 |
| 110 | `2025_MICUBE_Public/MICUBE/10. 팔레타이징 로봇/PalletizingRobot.aasx` | 3.0 | 완료 | 20 / 0 | 0 / 0 | 683 / 11 | 같음 | 거부 — 한 글자 idShort 등 10건 |
| 111 | `2025_MICUBE_Public/MICUBE/11. 금속 가공부품 로딩언로딩 로봇/LoadingUnloadingRobot.aasx` | 3.0 | 완료 | 20 / 0 | 0 / 0 | 682 / 11 | 같음 | 거부 — 한 글자 idShort 등 10건 |
| 112 | `2025_MICUBE_Public/MICUBE/12. 시험 검사용 로봇/InspectionRobot.aasx` | 3.0 | 완료 | 20 / 0 | 0 / 0 | 687 / 12 | 같음 | 거부 — 한 글자 idShort 등 10건 |
| 113 | `2025_MICUBE_Public/MICUBE/13. RGV/RGV.aasx` | 3.0 | 완료 | 20 / 0 | 0 / 0 | 686 / 12 | 같음 | 거부 — 한 글자 idShort 등 10건 |
| 114 | `2025_MICUBE_Public/MICUBE/14. EPS테스터/EPSTester.aasx` | 3.0 | 완료 | 22 / 0 | 2 / 0 | 670 / 22 | 같음 | 잃는 값 0 · 스키마 합격 |
| 115 | `2025_MICUBE_Public/MICUBE/15. 모터테스터/MotorTester.aasx` | 3.0 | 완료 | 38 / 0 | 0 / 0 | 706 / 18 | 같음 | 잃는 값 0 · 스키마 합격 |
| 116 | `2025_MICUBE_Public/MICUBE/16. 압입용로봇/PressfitRobot.aasx` | 3.0 | 완료 | 38 / 0 | 0 / 0 | 704 / 18 | 같음 | 잃는 값 0 · 스키마 합격 |
| 117 | `2025_MICUBE_Public/MICUBE/17. 자동체결기/AutomaticFasteningMachine.aasx` | 3.0 | 완료 | 38 / 0 | 0 / 0 | 705 / 19 | 같음 | 잃는 값 0 · 스키마 합격 |
| 118 | `2025_MICUBE_Public/MICUBE/18. 정밀프레스/PrecisionPress.aasx` | 3.0 | 완료 | 38 / 0 | 0 / 0 | 700 / 18 | 같음 | 잃는 값 0 · 스키마 합격 |
| 119 | `2025_MICUBE_Public/MICUBE/19. 조향내구시험기/SteeringDurabilityTester.aasx` | 3.0 | 완료 | 22 / 0 | 0 / 0 | 648 / 17 | 같음 | 잃는 값 0 · 스키마 합격 |
| 120 | `2025_MICUBE_Public/MICUBE/20. 캘리브레이터/Calibrator.aasx` | 3.0 | 완료 | 38 / 0 | 0 / 0 | 702 / 18 | 같음 | 잃는 값 0 · 스키마 합격 |
| 121 | `ABH_MICUBE_IMPIX-main/ABH_V2/1. HopperDryer(호퍼기)/HopperDryer.aasx` | 3.0 | 완료 | 160 / 0 | 107 / 0 | 347 / 10 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 122 | `ABH_MICUBE_IMPIX-main/ABH_V2/10. PhysicalVaporDeposition(증발증착기)/PhysicalVaporDeposition.aasx` | 3.0 | 완료 | 158 / 0 | 168 / 0 | 312 / 11 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 123 | `ABH_MICUBE_IMPIX-main/ABH_V2/11. PositiveDisplacementPump(용적형 펌프)/PositiveDisplacementPump.aasx` | 3.0 | 완료 | 156 / 0 | 184 / 0 | 328 / 12 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 124 | `ABH_MICUBE_IMPIX-main/ABH_V2/12. CentrifugalPump(터보형 펌프)/CentrifugalPump.aasx` | 3.0 | 완료 | 156 / 0 | 163 / 0 | 318 / 12 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 125 | `ABH_MICUBE_IMPIX-main/ABH_V2/13. Extruder(압출기)/Extruder.aasx` | 3.0 | 완료 | 156 / 0 | 178 / 0 | 298 / 14 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 126 | `ABH_MICUBE_IMPIX-main/ABH_V2/2. VacuumPump(진공펌프)/VacuumPump.aasx` | 3.0 | 완료 | 160 / 0 | 184 / 0 | 310 / 11 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 127 | `ABH_MICUBE_IMPIX-main/ABH_V2/3. HotForgingPress(열간단조프레스)/HotForgingPress.aasx` | 3.0 | 완료 | 156 / 0 | 140 / 0 | 303 / 12 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 128 | `ABH_MICUBE_IMPIX-main/ABH_V2/4. RollingMill(압연기)/RollingMill.aasx` | 3.0 | 완료 | 165 / 0 | 157 / 0 | 491 / 10 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 129 | `ABH_MICUBE_IMPIX-main/ABH_V2/5. QuenchingFurnace(퀜칭로)/QuenchingFurnace.aasx` | 3.0 | 완료 | 156 / 0 | 275 / 0 | 537 / 10 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 130 | `ABH_MICUBE_IMPIX-main/ABH_V2/6. ShotBlast(쇼트블라스트)/ShotBlast.aasx` | 3.0 | 완료 | 156 / 0 | 253 / 0 | 341 / 11 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 131 | `ABH_MICUBE_IMPIX-main/ABH_V2/7. Crystallizer(결정화기)/Crystallizer.aasx` | 3.0 | 완료 | 156 / 0 | 174 / 0 | 507 / 10 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 132 | `ABH_MICUBE_IMPIX-main/ABH_V2/7. Crystallizer(결정화기)/Crystallizerl.aasx` | 3.0 | 완료 | 155 / 0 | 148 / 0 | 288 / 6 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 133 | `ABH_MICUBE_IMPIX-main/ABH_V2/8. DeepFryer(유탕기)/DeepFryer.aasx` | 3.0 | 완료 | 158 / 0 | 148 / 0 | 506 / 12 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 134 | `ABH_MICUBE_IMPIX-main/ABH_V2/9. ResistanceWeldingController(저항용접기)/ResistanceWelding.aasx` | 3.0 | 완료 | 156 / 0 | 161 / 0 | 324 / 11 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 135 | `ABH_MICUBE_IMPIX-main/IMPIX/1. Distiller(증류기)/Distiller.aasx` | 3.0 | 완료 | 188 / 0 | 123 / 0 | 245 / 2 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 136 | `ABH_MICUBE_IMPIX-main/IMPIX/1. Distiller(증류기)/Distiller_v2.aasx` | 3.0 | 완료 | 189 / 0 | 140 / 0 | 279 / 2 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 137 | `ABH_MICUBE_IMPIX-main/IMPIX/2. Extractor(추출기)/Extractor.aasx` | 3.0 | 완료 | 206 / 0 | 161 / 0 | 250 / 3 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 138 | `ABH_MICUBE_IMPIX-main/IMPIX/2. Extractor(추출기)/Extractor_v2.aasx` | 3.0 | 완료 | 206 / 0 | 173 / 0 | 276 / 3 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 139 | `ABH_MICUBE_IMPIX-main/IMPIX/3. FiltrationSystem(여과기)/FiltrationSystem.aasx` | 3.0 | 완료 | 187 / 0 | 161 / 0 | 238 / 3 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 140 | `ABH_MICUBE_IMPIX-main/IMPIX/3. FiltrationSystem(여과기)/FiltrationSystem_v2.aasx` | 3.0 | 완료 | 187 / 0 | 161 / 0 | 238 / 3 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 141 | `ABH_MICUBE_IMPIX-main/IMPIX/4. Cooler(냉각기)/Cooler.aasx` | 3.0 | 완료 | 189 / 0 | 154 / 0 | 266 / 4 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 142 | `ABH_MICUBE_IMPIX-main/IMPIX/4. Cooler(냉각기)/Cooler_v2.aasx` | 3.0 | 완료 | 190 / 0 | 171 / 0 | 296 / 4 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 143 | `ABH_MICUBE_IMPIX-main/IMPIX/5. Mixer(혼합기)/Mixer.aasx` | 3.0 | 완료 | 187 / 0 | 151 / 0 | 236 / 3 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 144 | `ABH_MICUBE_IMPIX-main/IMPIX/5. Mixer(혼합기)/Mixer_v2.aasx` | 3.0 | 완료 | 187 / 0 | 159 / 0 | 250 / 3 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 145 | `ABH_MICUBE_IMPIX-main/IMPIX/6. PostWeldHeatTreatment(용접후열처리장비)/PostWeldHeatTreatment.aasx` | 3.0 | 완료 | 187 / 0 | 154 / 0 | 242 / 3 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 146 | `ABH_MICUBE_IMPIX-main/IMPIX/6. PostWeldHeatTreatment(용접후열처리장비)/PostWeldHeatTreatment_v2.aasx` | 3.0 | 완료 | 187 / 0 | 154 / 0 | 242 / 3 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 147 | `ABH_MICUBE_IMPIX-main/MICUBE-SOLUTION/1. SPI/SPI_final.aasx` | 3.0 | 완료 | 189 / 0 | 201 / 0 | 291 / 3 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 148 | `ABH_MICUBE_IMPIX-main/MICUBE-SOLUTION/2. ScreenPrinter/ScreenPrinter_final.aasx` | 3.0 | 완료 | 192 / 0 | 258 / 0 | 323 / 4 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 149 | `ABH_MICUBE_IMPIX-main/MICUBE-SOLUTION/3. Reflow/Reflow_final.aasx` | 3.0 | 완료 | 192 / 0 | 176 / 0 | 254 / 4 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 150 | `ABH_MICUBE_IMPIX-main/MICUBE-SOLUTION/4. Mounter/Mounter_final.aasx` | 3.0 | 완료 | 196 / 0 | 313 / 0 | 428 / 31 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 151 | `ABH_MICUBE_IMPIX-main/MICUBE-SOLUTION/5. AOI/AOI_final.aasx` | 3.0 | 완료 | 196 / 0 | 177 / 0 | 257 / 3 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 152 | `ABH_MICUBE_IMPIX-main/MICUBE-SOLUTION/6. ICT/ICT_fin.aasx` | 3.0 | 완료 | 196 / 0 | 200 / 0 | 270 / 3 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 153 | `LSELECTRIC_OCUBY-main/Model/01_PLC_CPU_r7.aasx` | 3.0 | 완료 | 108 / 0 | 122 / 0 | 533 / 25 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 154 | `LSELECTRIC_OCUBY-main/Model/02_PLC_전원_r8.aasx` | 3.0 | 완료 | 95 / 0 | 115 / 0 | 474 / 24 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 155 | `LSELECTRIC_OCUBY-main/Model/03_입출력_디지털_r8.aasx` | 3.0 | 완료 | 91 / 0 | 116 / 0 | 490 / 24 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 156 | `LSELECTRIC_OCUBY-main/Model/03_입출력_아날로그_r9.aasx` | 3.0 | 완료 | 91 / 0 | 116 / 0 | 495 / 25 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 157 | `LSELECTRIC_OCUBY-main/Model/04_PLC_통신_r8.aasx` | 3.0 | 완료 | 93 / 0 | 127 / 0 | 546 / 24 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 158 | `LSELECTRIC_OCUBY-main/Model/05_단독형모션컨트롤러_r7.aasx` | 3.0 | 완료 | 111 / 0 | 130 / 0 | 634 / 24 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 159 | `LSELECTRIC_OCUBY-main/Model/06_서보드라이브_r6.aasx` | 3.0 | 완료 | 97 / 0 | 117 / 0 | 623 / 25 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 160 | `LSELECTRIC_OCUBY-main/Model/06_서보모터_r6.aasx` | 3.0 | 완료 | 101 / 0 | 113 / 0 | 546 / 24 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 161 | `LSELECTRIC_OCUBY-main/Model/07_저압고성능드라이브_r8.aasx` | 3.0 | 완료 | 94 / 0 | 114 / 0 | 596 / 24 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 162 | `LSELECTRIC_OCUBY-main/Model/08_감속기_r6.aasx` | 3.0 | 완료 | 93 / 0 | 120 / 0 | 533 / 24 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 163 | `LSELECTRIC_OCUBY-main/Model/09_델타로봇_r4.aasx` | 3.0 | 완료 | 100 / 0 | 119 / 0 | 647 / 24 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 164 | `LSELECTRIC_OCUBY-main/Model/10_무빙마그넷장치_r5.aasx` | 3.0 | 완료 | 178 / 0 | 129 / 0 | 740 / 41 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 165 | `LSELECTRIC_OCUBY-main/Model/11_그래픽터치패널_r8.aasx` | 3.0 | 완료 | 93 / 0 | 111 / 0 | 612 / 25 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 166 | `LSELECTRIC_OCUBY-main/Model/12_팬펌프제어기_r6.aasx` | 3.0 | 완료 | 94 / 0 | 120 / 0 | 627 / 24 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 167 | `LSELECTRIC_OCUBY-main/Model/13_소프트스타터_r4.aasx` | 3.0 | 완료 | 97 / 0 | 120 / 0 | 621 / 25 | 같음 | 잃는 값 0 · 스키마 불합격 |
| 168 | `LSELECTRIC_OCUBY-main/Model/14_기중차단기_r8.aasx` | 3.0 | 완료 | 263 / 0 | 4908 / 0 | 2042 / 67 | 같음 | 거부 — 한 글자 idShort 등 638건 |
| 169 | `LSELECTRIC_OCUBY-main/Model/15_배선용차단기_r6.aasx` | 3.0 | 완료 | 263 / 0 | 4913 / 0 | 2055 / 70 | 같음 | 거부 — 한 글자 idShort 등 638건 |
| 170 | `LSELECTRIC_OCUBY-main/Model/16_진공차단기_r6.aasx` | 3.0 | 완료 | 287 / 0 | 5299 / 0 | 2228 / 68 | 같음 | 거부 — 한 글자 idShort 등 706건 |
| 171 | `LSELECTRIC_OCUBY-main/Model/17_소형회로차단기_r6.aasx` | 3.0 | 완료 | 217 / 0 | 4092 / 0 | 1745 / 61 | 같음 | 거부 — 한 글자 idShort 등 517건 |
| 172 | `LSELECTRIC_OCUBY-main/Model/18_모터관리장치_r4.aasx` | 3.0 | 완료 | 188 / 0 | 1868 / 0 | 1122 / 37 | 같음 | 거부 — 한 글자 idShort 등 104건 |
| 173 | `LSELECTRIC_OCUBY-main/Model/19_누전차단기_r4.aasx` | 3.0 | 완료 | 215 / 0 | 3676 / 0 | 1650 / 62 | 같음 | 거부 — 한 글자 idShort 등 505건 |
| 174 | `LSELECTRIC_OCUBY-main/Model/20_잔류전류차단기_r6.aasx` | 3.0 | 완료 | 192 / 0 | 3285 / 0 | 1467 / 48 | 같음 | 거부 — 한 글자 idShort 등 452건 |
| 175 | `LSELECTRIC_OCUBY-main/Model/21_소형회로잔류전류차단기_r4.aasx` | 3.0 | 완료 | 191 / 0 | 3512 / 0 | 1492 / 49 | 같음 | 거부 — 한 글자 idShort 등 452건 |
| 176 | `LSELECTRIC_OCUBY-main/Model/22_전자접촉기_r5.aasx` | 3.0 | 완료 | 175 / 0 | 1539 / 0 | 920 / 36 | 같음 | 거부 — 한 글자 idShort 등 90건 |
| 177 | `LSELECTRIC_OCUBY-main/Model/23_열과부하계전기_r3.aasx` | 3.0 | 완료 | 161 / 0 | 1277 / 0 | 790 / 23 | 같음 | 거부 — 한 글자 idShort 등 61건 |
| 178 | `LSELECTRIC_OCUBY-main/Model/24_보조_계전기_r4.aasx` | 3.0 | 완료 | 157 / 0 | 1304 / 0 | 801 / 19 | 같음 | 거부 — 한 글자 idShort 등 59건 |
| 179 | `LSELECTRIC_OCUBY-main/Model/25_시리얼내장_다기능측정기_r5.aasx` | 3.0 | 완료 | 196 / 0 | 3650 / 0 | 1628 / 37 | 같음 | 거부 — 한 글자 idShort 등 508건 |
