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

    def translate_text(self, korean_text):
        if not korean_text:
            return ""

        mappings = self.get_all_mappings()
        translated_lines = []
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

            if self._is_useful_api_line(cleaned, len(translated_lines) == 0):
                translated_lines.append(cleaned)

        if not translated_lines or translated_lines[0] not in english_items:
            return ""

        return "\n".join(translated_lines)

    def display_lines(self, korean_text):
        return [
            line.strip()
            for line in korean_text.strip().split("\n")
            if line.strip()
        ]

    def detect_rarity(self, korean_text):
        rarity_map = {
            "조잡": "Poor",
            "일반": "Common",
            "고급": "Uncommon",
            "희귀": "Rare",
            "영웅": "Epic",
            "전설": "Legendary",
            "유니크": "Unique",
            "아티팩트": "Artifact",
        }

        for korean, english in rarity_map.items():
            if korean in korean_text:
                return english

        return "Common"

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

    def _is_useful_api_line(self, line, is_first_line):
        if not line or PUNCTUATION_ONLY_PATTERN.match(line):
            return False

        if is_first_line:
            return True

        if any(char.isdigit() for char in line):
            return True

        return line in {
            "Poor",
            "Common",
            "Uncommon",
            "Rare",
            "Epic",
            "Legendary",
            "Unique",
            "Artifact",
        }

    def _fuzzy_match_item(self, text, threshold=0.74):
        best_match = None
        best_score = 0

        for korean, english in self.items.items():
            score = SequenceMatcher(None, text, korean).ratio()
            if score > best_score and score >= threshold:
                best_score = score
                best_match = english

        return best_match
