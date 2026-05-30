import json
import os
import re
from difflib import SequenceMatcher

KOREAN_PATTERN = re.compile(r"[\uac00-\ud7a3\u3131-\u318e]+")
PUNCTUATION_ONLY_PATTERN = re.compile(r"^[\s:,.()'\"`-]+$")
TREASURE_QUALITY_MAP = {
    "궁극의": "Ultimate",
    "금이간": "Cracked",
    "금이 간": "Cracked",
    "완벽한": "Perfect",
    "왕실의": "Royal",
    "정교한": "Exquisite",
    "평범한": "Normal",
    "흠이 있는": "Flawed",
}

ARTIFACT_ITEMS = {
    "abyssal trident",
    "aegis",
    "bloodthirst",
    "catice",
    "cinder",
    "deathbloom",
    "delirium",
    "dryad's wrath",
    "echo of screams",
    "elven bow of truth",
    "famine",
    "fulgor",
    "illusory",
    "kuma's claw",
    "kuma's fang",
    "leviathan",
    "life after death",
    "nipalan",
    "pestilence",
    "pulverizing prayer",
    "soulscraper",
    "spellweaver",
    "stinky stick",
    "viola",
    "zirkzi's eye",
}

CANONICAL_REVERSE_ATTRIBUTES = {
    "Dexterity": "\uc7ac\uc8fc",
    "Resourcefulness": "\uc218\uc644",
    "Physical Damage Bonus": "\ubb3c\ub9ac \ud53c\ud574 \ubcf4\ub108\uc2a4",
    "Magical Damage Bonus": "\ub9c8\ubc95 \ud53c\ud574 \ubcf4\ub108\uc2a4",
    "Additional Magical Damage": "\ucd94\uac00 \ub9c8\ubc95 \ud53c\ud574",
}

DEFERRED_API_OPTION_PATTERNS = (
    re.compile(r"Race Damage (?:Bonus|Reduction)$"),
)


class Translator:
    def __init__(self, mapping_dir):
        self.mapping_dir = mapping_dir
        self.items = {}
        self.attributes = {}
        self.keywords = {}
        self.custom = {}
        self.load_mappings()

    def load_mappings(self):
        self._load_json("items.json", self.items)
        self._load_json("attributes.json", self.attributes)
        self._load_json("keywords.json", self.keywords)
        self._load_json("custom.json", self.custom)

    def _load_json(self, filename, target):
        path = os.path.join(self.mapping_dir, filename)
        if not os.path.exists(path):
            return

        with open(path, "r", encoding="utf-8") as file:
            target.update(json.load(file))

    def save_custom(self):
        os.makedirs(self.mapping_dir, exist_ok=True)
        path = os.path.join(self.mapping_dir, "custom.json")
        with open(path, "w", encoding="utf-8") as file:
            json.dump(self.custom, file, ensure_ascii=False, indent=2)

    def add_custom_mapping(self, korean, english):
        self.custom[korean] = english
        self.save_custom()

    def remove_custom_mapping(self, korean):
        if korean in self.custom:
            del self.custom[korean]
            self.save_custom()

    def get_all_mappings(self):
        combined = {}
        combined.update(self.keywords)
        combined.update(self.attributes)
        combined.update(self.items)
        combined.update(self.custom)
        return combined

    def reverse_attributes(self):
        reverse = {english: korean for korean, english in self.attributes.items()}
        reverse.update(CANONICAL_REVERSE_ATTRIBUTES)
        return reverse

    def reverse_keywords(self):
        return {english: korean for korean, english in self.keywords.items()}

    def translate_text(self, korean_text, rarity_override=None):
        if not korean_text:
            return ""

        mappings = self.get_all_mappings()
        item_line = ""
        option_lines = []
        rarity = rarity_override or self._detect_rarity(korean_text)
        english_items = set(self.items.values()) | set(self.custom.values())
        english_terms = set(mappings.values())

        for index, raw_line in enumerate(korean_text.strip().split("\n")):
            line = raw_line.strip()
            if not line:
                continue

            translated = self._translate_line(line, mappings, index == 0)
            cleaned = KOREAN_PATTERN.sub("", translated)
            cleaned = re.sub(r"\s+", " ", cleaned).strip()
            cleaned = self._normalize_english_line(cleaned, english_terms)

            if not item_line and self._is_known_english_item(cleaned, english_items):
                item_line = cleaned
                continue

            if item_line and self._is_random_option_line(cleaned):
                option_lines.append(cleaned)

        if not item_line:
            return ""

        if item_line.lower() in ARTIFACT_ITEMS:
            rarity = "Artifact"

        translated_lines = [item_line]
        if rarity:
            translated_lines.append(f"Rarity: {rarity}")
        translated_lines.extend(sorted(option_lines, key=self._api_option_priority))

        return "\n".join(translated_lines)

    def display_lines(self, korean_text):
        return [
            line.strip()
            for line in korean_text.strip().split("\n")
            if line.strip()
        ]

    def detect_rarity(self, korean_text):
        return self._detect_rarity(korean_text) or "Common"

    def _detect_rarity(self, korean_text):
        rarity_map = {
            "\ucd08\ub77c\ud55c": "Poor",
            "\uc77c\ubc18\uc801\uc778": "Common",
            "\uc77c\ubc18": "Common",
            "\uace0\uae09": "Uncommon",
            "\ud76c\uadc0\ud55c": "Rare",
            "\uc11c\uc0ac\uc801\uc778": "Epic",
            "\uc11c\uc0ac": "Epic",
            "\uc601\uc6c5": "Epic",
            "\uc804\uc124\uc801\uc778": "Legendary",
            "\uc804\uc124": "Legendary",
            "\uc720\uc77c\ud55c": "Unique",
            "\uace0\uc720\ud55c": "Unique",
            "\uc720\ub2c8\ud06c": "Unique",
            "\uc720\ubb3c": "Artifact",
        }

        for korean, english in rarity_map.items():
            if korean in korean_text:
                return english

        return None

    def get_unmapped_terms(self, korean_text):
        mappings = self.get_all_mappings()
        unmapped = []

        for line in korean_text.strip().split("\n"):
            line = line.strip()
            if not line:
                continue

            if line in mappings:
                continue

            if any(korean in line for korean in mappings):
                continue

            if KOREAN_PATTERN.search(line):
                unmapped.append(line)

        return unmapped

    def _translate_line(self, line, mappings, is_first_line=False):
        if line in mappings:
            return self._preserve_treasure_quality(line, mappings[line])

        normalized = line.replace("：", ":")
        if normalized in mappings:
            return self._preserve_treasure_quality(normalized, mappings[normalized])

        if is_first_line:
            fuzzy = self._fuzzy_match_item(line)
            if fuzzy:
                return fuzzy

        stat_match = re.match(r"^([+\-]?\d+\.?\d*%?)\s*(.+)$", line)
        if stat_match:
            value = stat_match.group(1)
            stat_name = stat_match.group(2).strip()
            translated_stat = mappings.get(stat_name) or mappings.get(stat_name.replace(" ", ""))
            if translated_stat:
                return f"{value} {translated_stat}"

        translated = line
        for korean, english in sorted(mappings.items(), key=lambda item: -len(item[0])):
            if len(korean) >= 2:
                translated = translated.replace(korean, english)

        return translated

    def _normalize_english_line(self, line, english_terms):
        if not line:
            return ""

        for term in sorted(english_terms, key=len, reverse=True):
            if not term or not line.startswith(term):
                continue

            suffix = line[len(term):].strip()
            if re.match(r"^[+\-]?\d+(\.\d+)?%?$", suffix):
                return f"{term} {suffix}"

        return line

    def _is_known_english_item(self, line, english_items):
        if line in english_items:
            return True

        base_name = re.sub(r"\s+\([^)]+\)$", "", line)
        return base_name in english_items

    def _preserve_treasure_quality(self, korean_line, english_name):
        match = re.search(r"\(([^)]+)\)\s*$", korean_line)
        if not match:
            return english_name

        quality = TREASURE_QUALITY_MAP.get(match.group(1).strip())
        if not quality:
            return english_name

        if english_name.endswith(f"({quality})"):
            return english_name

        return f"{english_name} ({quality})"

    def _is_random_option_line(self, line):
        if not line or PUNCTUATION_ONLY_PATTERN.match(line):
            return False

        return bool(re.match(r"^[+\-]\d+(\.\d+)?%?\s+[A-Za-z]", line))

    def _api_option_priority(self, line):
        return int(any(pattern.search(line) for pattern in DEFERRED_API_OPTION_PATTERNS))

    def _fuzzy_match_item(self, text, threshold=0.74):
        best_match = None
        best_score = 0

        for korean, english in self.items.items():
            score = SequenceMatcher(None, text, korean).ratio()
            if score > best_score and score >= threshold:
                best_score = score
                best_match = english

        return best_match
