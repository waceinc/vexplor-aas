#!/usr/bin/env python3
"""
aas-test-engines check — **a pass/fail verdict independent of our linter**.

The project treats the KOSMO Validator and `aas-test-engines` as the only authorities on pass/fail.
Our linter implements the KOSMO business rules (L3) itself, so **whether the standard itself is violated**
has to be checked separately with this tool.

Usage:
    out/venv/bin/python scripts/aas-test-engines.py <file.aasx> [...]
    (install: python3 -m venv out/venv && out/venv/bin/pip install aas-test-engines==1.0.3)

Exit code: 1 if there is any error.
"""
import sys
from collections import Counter

from aas_test_engines import file
from aas_test_engines.result import Level


def walk(result, counter, messages, path=''):
    """Walk the result tree and count findings per level.

    **Count leaves only.** A parent inherits the worst level among its children, so counting parents too
    reports wrappers such as "Check constraints" as errors and hides the actual cause.
    """
    children = getattr(result, 'sub_results', [])
    here = f'{path} › {result.message}' if path else result.message

    if not children:
        counter[result.level] += 1
        if result.level in (Level.ERROR, Level.CRITICAL, Level.WARNING):
            messages.setdefault(result.level, []).append((result.message, path))
        return

    for child in children:
        walk(child, counter, messages, here)


def check(path: str) -> bool:
    with open(path, 'rb') as handle:
        result = file.check_aasx_file(handle)

    counter = Counter()
    messages = {}
    walk(result, counter, messages)

    ok = result.ok()
    errors = counter[Level.ERROR] + counter[Level.CRITICAL]
    warnings = counter[Level.WARNING]
    print(f"{'[PASS]' if ok else '[FAIL]'}  {path}")
    print(f"   errors {errors} · warnings {warnings} · info {counter[Level.INFO]}")

    for level, label in ((Level.CRITICAL, 'critical'), (Level.ERROR, 'error'), (Level.WARNING, 'warning')):
        # The same finding often repeats 137 times — group by message for display
        seen = Counter(message for message, _ in messages.get(level, []))
        where = {message: path for message, path in messages.get(level, [])}
        for message, count in seen.most_common(6):
            short = message if len(message) < 160 else message[:157] + '…'
            print(f"   [{label}] (x{count}) {short}")
            if level != Level.WARNING:
                print(f"           at: {where[message][-120:]}")
    return ok


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    results = [check(path) for path in sys.argv[1:]]
    sys.exit(0 if all(results) else 1)
