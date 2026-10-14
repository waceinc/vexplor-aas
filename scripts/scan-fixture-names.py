"""Find and list **text that looks like real company names, products or contact details** inside test files (AASX).

This keeps files carrying real manufacturer or model names out of the public repository.
Run it before and after anonymizing and confirm the count **reaches 0**.

    python scripts/scan-fixture-names.py tests/fixtures          # exit code 1 if anything is found
    python scripts/scan-fixture-names.py tests/fixtures --all    # every string (for review)

AASX is read directly with zipfile + json — a basyx round-trip load loses SubmodelElementList subtrees.
"""
import glob
import io
import json
import re
import sys
import zipfile

# What looks like real company names and trademarks (Korean and English spellings — the Korean patterns are intentional).
# Important: made-up names such as "Example Manufacturer" are left unmatched
BRANDS = re.compile(
    r"두산|Doosan|DOOSAN|SIMPAC|심팩|Samick|삼익|Atlas ?Copco|AtlasCopco|아틀라스|Henrob|Tucker|"
    r"B[oö]llhoff|Stanley|현대|Hyundai|기아자동차|삼성|포스코|POSCO|LS ?일렉|Siemens|지멘스|"
    r"Mitsubishi|미쓰비시|Fanuc|화낙|\bABB\b|KUKA|Universal Robots|Rainbow Robotics|레인보우|뉴로메카|Neuromeka"
)
# Contact details that lead to people or companies
CONTACT = re.compile(r"[\w.+-]+@[\w-]+\.[\w.]+|\+82[\d -]{8,}|\b0\d{1,2}-\d{3,4}-\d{4}\b")


def strings_of(raw: str, is_json: bool) -> set[str]:
    """Extract every string.

    Important: do not scan JSON with regexes. A one-character string such as `"1"` flips the quote pairing
       and everything after it is missed — it once reported 0 for a file that contained a real robot maker's name.
       A search tool that silently misses is the worst kind. Parse it and walk the values one by one.
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
            # The part name itself can carry a real name (attachment file name)
            if BRANDS.search(name) or CONTACT.search(name):
                found.add(f"[part name] {name}")
            if not (name.endswith(".json") or name.endswith(".xml") or name.endswith(".rels")):
                continue
            raw = archive.read(name).decode("utf-8", "replace")
            for text in strings_of(raw, name.endswith(".json")):
                if show_all or BRANDS.search(text) or CONTACT.search(text):
                    found.add(text)
        out.write(f"\n===== {path}: {len(found)} =====\n")
        for text in sorted(found):
            out.write(f"  {text}\n")
        total += len(found)
    out.write(f"\nTotal {total}\n")
    out.flush()
    return 0 if show_all or total == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
