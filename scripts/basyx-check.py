#!/usr/bin/env python3
"""
basyx-python-sdk load check — **interoperability measured, not assumed**.

Every run confirms the two known basyx pitfalls:
  (1) an idShort on a direct child of a SubmodelElementList violates AASd-120
  (2) an invalid semanticId key type makes basyx **silently drop the submodel** (measured 7 -> 5)

[WARN] Measurement on 2026-08-24 corrected how (1) shows up. basyx 1.2.1 **raises an exception and keeps reading** —
the file "opens" and the submodel count is unchanged, but **the list children and their whole subtrees are missing.**
Golden file measured: only **99** elements read / the same file with AASd-120 fixed reads **164**. 65 vanish without a word.

So this does not stop at "opened / did not open" — **it counts elements too.** Silent loss is the trap here.

Usage:
    out/venv/bin/python scripts/basyx-check.py <file.aasx> [...] [--expect-submodels 7]
    (install: out/venv/bin/pip install basyx-python-sdk==1.2.1)

Exit code: 1 if any file cannot be read.
"""
import sys

from basyx.aas import model
from basyx.aas.adapter.aasx import AASXReader, DictSupplementaryFileContainer
from basyx.aas.model import DictObjectStore


def count_elements(collection) -> int:
    """Count down through the subtrees. **A drop here is the silent loss.**"""
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
    except Exception as error:  # noqa: BLE001 — any exception counts as "load failed"
        print(f"[FAIL] load failed  {path}")
        print(f"   {type(error).__name__}: {str(error)[:200]}")
        return False

    shells = [o for o in store if isinstance(o, model.AssetAdministrationShell)]
    submodels = [o for o in store if isinstance(o, model.Submodel)]
    concepts = [o for o in store if isinstance(o, model.ConceptDescription)]
    elements = sum(count_elements(s.submodel_element) for s in submodels)

    ok = True
    print(f"[OK] loaded  {path}")
    # DictSupplementaryFileContainer does not support len() — count by iterating
    attachments = sum(1 for _ in files)
    print(
        f"   AAS {len(shells)} · Submodel {len(submodels)} · "
        f"ConceptDescription {len(concepts)} · elements {elements} · attachments {attachments}"
    )

    if elements == 0 and submodels:
        print("   [FAIL] no elements were read — suspect silent loss")
        ok = False
    if expect_submodels is not None and len(submodels) != expect_submodels:
        # Silent drop — vanishing without an exception is the more dangerous case
        print(f"   [FAIL] expected {expect_submodels} submodels but got {len(submodels)}. Silently dropped")
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
