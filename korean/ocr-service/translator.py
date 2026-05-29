import json
import os
import re
from difflib import SequenceMatcher

KOREAN_PATTERN = re.compile(r"[\uac00-\ud7a3\u3131-\u318e]+")
PUNCTUATION_ONLY_PATTERN = re.compile(r"^[\s:,.()'\"`-]+$")


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
        return {english: korean for korean, english in self.attributes.items()}

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

            if not item_line and cleaned in english_items:
                item_line = cleaned
                continue

            if item_line and self._is_random_option_line(cleaned):
                option_lines.append(cleaned)

        if not item_line:
            return ""

        translated_lines = [item_line]
        if rarity:
            translated_lines.append(f"Rarity: {rarity}")
        translated_lines.extend(option_lines)

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
            return mappings[line]

        normalized = line.replace("：", ":")
        if normalized in mappings:
            return mappings[normalized]

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

    def _is_random_option_line(self, line):
        if not line or PUNCTUATION_ONLY_PATTERN.match(line):
            return False

        return line.startswith("+") and any(char.isdigit() for char in line)

    def _fuzzy_match_item(self, text, threshold=0.74):
        best_match = None
        best_score = 0

        for korean, english in self.items.items():
            score = SequenceMatcher(None, text, korean).ratio()
            if score > best_score and score >= threshold:
                best_score = score
                best_match = english

        return best_match
