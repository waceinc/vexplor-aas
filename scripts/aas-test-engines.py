#!/usr/bin/env python3
"""
aas-test-engines 검증 — **우리 린터와 독립된 합격 판정**.

CLAUDE.md 「검증 도구 원칙」은 KOSMO Validator와 `aas-test-engines`를 유일한 합격 판정 주체로 둔다.
우리 린터(M5)는 KOSMO 사업 규칙(L3)을 자체 구현한 것이므로, **표준 자체를 어겼는지**는
이 도구로 따로 확인해야 한다.

사용:
    out/venv/bin/python scripts/aas-test-engines.py <파일.aasx> [...]
    (설치: python3 -m venv out/venv && out/venv/bin/pip install aas-test-engines==1.0.3)

종료 코드: 오류가 하나라도 있으면 1.
"""
import sys
from collections import Counter

from aas_test_engines import file
from aas_test_engines.result import Level


def walk(result, counter, messages, path=''):
    """결과 트리를 훑어 등급별로 센다.

    **말단만 센다.** 부모는 자식 중 가장 나쁜 등급을 물려받으므로, 부모까지 세면
    "Check constraints" 같은 껍데기가 오류로 잡혀 원인이 가려진다.
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
    print(f"{'✅ 통과' if ok else '❌ 실패'}  {path}")
    print(f"   오류 {errors}건 · 경고 {warnings}건 · 확인 {counter[Level.INFO]}건")

    for level, label in ((Level.CRITICAL, '치명'), (Level.ERROR, '오류'), (Level.WARNING, '경고')):
        # 같은 지적이 137번 반복되는 일이 흔하다 — 문구로 묶어서 보여 준다
        seen = Counter(message for message, _ in messages.get(level, []))
        where = {message: path for message, path in messages.get(level, [])}
        for message, count in seen.most_common(6):
            short = message if len(message) < 160 else message[:157] + '…'
            print(f"   [{label}] ({count}건) {short}")
            if level != Level.WARNING:
                print(f"           위치: {where[message][-120:]}")
    return ok


if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    results = [check(path) for path in sys.argv[1:]]
    sys.exit(0 if all(results) else 1)
