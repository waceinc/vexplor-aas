"""시험 파일(AASX) 안의 **실제 회사·제품·연락처로 보이는 글자**를 찾아 적는다.

공개 저장소에 실제 제조사·모델명이 든 파일이 나가지 않게 하려는 것이다
(docs/오픈소스_공개_점검.md §2). 익명화 전후로 돌려 **0건이 되었는지** 확인한다.

    python scripts/scan-fixture-names.py tests/fixtures          # 찾으면 종료코드 1
    python scripts/scan-fixture-names.py tests/fixtures --all    # 문자열 전부(검토용)

AASX는 zipfile + json으로 직접 읽는다 — basyx 왕복 로드는 SML 서브트리를 잃는다(CLAUDE.md).
"""
import glob
import io
import json
import re
import sys
import zipfile

# 실제 상호·상표로 보이는 것. 🔴 「Example Manufacturer」처럼 꾸민 이름은 걸리지 않게 둔다
BRANDS = re.compile(
    r"두산|Doosan|DOOSAN|SIMPAC|심팩|Samick|삼익|Atlas ?Copco|AtlasCopco|아틀라스|Henrob|Tucker|"
    r"B[oö]llhoff|Stanley|현대|Hyundai|기아자동차|삼성|포스코|POSCO|LS ?일렉|Siemens|지멘스|"
    r"Mitsubishi|미쓰비시|Fanuc|화낙|\bABB\b|KUKA|Universal Robots|Rainbow Robotics|레인보우|뉴로메카|Neuromeka"
)
# 사람·회사에 닿는 연락처
CONTACT = re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+|\+82[\d -]{8,}|\b0\d{1,2}-\d{3,4}-\d{4}\b")


def strings_of(raw: str, is_json: bool) -> set[str]:
    """글자를 전부 꺼낸다.

    🔴 JSON을 정규식으로 훑지 않는다. `"1"` 같은 한 글자 문자열을 만나면 따옴표 짝이
       뒤집혀 그 뒤를 전부 놓친다 — 실제로 「두산로보틱스」가 든 파일을 0건이라고 했다.
       찾는 도구가 조용히 놓치는 것이 가장 나쁘다. 파서로 읽어 값을 하나씩 걷는다.
    """
    if not is_json:
        return set(re.findall(r">([^<]{2,300})<", raw)) | set(re.findall(r'="([^"]{2,300})"', raw))
    found: set[str] = set()

    def walk(node: object) -> None:
        if isinstance(node, str):
            found.add(node)
        elif isinstance(node, list):
            for item in node:
                walk(item)
        elif isinstance(node, dict):
            for key, value in node.items():
                found.add(key)
                walk(value)

    walk(json.loads(raw))
    return found


def main() -> int:
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    show_all = "--all" in sys.argv
    out = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")
    folder = args[0] if args else "tests/fixtures"
    total = 0
    for path in sorted(glob.glob(f"{folder}/*.aasx")):
        archive = zipfile.ZipFile(path)
        found: set[str] = set()
        for name in archive.namelist():
            # 파트 이름 자체에도 실제 이름이 들 수 있다(첨부 파일명)
            if BRANDS.search(name) or CONTACT.search(name):
                found.add(f"[파트 이름] {name}")
            if not (name.endswith(".json") or name.endswith(".xml") or name.endswith(".rels")):
                continue
            raw = archive.read(name).decode("utf-8", "replace")
            for text in strings_of(raw, name.endswith(".json")):
                if show_all or BRANDS.search(text) or CONTACT.search(text):
                    found.add(text)
        out.write(f"\n===== {path}: {len(found)}건 =====\n")
        for text in sorted(found):
            out.write(f"  {text}\n")
        total += len(found)
    out.write(f"\n합계 {total}건\n")
    out.flush()
    return 0 if show_all or total == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
