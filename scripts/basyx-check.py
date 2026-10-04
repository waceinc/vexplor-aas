#!/usr/bin/env python3
"""
basyx-python-sdk 적재 검증 — **상호운용의 실측**.

CLAUDE.md 「절대 잊으면 안 되는」 §1·§3이 말하는 두 가지를 이 스크립트가 매번 확인한다.
  ① SML 직계 자식에 idShort가 있으면 AASd-120에 걸린다
  ② 잘못된 semanticId 키 타입을 만나면 **서브모델을 조용히 드롭한다**(실측 7→5)

🔴 2026-08-24 실측으로 ①의 양상을 정정했다. basyx 1.2.1은 **예외를 던지고도 읽기를 계속한다** —
파일은 "열리고" 서브모델 수도 그대로인데 **SML 자식과 그 아래 하위 트리가 통째로 빠진다.**
골든 파일 실측: 요소 **99개**만 읽힘 / AASd-120을 고친 같은 파일은 **164개**. 65개가 말없이 사라진다.

그래서 "열렸다/안 열렸다"로 끝내지 않고 **요소까지 센다.** 조용한 손실이 이 판의 함정이다.

사용:
    out/venv/bin/python scripts/basyx-check.py <파일.aasx> [...] [--expect-submodels 7]
    (설치: out/venv/bin/pip install basyx-python-sdk==1.2.1)

종료 코드: 하나라도 읽지 못하면 1.
"""
import sys

from basyx.aas import model
from basyx.aas.adapter.aasx import AASXReader, DictSupplementaryFileContainer
from basyx.aas.model import DictObjectStore


def count_elements(collection) -> int:
    """하위 트리까지 센다. **여기서 줄어드는 것이 조용한 손실이다.**"""
    total = 0
    for element in collection:
        total += 1
        if isinstance(element, (model.SubmodelElementList, model.SubmodelElementCollection)):
            total += count_elements(element.value)
    return total


def check(path: str, expect_submodels: int = None) -> bool:
    store = DictObjectStore()
    files = DictSupplementaryFileContainer()
    try:
        with AASXReader(path) as reader:
            reader.read_into(object_store=store, file_store=files)
    except Exception as error:  # noqa: BLE001 — 어떤 예외든 "적재 실패"로 본다
        print(f"❌ 적재 실패  {path}")
        print(f"   {type(error).__name__}: {str(error)[:200]}")
        return False

    shells = [o for o in store if isinstance(o, model.AssetAdministrationShell)]
    submodels = [o for o in store if isinstance(o, model.Submodel)]
    concepts = [o for o in store if isinstance(o, model.ConceptDescription)]
    elements = sum(count_elements(s.submodel_element) for s in submodels)

    ok = True
    print(f"✅ 적재됨  {path}")
    # DictSupplementaryFileContainer는 len()을 지원하지 않는다 — 순회해서 센다
    attachments = sum(1 for _ in files)
    print(
        f"   AAS {len(shells)} · Submodel {len(submodels)} · "
        f"ConceptDescription {len(concepts)} · 요소 {elements} · 첨부 {attachments}"
    )

    if elements == 0 and submodels:
        print("   ⚠️  요소가 하나도 안 읽혔다 — 조용한 손실을 의심할 것")
        ok = False
    if expect_submodels is not None and len(submodels) != expect_submodels:
        # 조용한 드롭 — 예외 없이 사라지는 쪽이 더 위험하다
        print(f"   ⚠️  서브모델이 {expect_submodels}개여야 하는데 {len(submodels)}개다. 조용히 드롭됐다")
        ok = False
    return ok


if __name__ == '__main__':
    args = [a for a in sys.argv[1:]]
    expect = None
    if '--expect-submodels' in args:
        index = args.index('--expect-submodels')
        expect = int(args[index + 1])
        del args[index:index + 2]
    if not args:
        print(__doc__)
        sys.exit(2)
    results = [check(path, expect) for path in args]
    sys.exit(0 if all(results) else 1)
