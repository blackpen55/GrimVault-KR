import argparse
import json
import re
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from collections import defaultdict
from pathlib import Path


DEFAULT_SITEMAP_URL = "https://dakdak.kr/sitemap.xml"
ITEM_PAGES = {
    "accessories.php",
    "armors.php",
    "miscs.php",
    "utilities.php",
    "weapons.php",
}


def load_sitemap(url):
    with urllib.request.urlopen(url, timeout=30) as response:
        return response.read()


def parse_pairs(sitemap_bytes, pages):
    root = ET.fromstring(sitemap_bytes)
    namespace = {"sm": "http://www.sitemaps.org/schemas/sitemap/0.9"}
    pairs_by_page = defaultdict(dict)
    conflicts = defaultdict(set)

    for loc in root.findall(".//sm:loc", namespace):
        url = loc.text or ""
        parsed = urllib.parse.urlparse(url)
        page = Path(parsed.path).name
        if page not in pages:
            continue

        query = urllib.parse.parse_qs(parsed.query)
        english = (query.get("name_en") or [""])[0].strip()
        korean = (query.get("name_ko") or [""])[0].strip()
        if not english or not korean:
            continue

        previous = pairs_by_page[page].get(korean)
        if previous and previous != english:
            conflicts[korean].update((previous, english))
            continue

        pairs_by_page[page][korean] = english

    return pairs_by_page, {key: sorted(value) for key, value in conflicts.items()}


def write_json(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(data, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def main():
    parser = argparse.ArgumentParser(
        description="Build Korean to English item mappings from dakdak.kr sitemap."
    )
    parser.add_argument("--sitemap", default=DEFAULT_SITEMAP_URL)
    parser.add_argument("--out-dir", default="korean/mapping/generated/dakdak")
    args = parser.parse_args()

    pairs_by_page, conflicts = parse_pairs(load_sitemap(args.sitemap), ITEM_PAGES)
    out_dir = Path(args.out_dir)

    merged = {}
    for page, pairs in sorted(pairs_by_page.items()):
        merged.update(pairs)
        write_json(out_dir / f"{page.removesuffix('.php')}.json", dict(sorted(pairs.items())))

    write_json(out_dir / "items.json", dict(sorted(merged.items())))
    write_json(out_dir / "conflicts.json", dict(sorted(conflicts.items())))

    print(f"Pages: {len(pairs_by_page)}")
    print(f"Item mappings: {len(merged)}")
    print(f"Conflicts: {len(conflicts)}")
    print(f"Wrote: {out_dir}")


if __name__ == "__main__":
    main()
