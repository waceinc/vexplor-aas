**English** · [한국어](kosmo-호환.md)

# KOSMO reference models — compatibility measurement

Each of the public KOSMO reference models (AAS reference models per equipment type) opened and checked with VEXPLOR AAS
Studio. How to use them is in the [README](../README.md#using-kosmo-reference-models) and [usage §10](usage.md#using-kosmo-reference-models).

## What was measured

| Item | Value |
|---|---|
| Measured on | 2026-10-20 |
| Repository | [kosmo-AAS/kasmo-AAS_Pubilc](https://github.com/kosmo-AAS/kasmo-AAS_Pubilc) (the repository's own spelling) |
| Commit | `6f6ac69aece946b9531c9051d5970a72bcbf81c6` (2026-06-23) |
| AAS Studio | 2.12.0 (`main` `b179f22`) |
| Files | **179** AASX — `2025_KPC_Public` 60 · `2025_MICUBE_Public` 60 · `ABH_MICUBE_IMPIX-main` 32 · `LSELECTRIC_OCUBY-main` 27 |

Every file went through these steps, calling this repository's libraries (`@aas/aasx` · `@aas/linter` · `@aas/core`) as they are.

1. **Open** — `readAasx(file)`. The judged metamodel version and where it came from (`metamodel.version` · `source`) are kept.
2. **Check** — `lint(environment, ALL_RULES, { package: opc, metamodel })`. All 52 rules, judged by **the file's own version** (as since 2.9.0).
3. **Round trip** — written back as read with `writeAasx`, read again with `readAasx`, and the bodies (key-sorted JSON) compared.
4. **Export as 3.1** — `writeAasxWithReport(pkg, { version: '3.1', encodePaths: true })`. Dropped values counted, the body read back
   compared with the original, and checked against the official 3.1 JSON schema (`tests/fixtures/idta-metamodel/3.1`, ajv draft 2019-09).

## Summary

| Item | Result |
|---|---|
| Opened | **179 / 179** — every body is XML and is converted to JSON on import |
| Metamodel version | **3.0 — all 179** (declared by the XML namespace `https://admin-shell.io/aas/3/0`). No file declares 3.1 or 3.2 |
| Check ran to the end | **134 / 179** — the other 45 stop, see "Known problem (A)" below |
| Files with 0 errors | 0 / 134 |
| Findings (sum of 134 files) | L1 errors 2,493 · info 34 / L2 errors 3,045 · warnings 77 / L3 errors 123,881 · warnings 4,931 · info 2,415 |
| What the 129,419 errors are | Empty Property values (`KOSMO-SME-4`) 45,829 — the reference model leaves values for you to fill, so these go down as you enter the machine's values · **82,000 auto-fixable** · the remaining 1,590 need a person |
| Round trip | same **152** · not re-readable 27 (A) |
| Export as 3.1 | written with 0 dropped values **141** (the body read back equals the original) · refused 23 (values 3.1 does not accept, such as one-letter idShorts `Q` · `T` · `X` — rename them first) · failed 15 (A) |
| Official 3.1 schema | **33** of the 141 written pass. The others fail on empty strings in the source (empty LangString text — 73 of the 118 files without (A), text over the length limit 29, empty unit 14, empty idShort 9 …) and on (A) |

### Rules with the most findings (sum of the 134 checked files)

| Rule | Layer · severity | Findings | Files | Auto-fix | What |
|---|---|---|---|---|---|
| `KOSMO-SME-4` | L3 error | 45,829 | 134 | no | Property has no value — a place for the machine's value |
| `KOSMO-CD-2` | L3 error | 32,845 | 134 | yes | ConceptDescription id is neither IRDI nor an allow-listed own IRI |
| `KOSMO-CD-4` | L3 error | 25,511 | 134 | yes | dataType missing or outside the KOSMO allow list |
| `KOSMO-SME-5` | L3 error | 11,274 | 119 | yes | Property valueType and CD dataType differ |
| `KOSMO-CD-5` | L3 warning · error · info | 4,907 · 2,665 · 2,415 | 133 | partly | CDs with the same id · idShort |
| `PKG-LANG-DUP` | L1 error | 2,473 | 129 | yes | The same language tag (usually `en`) twice in one LangString |
| `KOSMO-SME-3` | L3 error | 2,438 | 110 | yes | semanticId missing, or no CD with that id |
| `AASc-3a-002` | L2 error | 2,280 | 64 | yes | CD preferredName has no English |
| `KOSMO-CD-3` | L3 error | 1,263 | 83 | no | No English definition |
| `KOSMO-SM-3` | L3 error | 739 | 134 | yes | Submodel semanticId missing or outside the allow list |

The grounds and policies of the rules are in the [rule list](rules.md) and [usage §10](usage.md). **The submission's validator makes the final acceptance decision.**

## Known problem (A) — empty list elements

The XML of some files has list elements closed with no children (`<qualifiers />` · `<description />` · `<keys />` ·
`<embeddedDataSpecifications />` · a collection's `<value />`). 2.12.0 reads them as an **empty string** instead of an empty
list. 61 files have such elements (`ABH_MICUBE_IMPIX-main` 32 · `LSELECTRIC_OCUBY-main` 27 · `2025_KPC_Public` 2); in 45 of
them the check stops part way (rules `AASd-119/129` · `AASd-116/133` · `KOSMO-CD-3`), and for 27 a saved copy cannot be
opened again by this tool. "stopped (A)" and "not re-readable" in the table below are this problem. The table is measured
again once it is fixed.

## License

At the measured commit the repository carries no license (no LICENSE file, GitHub shows no license). This repository
therefore does not include those AASX files — not even as test files — and only links to them. Download them from the
source repository, and check the provider's terms before redistributing them.

## Per file

- **Check**: done = all 52 rules ran · stopped (A) = stopped by the known problem above (no findings counted)
- **L1 · L2 · L3**: errors / warnings (info not counted)
- **Round trip**: is the body the same after writing it as read and reading it again
- **Export as 3.1**: dropped values and the official 3.1 schema result. refused = values 3.1 does not accept, so nothing is written (the "values that cannot be written" of the download window)

| # | File (path in the repository) | Metamodel | Check | L1 errors / warnings | L2 errors / warnings | L3 errors / warnings | Round trip | Export as 3.1 |
|---|---|---|---|---|---|---|---|---|
| 1 | `2025_KPC_Public/INTERX/01. 수치제어 방전가공기/[공.9]NumericalControlElectricalDischargeMachine.aasx` | 3.0 | done | 8 / 0 | 31 / 0 | 1143 / 53 | same | dropped 0 · schema fail |
| 2 | `2025_KPC_Public/INTERX/02. 스피닝기/[공.11]SpinningMachine.aasx` | 3.0 | done | 8 / 0 | 37 / 0 | 1574 / 41 | same | dropped 0 · schema fail |
| 3 | `2025_KPC_Public/INTERX/03. 전해가공기/[공.13]ElectrochemicalMachine.aasx` | 3.0 | done | 8 / 0 | 28 / 0 | 1309 / 40 | same | dropped 0 · schema fail |
| 4 | `2025_KPC_Public/INTERX/04. 플레이너/[공.14]Planner.aasx` | 3.0 | done | 8 / 0 | 32 / 0 | 1403 / 42 | same | dropped 0 · schema fail |
| 5 | `2025_KPC_Public/INTERX/05. 세이핑기/[공.15]ShapingMachine.aasx` | 3.0 | done | 8 / 0 | 13 / 0 | 1428 / 42 | same | dropped 0 · schema fail |
| 6 | `2025_KPC_Public/INTERX/06. 브로칭기/[공.17]BroachingMachine.aasx` | 3.0 | done | 8 / 0 | 33 / 0 | 1473 / 43 | same | dropped 0 · schema fail |
| 7 | `2025_KPC_Public/INTERX/07. 유압식 프레스/[공.26]HydraulicPress.aasx` | 3.0 | done | 9 / 0 | 70 / 0 | 1671 / 64 | same | dropped 0 · schema fail |
| 8 | `2025_KPC_Public/INTERX/08. 복사파식(복사식) 건조기/[범.23]RadiantHeatDryer.aasx` | 3.0 | done | 8 / 0 | 37 / 0 | 1439 / 40 | same | dropped 0 · schema fail |
| 9 | `2025_KPC_Public/INTERX/09. 플라즈마식 절단기/[범.40]PlasmaCuttingMachine.aasx` | 3.0 | done | 8 / 0 | 44 / 0 | 1554 / 46 | same | dropped 0 · schema fail |
| 10 | `2025_KPC_Public/INTERX/10. 레이저식 절단기/[범.41]LaserCuttingMachine.aasx` | 3.0 | done | 8 / 0 | 17 / 0 | 1466 / 41 | same | dropped 0 · schema fail |
| 11 | `2025_KPC_Public/INTERX/11. 수치제어 절단기/[범.43]NumericalControlCuttingMachine.aasx` | 3.0 | done | 8 / 0 | 36 / 0 | 1479 / 40 | same | dropped 0 · schema fail |
| 12 | `2025_KPC_Public/INTERX/12. 기계식 절단기/[범.44]MechanicalCuttingMachine.aasx` | 3.0 | done | 8 / 0 | 32 / 0 | 1439 / 40 | same | dropped 0 · schema fail |
| 13 | `2025_KPC_Public/INTERX/13. 교류직류전원 공급장치/[범.70]Rectifier.aasx` | 3.0 | done | 8 / 0 | 23 / 0 | 1263 / 40 | same | dropped 0 · schema fail |
| 14 | `2025_KPC_Public/INTERX/14. 자동전압조정장치/[범.72]AutomaticVoltageRegulator.aasx` | 3.0 | done | 8 / 0 | 33 / 0 | 1269 / 43 | same | dropped 0 · schema fail |
| 15 | `2025_KPC_Public/INTERX/15. 아크 용접용 로봇/[로.7]ArcWeldingRobot.aasx` | 3.0 | done | 8 / 0 | 36 / 0 | 1373 / 40 | same | dropped 0 · schema fail |
| 16 | `2025_KPC_Public/INTERX/16. 스폿 용접용 로봇/[로.8]SpotWeldingRobot.aasx` | 3.0 | done | 8 / 0 | 36 / 0 | 1358 / 40 | same | dropped 0 · schema fail |
| 17 | `2025_KPC_Public/INTERX/17. 부품 조립 및 분해 로봇/[로.10]PartAssemblyDisassemblyRobot.aasx` | 3.0 | done | 8 / 0 | 39 / 0 | 1424 / 39 | same | dropped 0 · schema fail |
| 18 | `2025_KPC_Public/INTERX/18. 마킹 및 라벨링용 로봇/[로.12]MarkingLabelingRobot.aasx` | 3.0 | done | 8 / 0 | 52 / 0 | 1554 / 41 | same | dropped 0 · schema fail |
| 19 | `2025_KPC_Public/INTERX/19. 절단용 로봇/[로.15]CuttingRobot.aasx` | 3.0 | done | 8 / 0 | 44 / 0 | 1564 / 42 | same | dropped 0 · schema fail |
| 20 | `2025_KPC_Public/INTERX/20. 벨트식 컨베이어/[기.1]BeltConveyor.aasx` | 3.0 | done | 8 / 0 | 9 / 0 | 1042 / 39 | same | dropped 0 · schema pass |
| 21 | `2025_KPC_Public/INTERX/21. 로울러식 컨베이어/[기.2]RollerTypeConveyor.aasx` | 3.0 | done | 8 / 0 | 31 / 0 | 1024 / 40 | same | dropped 0 · schema fail |
| 22 | `2025_KPC_Public/INTERX/22. 체인식 컨베이어/[기.3]ChainTypeConveyor.aasx` | 3.0 | done | 11 / 0 | 10 / 0 | 1031 / 41 | same | dropped 0 · schema pass |
| 23 | `2025_KPC_Public/INTERX/23. 무전해 도금조/[뿌.10]ElectrolessPlatingBath.aasx` | 3.0 | done | 8 / 0 | 30 / 0 | 1364 / 43 | same | dropped 0 · schema fail |
| 24 | `2025_KPC_Public/INTERX/24. 질화로/[뿌.37]NitridingFurnace.aasx` | 3.0 | done | 8 / 0 | 38 / 0 | 1500 / 41 | same | dropped 0 · schema fail |
| 25 | `2025_KPC_Public/INTERX/25. 침탄로/[뿌.40]CarburizingFurnace.aasx` | 3.0 | done | 8 / 0 | 33 / 0 | 1581 / 39 | same | dropped 0 · schema fail |
| 26 | `2025_KPC_Public/INTERX/26. 탈지조/[뿌.46]DegreasingTank.aasx` | 3.0 | done | 8 / 0 | 37 / 0 | 1443 / 41 | same | dropped 0 · schema fail |
| 27 | `2025_KPC_Public/INTERX/27. 템퍼링로/[뿌.60]TemperingFurnance.aasx` | 3.0 | done | 8 / 0 | 37 / 0 | 1461 / 41 | same | dropped 0 · schema fail |
| 28 | `2025_KPC_Public/INTERX/28. 용체화로/[뿌.61]SolutionHeatTreatmentFurnace.aasx` | 3.0 | done | 8 / 0 | 11 / 0 | 1527 / 40 | same | dropped 0 · schema fail |
| 29 | `2025_KPC_Public/INTERX/29. 균질화로/[뿌.62]HomogenizingFurnace.aasx` | 3.0 | done | 8 / 0 | 46 / 0 | 1483 / 39 | same | dropped 0 · schema pass |
| 30 | `2025_KPC_Public/INTERX/30. 이산화탄소 용접기/[뿌.76]Co2WeldingMachine.aasx` | 3.0 | done | 8 / 0 | 38 / 0 | 1302 / 41 | same | dropped 0 · schema fail |
| 31 | `2025_KPC_Public/INTERX/31. 마찰교반 용접기/[뿌.78]FrictionStirWeldingMachine.aasx` | 3.0 | done | 8 / 0 | 42 / 0 | 1338 / 40 | same | dropped 0 · schema fail |
| 32 | `2025_KPC_Public/INTERX/32. 반도체회로 에칭장비/[일.6]SemiconductorCircuitEtchingEquipment.aasx` | 3.0 | done | 8 / 0 | 36 / 0 | 1458 / 43 | same | dropped 0 · schema fail |
| 33 | `2025_KPC_Public/INTERX/33. 도금두께 측정기/[신규.1]PlatingThicknessGauge.aasx` | 3.0 | done | 8 / 0 | 43 / 0 | 1779 / 45 | same | dropped 0 · schema fail |
| 34 | `2025_KPC_Public/INTERX/34. 산수세기/[신규.3]AcidRinsingMachine.aasx` | 3.0 | done | 8 / 0 | 31 / 0 | 1386 / 43 | same | dropped 0 · schema fail |
| 35 | `2025_KPC_Public/INTERX/35. 전해 도금조/[신규.2]ElectroplatingBath.aasx` | 3.0 | done | 8 / 0 | 13 / 0 | 1361 / 43 | same | dropped 0 · schema fail |
| 36 | `2025_KPC_Public/KPC/01. 코팅기/코팅기.aasx` | 3.0 | done | 13 / 0 | 0 / 0 | 1140 / 19 | same | dropped 0 · schema fail |
| 37 | `2025_KPC_Public/KPC/02. 래핑기/래핑기.aasx` | 3.0 | done | 12 / 0 | 0 / 0 | 1127 / 18 | same | dropped 0 · schema fail |
| 38 | `2025_KPC_Public/KPC/03. AMR/AMR.aasx` | 3.0 | done | 16 / 0 | 0 / 0 | 1144 / 16 | same | dropped 0 · schema fail |
| 39 | `2025_KPC_Public/KPC/04. 크레인/crane.aasx` | 3.0 | done | 12 / 0 | 0 / 0 | 1130 / 18 | same | dropped 0 · schema fail |
| 40 | `2025_KPC_Public/KPC/05. 레이저스캐너/레이저스캐너.aasx` | 3.0 | done | 12 / 0 | 0 / 0 | 1125 / 18 | same | dropped 0 · schema fail |
| 41 | `2025_KPC_Public/KPC/06. 산세처리기/산세처리기.aasx` | 3.0 | done | 12 / 0 | 0 / 0 | 1293 / 59 | same | refused — 15 values (one-letter idShort …) |
| 42 | `2025_KPC_Public/KPC/07. 핫러너장치/핫러너장치.aasx` | 3.0 | done | 12 / 0 | 0 / 0 | 1152 / 18 | same | dropped 0 · schema fail |
| 43 | `2025_KPC_Public/KPC/08. 전조기/전조기.aasx` | 3.0 | done | 13 / 0 | 0 / 0 | 1107 / 16 | same | dropped 0 · schema fail |
| 44 | `2025_KPC_Public/KPC/09. 정련기/정련기.aasx` | 3.0 | done | 12 / 0 | 0 / 0 | 1140 / 18 | same | dropped 0 · schema fail |
| 45 | `2025_KPC_Public/KPC/10. 표면처리기/표면처리기.aasx` | 3.0 | done | 13 / 0 | 0 / 0 | 1281 / 59 | same | refused — 15 values (one-letter idShort …) |
| 46 | `2025_KPC_Public/한국생산기술연구원/01. 기계식 프레스/01_MachinePress_V0.9.9.aasx` | 3.0 | done | 13 / 0 | 14 / 0 | 252 / 9 | same | dropped 0 · schema fail |
| 47 | `2025_KPC_Public/한국생산기술연구원/02. 열전도식(전도식) 건조기/04_HeatConductionDryer_V0.9.8.aasx` | 3.0 | done | 13 / 0 | 8 / 0 | 650 / 60 | same | dropped 0 · schema fail |
| 48 | `2025_KPC_Public/한국생산기술연구원/03. 플라스틱사출품 취출로봇/02_PartRemovalRobot_V0.9.8.aasx` | 3.0 | done | 14 / 0 | 19 / 0 | 1118 / 278 | same | dropped 0 · schema fail |
| 49 | `2025_KPC_Public/한국생산기술연구원/04. 보온로/03_HoldingFurnace_V0.9.8.aasx` | 3.0 | done | 13 / 0 | 18 / 0 | 1139 / 260 | same | dropped 0 · schema fail |
| 50 | `2025_KPC_Public/한국생산기술연구원/05. 분말성형장치/02_PowderCompactingPress_V0.9.8.aasx` | 3.0 | done | 14 / 0 | 14 / 0 | 236 / 21 | same | dropped 0 · schema fail |
| 51 | `2025_KPC_Public/한국생산기술연구원/06. 소결로/02_VaccumSinteringFurnace_V0.9.8.aasx` | 3.0 | done | 13 / 0 | 5 / 0 | 536 / 21 | same | dropped 0 · schema fail |
| 52 | `2025_KPC_Public/한국생산기술연구원/07. 언코일러/01_Uncoiler_V0.9.8.aasx` | 3.0 | done | 13 / 0 | 14 / 0 | 143 / 5 | same | dropped 0 · schema fail |
| 53 | `2025_KPC_Public/한국생산기술연구원/08. 취출기/03_Ejector_V0.9.8.aasx` | 3.0 | done | 13 / 0 | 19 / 0 | 1121 / 269 | same | dropped 0 · schema fail |
| 54 | `2025_KPC_Public/한국생산기술연구원/09. 탈지수세전처리기/04_DegreasingPreWashMachine_V0.9.8.aasx` | 3.0 | done | 13 / 0 | 19 / 0 | 1109 / 252 | same | dropped 0 · schema fail |
| 55 | `2025_KPC_Public/한국생산기술연구원/10. 플라즈마전처리기/04_PlasmaPretreatementEquipment_V0.9.8.aasx` | 3.0 | done | 14 / 0 | 28 / 0 | 1182 / 281 | same | dropped 0 · schema fail |
| 56 | `2025_KPC_Public/한국생산기술연구원/11. 혼련기/02_PowderMixer_V0.9.8.aasx` | 3.0 | done | 15 / 0 | 9 / 0 | 539 / 31 | same | dropped 0 · schema fail |
| 57 | `2025_KPC_Public/한국생산기술연구원/12. 냉가압식 다이캐스팅/03_ColdChamberDiecastingMachine_V0.9.8.aasx` | 3.0 | done | 14 / 0 | 14 / 0 | 236 / 11 | same | dropped 0 · schema fail |
| 58 | `2025_KPC_Public/한국생산기술연구원/13. 사상기/03_DeburringMachine_V0.9.8.aasx` | 3.0 | done | 7 / 0 | 9 / 0 | 540 / 13 | same | dropped 0 · schema fail |
| 59 | `2025_KPC_Public/한국생산기술연구원/14. 레벨러/01_Leveller_V0.9.8.aasx` | 3.0 | done | 14 / 0 | 14 / 0 | 155 / 7 | same | dropped 0 · schema fail |
| 60 | `2025_KPC_Public/한국생산기술연구원/15. 피더/01_NC_Roll_Feeder_V0.9.8.aasx` | 3.0 | done | 14 / 0 | 14 / 0 | 143 / 5 | same | dropped 0 · schema fail |
| 61 | `2025_MICUBE_Public/ABH/01. 선반(터닝센터)/1. TurningCenter.aasx` | 3.0 | done | 23 / 0 | 0 / 0 | 668 / 24 | same | dropped 0 · schema pass |
| 62 | `2025_MICUBE_Public/ABH/02. 밀링기/2. MillingMachine.aasx` | 3.0 | done | 23 / 0 | 0 / 0 | 670 / 22 | same | dropped 0 · schema pass |
| 63 | `2025_MICUBE_Public/ABH/03. 드릴링기/16. DrillingMachine.aasx` | 3.0 | done | 23 / 0 | 0 / 0 | 910 / 20 | same | dropped 0 · schema pass |
| 64 | `2025_MICUBE_Public/ABH/04. 보링기/10. BoringMachine.aasx` | 3.0 | done | 23 / 0 | 0 / 0 | 831 / 28 | same | dropped 0 · schema pass |
| 65 | `2025_MICUBE_Public/ABH/05. 기어가공기/6. GearMachiningMachine.aasx` | 3.0 | done | 23 / 0 | 0 / 0 | 1057 / 29 | same | dropped 0 · schema pass |
| 66 | `2025_MICUBE_Public/ABH/06. 와이어 컷 방전 가공기/19. WirecutElectricalDischargeMachining.aasx` | 3.0 | done | 9 / 0 | 0 / 0 | 679 / 17 | same | dropped 0 · schema pass |
| 67 | `2025_MICUBE_Public/ABH/07. 초음파 가공기/15. UltrasonicDrillingMachine.aasx` | 3.0 | done | 6 / 0 | 0 / 0 | 630 / 0 | same | dropped 0 · schema pass |
| 68 | `2025_MICUBE_Public/ABH/08. 슬로팅기/7. SlottingMachine.aasx` | 3.0 | done | 23 / 0 | 0 / 0 | 1008 / 38 | same | dropped 0 · schema pass |
| 69 | `2025_MICUBE_Public/ABH/09. 호닝기/11. HoningMachine.aasx` | 3.0 | done | 23 / 0 | 0 / 0 | 1010 / 81 | same | dropped 0 · schema pass |
| 70 | `2025_MICUBE_Public/ABH/10. 키홈가공기/3. KeywayMachine.aasx` | 3.0 | done | 23 / 0 | 0 / 0 | 673 / 25 | same | dropped 0 · schema pass |
| 71 | `2025_MICUBE_Public/ABH/11. 버핑기/9. BuffingMachine.aasx` | 3.0 | done | 23 / 0 | 0 / 0 | 1164 / 81 | same | dropped 0 · schema pass |
| 72 | `2025_MICUBE_Public/ABH/12. 슈퍼피니싱기/12. SuperFinishing.aasx` | 3.0 | done | 23 / 0 | 0 / 0 | 827 / 28 | same | dropped 0 · schema pass |
| 73 | `2025_MICUBE_Public/ABH/13. 금속 3D프린터(소형)/20. Metal3DPrinter.aasx` | 3.0 | done | 9 / 0 | 0 / 0 | 672 / 17 | same | dropped 0 · schema pass |
| 74 | `2025_MICUBE_Public/ABH/14. 세척기/5. PartsWasher.aasx` | 3.0 | done | 23 / 0 | 0 / 0 | 670 / 24 | same | dropped 0 · schema pass |
| 75 | `2025_MICUBE_Public/ABH/15. 절곡기/14. BendingMachine.aasx` | 3.0 | done | 23 / 0 | 0 / 0 | 994 / 24 | same | dropped 0 · schema fail |
| 76 | `2025_MICUBE_Public/ABH/16. 리파이너/18. Refiner.aasx` | 3.0 | done | 23 / 0 | 0 / 0 | 1010 / 24 | same | dropped 0 · schema pass |
| 77 | `2025_MICUBE_Public/ABH/17. 유체정화기/13. FluidPurifier.aasx` | 3.0 | done | 23 / 0 | 0 / 0 | 1066 / 85 | same | dropped 0 · schema pass |
| 78 | `2025_MICUBE_Public/ABH/18. 연마용 및 디버링 로봇/4. PolishingAndDeburringRobot.aasx` | 3.0 | done | 23 / 0 | 0 / 0 | 668 / 26 | same | dropped 0 · schema pass |
| 79 | `2025_MICUBE_Public/ABH/19. 초음파 용접기/17. UltrasonicWeldingMachine.aasx` | 3.0 | done | 23 / 0 | 0 / 0 | 999 / 24 | same | dropped 0 · schema pass |
| 80 | `2025_MICUBE_Public/ABH/20. 샷피닝기/8. ShotPeeningMachine.aasx` | 3.0 | done | 23 / 0 | 0 / 0 | 897 / 26 | same | dropped 0 · schema pass |
| 81 | `2025_MICUBE_Public/IMPIX/01.  라벨기/라벨기.aasx` | 3.0 | done | 47 / 0 | 0 / 4 | 766 / 21 | same | dropped 0 · schema fail |
| 82 | `2025_MICUBE_Public/IMPIX/02. 멸균기/멸균기.aasx` | 3.0 | done | 47 / 0 | 0 / 4 | 866 / 37 | same | dropped 0 · schema fail |
| 83 | `2025_MICUBE_Public/IMPIX/03. 염색가공기/염색가공기.aasx` | 3.0 | done | 50 / 0 | 0 / 4 | 762 / 20 | same | dropped 0 · schema fail |
| 84 | `2025_MICUBE_Public/IMPIX/04. 염지기/염지기.aasx` | 3.0 | done | 50 / 0 | 0 / 3 | 735 / 19 | same | dropped 0 · schema fail |
| 85 | `2025_MICUBE_Public/IMPIX/05. 원단적재기/원단적재기.aasx` | 3.0 | done | 47 / 0 | 0 / 3 | 769 / 21 | same | dropped 0 · schema fail |
| 86 | `2025_MICUBE_Public/IMPIX/06. 텐터기/텐터기.aasx` | 3.0 | done | 47 / 0 | 0 / 3 | 769 / 21 | same | dropped 0 · schema fail |
| 87 | `2025_MICUBE_Public/IMPIX/07. 과립기/과립기.aasx` | 3.0 | done | 47 / 0 | 0 / 4 | 734 / 18 | same | dropped 0 · schema fail |
| 88 | `2025_MICUBE_Public/IMPIX/08. 러버코팅기/러버코팅기.aasx` | 3.0 | done | 47 / 0 | 0 / 4 | 802 / 18 | same | dropped 0 · schema fail |
| 89 | `2025_MICUBE_Public/IMPIX/09. 숙성기/숙성기.aasx` | 3.0 | done | 47 / 0 | 0 / 4 | 736 / 18 | same | dropped 0 · schema fail |
| 90 | `2025_MICUBE_Public/IMPIX/10. 정제코팅기/정제코팅기.aasx` | 3.0 | done | 47 / 0 | 0 / 4 | 734 / 18 | same | dropped 0 · schema fail |
| 91 | `2025_MICUBE_Public/IMPIX/11. 칭량기/칭량기.aasx` | 3.0 | done | 47 / 0 | 0 / 4 | 800 / 18 | same | dropped 0 · schema fail |
| 92 | `2025_MICUBE_Public/IMPIX/12. 커팅기/커팅기.aasx` | 3.0 | done | 47 / 0 | 0 / 4 | 802 / 18 | same | dropped 0 · schema fail |
| 93 | `2025_MICUBE_Public/IMPIX/13. 타정기/타정기.aasx` | 3.0 | done | 47 / 0 | 0 / 4 | 736 / 18 | same | dropped 0 · schema fail |
| 94 | `2025_MICUBE_Public/IMPIX/14. 파우칭기/파우칭기.aasx` | 3.0 | done | 47 / 0 | 0 / 4 | 711 / 18 | same | dropped 0 · schema fail |
| 95 | `2025_MICUBE_Public/IMPIX/15. 혼합기/혼합기.aasx` | 3.0 | done | 47 / 0 | 0 / 4 | 736 / 18 | same | dropped 0 · schema fail |
| 96 | `2025_MICUBE_Public/IMPIX/16. IV테스트기/iv테스트기.aasx` | 3.0 | done | 47 / 0 | 0 / 4 | 782 / 18 | same | dropped 0 · schema fail |
| 97 | `2025_MICUBE_Public/IMPIX/17. 라미네이션/라미네이션.aasx` | 3.0 | done | 47 / 0 | 0 / 4 | 712 / 18 | same | dropped 0 · schema fail |
| 98 | `2025_MICUBE_Public/IMPIX/18. 태빙기/태빙기.aasx` | 3.0 | done | 47 / 0 | 0 / 4 | 763 / 18 | same | dropped 0 · schema fail |
| 99 | `2025_MICUBE_Public/IMPIX/19. 트리밍기/트리밍기.aasx` | 3.0 | done | 47 / 0 | 0 / 4 | 788 / 18 | same | dropped 0 · schema fail |
| 100 | `2025_MICUBE_Public/IMPIX/20. 프레임조립기/프레임조립기.aasx` | 3.0 | done | 47 / 0 | 0 / 4 | 741 / 18 | same | dropped 0 · schema fail |
| 101 | `2025_MICUBE_Public/MICUBE/01. 연삭기/GrindingMachine.aasx` | 3.0 | done | 20 / 0 | 0 / 0 | 688 / 14 | same | refused — 10 values (one-letter idShort …) |
| 102 | `2025_MICUBE_Public/MICUBE/02. 연마기/PolishingMachine.aasx` | 3.0 | done | 20 / 0 | 0 / 0 | 683 / 11 | same | refused — 10 values (one-letter idShort …) |
| 103 | `2025_MICUBE_Public/MICUBE/03. 통기식(대류식) 건조기/ConvectionDryer.aasx` | 3.0 | done | 20 / 0 | 0 / 0 | 684 / 12 | same | refused — 10 values (one-letter idShort …) |
| 104 | `2025_MICUBE_Public/MICUBE/04. 입자유동식(대류식) 건조기/FluidizedBedDryer.aasx` | 3.0 | done | 20 / 0 | 0 / 0 | 686 / 12 | same | refused — 10 values (one-letter idShort …) |
| 105 | `2025_MICUBE_Public/MICUBE/05. 분진용 집진장치/DustCollector.aasx` | 3.0 | done | 22 / 0 | 0 / 0 | 549 / 10 | same | dropped 0 · schema pass |
| 106 | `2025_MICUBE_Public/MICUBE/06. 흄 집진장치/FumeExtractor.aasx` | 3.0 | done | 22 / 0 | 0 / 0 | 545 / 10 | same | dropped 0 · schema pass |
| 107 | `2025_MICUBE_Public/MICUBE/07. 오일미스트식 집진장치/OilMistCollector.aasx` | 3.0 | done | 19 / 0 | 0 / 0 | 552 / 8 | same | dropped 0 · schema pass |
| 108 | `2025_MICUBE_Public/MICUBE/08. 히터/Heater.aasx` | 3.0 | done | 20 / 0 | 0 / 0 | 690 / 11 | same | refused — 10 values (one-letter idShort …) |
| 109 | `2025_MICUBE_Public/MICUBE/09. 자동권선기/AutomaticWindingMachine.aasx` | 3.0 | done | 38 / 0 | 0 / 0 | 699 / 18 | same | dropped 0 · schema pass |
| 110 | `2025_MICUBE_Public/MICUBE/10. 팔레타이징 로봇/PalletizingRobot.aasx` | 3.0 | done | 20 / 0 | 0 / 0 | 683 / 11 | same | refused — 10 values (one-letter idShort …) |
| 111 | `2025_MICUBE_Public/MICUBE/11. 금속 가공부품 로딩언로딩 로봇/LoadingUnloadingRobot.aasx` | 3.0 | done | 20 / 0 | 0 / 0 | 682 / 11 | same | refused — 10 values (one-letter idShort …) |
| 112 | `2025_MICUBE_Public/MICUBE/12. 시험 검사용 로봇/InspectionRobot.aasx` | 3.0 | done | 20 / 0 | 0 / 0 | 687 / 12 | same | refused — 10 values (one-letter idShort …) |
| 113 | `2025_MICUBE_Public/MICUBE/13. RGV/RGV.aasx` | 3.0 | done | 20 / 0 | 0 / 0 | 686 / 12 | same | refused — 10 values (one-letter idShort …) |
| 114 | `2025_MICUBE_Public/MICUBE/14. EPS테스터/EPSTester.aasx` | 3.0 | done | 22 / 0 | 2 / 0 | 670 / 22 | same | dropped 0 · schema pass |
| 115 | `2025_MICUBE_Public/MICUBE/15. 모터테스터/MotorTester.aasx` | 3.0 | done | 38 / 0 | 0 / 0 | 706 / 18 | same | dropped 0 · schema pass |
| 116 | `2025_MICUBE_Public/MICUBE/16. 압입용로봇/PressfitRobot.aasx` | 3.0 | done | 38 / 0 | 0 / 0 | 704 / 18 | same | dropped 0 · schema pass |
| 117 | `2025_MICUBE_Public/MICUBE/17. 자동체결기/AutomaticFasteningMachine.aasx` | 3.0 | done | 38 / 0 | 0 / 0 | 705 / 19 | same | dropped 0 · schema pass |
| 118 | `2025_MICUBE_Public/MICUBE/18. 정밀프레스/PrecisionPress.aasx` | 3.0 | done | 38 / 0 | 0 / 0 | 700 / 18 | same | dropped 0 · schema pass |
| 119 | `2025_MICUBE_Public/MICUBE/19. 조향내구시험기/SteeringDurabilityTester.aasx` | 3.0 | done | 22 / 0 | 0 / 0 | 648 / 17 | same | dropped 0 · schema pass |
| 120 | `2025_MICUBE_Public/MICUBE/20. 캘리브레이터/Calibrator.aasx` | 3.0 | done | 38 / 0 | 0 / 0 | 702 / 18 | same | dropped 0 · schema pass |
| 121 | `ABH_MICUBE_IMPIX-main/ABH_V2/1. HopperDryer(호퍼기)/HopperDryer.aasx` | 3.0 | stopped (A) | — | — | — | same | dropped 0 · schema fail |
| 122 | `ABH_MICUBE_IMPIX-main/ABH_V2/10. PhysicalVaporDeposition(증발증착기)/PhysicalVaporDeposition.aasx` | 3.0 | stopped (A) | — | — | — | same | dropped 0 · schema fail |
| 123 | `ABH_MICUBE_IMPIX-main/ABH_V2/11. PositiveDisplacementPump(용적형 펌프)/PositiveDisplacementPump.aasx` | 3.0 | stopped (A) | — | — | — | same | dropped 0 · schema fail |
| 124 | `ABH_MICUBE_IMPIX-main/ABH_V2/12. CentrifugalPump(터보형 펌프)/CentrifugalPump.aasx` | 3.0 | stopped (A) | — | — | — | same | dropped 0 · schema fail |
| 125 | `ABH_MICUBE_IMPIX-main/ABH_V2/13. Extruder(압출기)/Extruder.aasx` | 3.0 | stopped (A) | — | — | — | same | dropped 0 · schema fail |
| 126 | `ABH_MICUBE_IMPIX-main/ABH_V2/2. VacuumPump(진공펌프)/VacuumPump.aasx` | 3.0 | stopped (A) | — | — | — | same | dropped 0 · schema fail |
| 127 | `ABH_MICUBE_IMPIX-main/ABH_V2/3. HotForgingPress(열간단조프레스)/HotForgingPress.aasx` | 3.0 | stopped (A) | — | — | — | same | dropped 0 · schema fail |
| 128 | `ABH_MICUBE_IMPIX-main/ABH_V2/4. RollingMill(압연기)/RollingMill.aasx` | 3.0 | stopped (A) | — | — | — | same | dropped 0 · schema fail |
| 129 | `ABH_MICUBE_IMPIX-main/ABH_V2/5. QuenchingFurnace(퀜칭로)/QuenchingFurnace.aasx` | 3.0 | stopped (A) | — | — | — | same | dropped 0 · schema fail |
| 130 | `ABH_MICUBE_IMPIX-main/ABH_V2/6. ShotBlast(쇼트블라스트)/ShotBlast.aasx` | 3.0 | stopped (A) | — | — | — | same | dropped 0 · schema fail |
| 131 | `ABH_MICUBE_IMPIX-main/ABH_V2/7. Crystallizer(결정화기)/Crystallizer.aasx` | 3.0 | stopped (A) | — | — | — | same | dropped 0 · schema fail |
| 132 | `ABH_MICUBE_IMPIX-main/ABH_V2/7. Crystallizer(결정화기)/Crystallizerl.aasx` | 3.0 | stopped (A) | — | — | — | same | dropped 0 · schema fail |
| 133 | `ABH_MICUBE_IMPIX-main/ABH_V2/8. DeepFryer(유탕기)/DeepFryer.aasx` | 3.0 | stopped (A) | — | — | — | same | dropped 0 · schema fail |
| 134 | `ABH_MICUBE_IMPIX-main/ABH_V2/9. ResistanceWeldingController(저항용접기)/ResistanceWelding.aasx` | 3.0 | stopped (A) | — | — | — | same | dropped 0 · schema fail |
| 135 | `ABH_MICUBE_IMPIX-main/IMPIX/1. Distiller(증류기)/Distiller.aasx` | 3.0 | stopped (A) | — | — | — | same | dropped 0 · schema fail |
| 136 | `ABH_MICUBE_IMPIX-main/IMPIX/1. Distiller(증류기)/Distiller_v2.aasx` | 3.0 | stopped (A) | — | — | — | same | dropped 0 · schema fail |
| 137 | `ABH_MICUBE_IMPIX-main/IMPIX/2. Extractor(추출기)/Extractor.aasx` | 3.0 | stopped (A) | — | — | — | same | dropped 0 · schema fail |
| 138 | `ABH_MICUBE_IMPIX-main/IMPIX/2. Extractor(추출기)/Extractor_v2.aasx` | 3.0 | stopped (A) | — | — | — | same | dropped 0 · schema fail |
| 139 | `ABH_MICUBE_IMPIX-main/IMPIX/3. FiltrationSystem(여과기)/FiltrationSystem.aasx` | 3.0 | stopped (A) | — | — | — | same | dropped 0 · schema fail |
| 140 | `ABH_MICUBE_IMPIX-main/IMPIX/3. FiltrationSystem(여과기)/FiltrationSystem_v2.aasx` | 3.0 | stopped (A) | — | — | — | same | dropped 0 · schema fail |
| 141 | `ABH_MICUBE_IMPIX-main/IMPIX/4. Cooler(냉각기)/Cooler.aasx` | 3.0 | stopped (A) | — | — | — | same | dropped 0 · schema fail |
| 142 | `ABH_MICUBE_IMPIX-main/IMPIX/4. Cooler(냉각기)/Cooler_v2.aasx` | 3.0 | stopped (A) | — | — | — | same | dropped 0 · schema fail |
| 143 | `ABH_MICUBE_IMPIX-main/IMPIX/5. Mixer(혼합기)/Mixer.aasx` | 3.0 | stopped (A) | — | — | — | same | dropped 0 · schema fail |
| 144 | `ABH_MICUBE_IMPIX-main/IMPIX/5. Mixer(혼합기)/Mixer_v2.aasx` | 3.0 | stopped (A) | — | — | — | same | dropped 0 · schema fail |
| 145 | `ABH_MICUBE_IMPIX-main/IMPIX/6. PostWeldHeatTreatment(용접후열처리장비)/PostWeldHeatTreatment.aasx` | 3.0 | stopped (A) | — | — | — | same | dropped 0 · schema fail |
| 146 | `ABH_MICUBE_IMPIX-main/IMPIX/6. PostWeldHeatTreatment(용접후열처리장비)/PostWeldHeatTreatment_v2.aasx` | 3.0 | stopped (A) | — | — | — | same | dropped 0 · schema fail |
| 147 | `ABH_MICUBE_IMPIX-main/MICUBE-SOLUTION/1. SPI/SPI_final.aasx` | 3.0 | stopped (A) | — | — | — | same | dropped 0 · schema fail |
| 148 | `ABH_MICUBE_IMPIX-main/MICUBE-SOLUTION/2. ScreenPrinter/ScreenPrinter_final.aasx` | 3.0 | stopped (A) | — | — | — | same | dropped 0 · schema fail |
| 149 | `ABH_MICUBE_IMPIX-main/MICUBE-SOLUTION/3. Reflow/Reflow_final.aasx` | 3.0 | stopped (A) | — | — | — | same | dropped 0 · schema fail |
| 150 | `ABH_MICUBE_IMPIX-main/MICUBE-SOLUTION/4. Mounter/Mounter_final.aasx` | 3.0 | stopped (A) | — | — | — | same | dropped 0 · schema fail |
| 151 | `ABH_MICUBE_IMPIX-main/MICUBE-SOLUTION/5. AOI/AOI_final.aasx` | 3.0 | stopped (A) | — | — | — | same | dropped 0 · schema fail |
| 152 | `ABH_MICUBE_IMPIX-main/MICUBE-SOLUTION/6. ICT/ICT_fin.aasx` | 3.0 | stopped (A) | — | — | — | same | dropped 0 · schema fail |
| 153 | `LSELECTRIC_OCUBY-main/Model/01_PLC_CPU_r7.aasx` | 3.0 | stopped (A) | — | — | — | not re-readable | failed — not re-readable |
| 154 | `LSELECTRIC_OCUBY-main/Model/02_PLC_전원_r8.aasx` | 3.0 | done | 0 / 0 | 115 / 0 | 474 / 24 | not re-readable | failed — not re-readable |
| 155 | `LSELECTRIC_OCUBY-main/Model/03_입출력_디지털_r8.aasx` | 3.0 | done | 0 / 0 | 116 / 0 | 490 / 24 | not re-readable | failed — not re-readable |
| 156 | `LSELECTRIC_OCUBY-main/Model/03_입출력_아날로그_r9.aasx` | 3.0 | done | 0 / 0 | 116 / 0 | 495 / 25 | not re-readable | failed — not re-readable |
| 157 | `LSELECTRIC_OCUBY-main/Model/04_PLC_통신_r8.aasx` | 3.0 | done | 0 / 0 | 127 / 0 | 546 / 24 | not re-readable | failed — not re-readable |
| 158 | `LSELECTRIC_OCUBY-main/Model/05_단독형모션컨트롤러_r7.aasx` | 3.0 | done | 1 / 0 | 130 / 0 | 634 / 24 | not re-readable | failed — not re-readable |
| 159 | `LSELECTRIC_OCUBY-main/Model/06_서보드라이브_r6.aasx` | 3.0 | done | 1 / 0 | 117 / 0 | 623 / 25 | not re-readable | failed — not re-readable |
| 160 | `LSELECTRIC_OCUBY-main/Model/06_서보모터_r6.aasx` | 3.0 | done | 1 / 0 | 113 / 0 | 546 / 24 | not re-readable | failed — not re-readable |
| 161 | `LSELECTRIC_OCUBY-main/Model/07_저압고성능드라이브_r8.aasx` | 3.0 | done | 1 / 0 | 114 / 0 | 596 / 24 | not re-readable | failed — not re-readable |
| 162 | `LSELECTRIC_OCUBY-main/Model/08_감속기_r6.aasx` | 3.0 | done | 1 / 0 | 120 / 0 | 533 / 24 | not re-readable | failed — not re-readable |
| 163 | `LSELECTRIC_OCUBY-main/Model/09_델타로봇_r4.aasx` | 3.0 | done | 1 / 0 | 119 / 0 | 647 / 24 | not re-readable | failed — not re-readable |
| 164 | `LSELECTRIC_OCUBY-main/Model/10_무빙마그넷장치_r5.aasx` | 3.0 | done | 1 / 0 | 129 / 0 | 740 / 41 | not re-readable | failed — not re-readable |
| 165 | `LSELECTRIC_OCUBY-main/Model/11_그래픽터치패널_r8.aasx` | 3.0 | done | 0 / 0 | 111 / 0 | 612 / 25 | not re-readable | failed — not re-readable |
| 166 | `LSELECTRIC_OCUBY-main/Model/12_팬펌프제어기_r6.aasx` | 3.0 | done | 1 / 0 | 120 / 0 | 627 / 24 | not re-readable | failed — not re-readable |
| 167 | `LSELECTRIC_OCUBY-main/Model/13_소프트스타터_r4.aasx` | 3.0 | done | 1 / 0 | 120 / 0 | 621 / 25 | not re-readable | failed — not re-readable |
| 168 | `LSELECTRIC_OCUBY-main/Model/14_기중차단기_r8.aasx` | 3.0 | stopped (A) | — | — | — | not re-readable | refused — 638 values (one-letter idShort …) |
| 169 | `LSELECTRIC_OCUBY-main/Model/15_배선용차단기_r6.aasx` | 3.0 | stopped (A) | — | — | — | not re-readable | refused — 638 values (one-letter idShort …) |
| 170 | `LSELECTRIC_OCUBY-main/Model/16_진공차단기_r6.aasx` | 3.0 | stopped (A) | — | — | — | not re-readable | refused — 706 values (one-letter idShort …) |
| 171 | `LSELECTRIC_OCUBY-main/Model/17_소형회로차단기_r6.aasx` | 3.0 | stopped (A) | — | — | — | not re-readable | refused — 517 values (one-letter idShort …) |
| 172 | `LSELECTRIC_OCUBY-main/Model/18_모터관리장치_r4.aasx` | 3.0 | stopped (A) | — | — | — | not re-readable | refused — 104 values (one-letter idShort …) |
| 173 | `LSELECTRIC_OCUBY-main/Model/19_누전차단기_r4.aasx` | 3.0 | stopped (A) | — | — | — | not re-readable | refused — 505 values (one-letter idShort …) |
| 174 | `LSELECTRIC_OCUBY-main/Model/20_잔류전류차단기_r6.aasx` | 3.0 | stopped (A) | — | — | — | not re-readable | refused — 452 values (one-letter idShort …) |
| 175 | `LSELECTRIC_OCUBY-main/Model/21_소형회로잔류전류차단기_r4.aasx` | 3.0 | stopped (A) | — | — | — | not re-readable | refused — 452 values (one-letter idShort …) |
| 176 | `LSELECTRIC_OCUBY-main/Model/22_전자접촉기_r5.aasx` | 3.0 | stopped (A) | — | — | — | not re-readable | refused — 90 values (one-letter idShort …) |
| 177 | `LSELECTRIC_OCUBY-main/Model/23_열과부하계전기_r3.aasx` | 3.0 | stopped (A) | — | — | — | not re-readable | refused — 61 values (one-letter idShort …) |
| 178 | `LSELECTRIC_OCUBY-main/Model/24_보조_계전기_r4.aasx` | 3.0 | stopped (A) | — | — | — | not re-readable | refused — 59 values (one-letter idShort …) |
| 179 | `LSELECTRIC_OCUBY-main/Model/25_시리얼내장_다기능측정기_r5.aasx` | 3.0 | stopped (A) | — | — | — | not re-readable | refused — 508 values (one-letter idShort …) |
