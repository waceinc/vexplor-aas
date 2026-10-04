# IDTA Part 2 (API) 규격 원문 — 사본

`AAS_OPC UA.md` §7-3에서 "Part 2 원문 미확보"로 남아 있던 항목을 해소한 자료다.
우리 API가 규격에서 벗어나지 않는지 **자동으로 대조**하기 위해 저장소 안에 둔다
(네트워크가 없는 폐쇄망·CI에서도 대조가 돌아야 한다 — 기획서 Ⅷ).

| 파일 | 내용 |
|---|---|
| `part2-v3.0.4.yaml` | 공통 스키마·질의 인자 (Message · Result · PagedResult · PackageDescription · Limit/Cursor/IdShort/SemanticId …) |
| `AssetAdministrationShellRepositoryServiceSpecification_V3.0_SSP-001.yaml` | `/shells` |
| `SubmodelRepositoryServiceSpecification_V3.0_SSP-001.yaml` | `/submodels` |
| `ConceptDescriptionServiceSpecification_V3.0_SSP-001.yaml` | `/concept-descriptions` |
| `AasxFileServer_V3.0_SSP-001.yaml` | `/packages` — **AASX 파일 서버 인터페이스** |
| `AssetAdministrationShellRegistryServiceSpecification_V3.0_SSP-001.yaml` | `/shell-descriptors` — **레지스트리** |
| `SubmodelRegistryServiceSpecification_V3.0_SSP-001.yaml` | `/submodel-descriptors` |
| `DiscoveryServiceSpecification_V3.0_SSP-001.yaml` | `/lookup/shells` — **자산 번호로 AAS 찾기** |

- 출처: <https://github.com/admin-shell-io/aas-specs-api> 태그 `v3.0.4`
  (IDTA-01002-3-0 계열의 최신 버그픽스. 우리 메타모델이 V3.0이므로 3.1이 아니라 3.0 계열을 쓴다)
- 발행: Industrial Digital Twin Association (IDTA)
- 라이선스: **CC BY 4.0** — 원문 그대로 두고 출처를 밝힌다. 수정하지 말 것

## 대조하는 법

```bash
node scripts/part2-coverage.mjs            # 구현/미구현 요약
node scripts/part2-coverage.mjs --all      # 미구현까지 전부 나열
```

우리 라우트 표(`@aas/api`)를 규격의 경로·메서드·성공 상태코드와 맞대어 본다.
**규격에 없는 경로를 우리가 열어 두었는지도 함께 본다** — 표준 경로를 우리 뜻대로 다르게 쓰면
Part 2 클라이언트가 조용히 오작동하기 때문이다.
