import argparse
import json
import re
from pathlib import Path

try:
    from pylocres import LocresFile
except ImportError as exc:
    raise SystemExit(
        "pylocres is required. Install it with: python -m pip install pylocres"
    ) from exc


KOREAN_RE = re.compile(r"[\uac00-\ud7a3\u3131-\u318e]")
ASCII_RE = re.compile(r"[A-Za-z]")


def iter_locres_paths(path):
    path = Path(path)
    if path.is_file() and path.suffix.lower() == ".locres":
        yield path
        return

    if path.is_dir():
        yield from sorted(path.rglob("*.locres"))


def read_locres(path):
    locres = LocresFile()
    locres.read(path)

    rows = {}
    for namespace in locres:
        namespace_name = namespace.name or ""
        for entry in namespace:
            key = f"{namespace_name}\0{entry.key}"
            rows[key] = str(entry.translation).strip()

    return rows


def read_many(paths):
    merged = {}
    for path in paths:
        merged.update(read_locres(path))
    return merged


def build_pairs(ko_rows, en_rows):
    pairs = {}
    conflicts = {}

    for key, korean in ko_rows.items():
        english = en_rows.get(key)
        if not korean or not english:
            continue
        if korean == english:
            continue
        if not KOREAN_RE.search(korean):
            continue
        if not ASCII_RE.search(english):
            continue

        previous = pairs.get(korean)
        if previous and previous != english:
            conflicts.setdefault(korean, sorted({previous, english}))
            continue

        pairs[korean] = english

    return dict(sorted(pairs.items())), dict(sorted(conflicts.items()))


def write_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def main():
    parser = argparse.ArgumentParser(
        description="Build Korean to English mapping from paired Unreal .locres files."
    )
    parser.add_argument("--ko", required=True, help="Korean .locres file or directory")
    parser.add_argument("--en", required=True, help="English .locres file or directory")
    parser.add_argument(
        "--out",
        default="korean/mapping/generated/all.json",
        help="Output JSON mapping path",
    )
    parser.add_argument(
        "--conflicts",
        default="korean/mapping/generated/conflicts.json",
        help="Output JSON conflicts path",
    )
    args = parser.parse_args()

    ko_paths = list(iter_locres_paths(args.ko))
    en_paths = list(iter_locres_paths(args.en))

    if not ko_paths:
        raise SystemExit(f"No Korean .locres files found: {args.ko}")
    if not en_paths:
        raise SystemExit(f"No English .locres files found: {args.en}")

    ko_rows = read_many(ko_paths)
    en_rows = read_many(en_paths)
    pairs, conflicts = build_pairs(ko_rows, en_rows)

    write_json(args.out, pairs)
    write_json(args.conflicts, conflicts)

    print(f"Korean locres files: {len(ko_paths)}")
    print(f"English locres files: {len(en_paths)}")
    print(f"Korean rows: {len(ko_rows)}")
    print(f"English rows: {len(en_rows)}")
    print(f"Mapping pairs: {len(pairs)}")
    print(f"Conflicts: {len(conflicts)}")
    print(f"Wrote: {args.out}")
    print(f"Wrote: {args.conflicts}")


if __name__ == "__main__":
    main()
