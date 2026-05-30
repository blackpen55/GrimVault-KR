import json
import logging
import os
import sys
import time
import re

import cv2
import numpy as np
from flask import Flask, jsonify, request

sys.path.insert(0, os.path.dirname(__file__))

from capture import capture_game_window
from detect import TooltipDetector
from ocr_engine_rapid import KoreanOCR
from translator import Translator

TOOLTIP_MODEL_PATH = os.environ.get(
    "GRIMVAULT_TOOLTIP_MODEL",
    os.path.join(os.path.dirname(__file__), "..", "..", "models", "tooltip.onnx"),
)
MAPPING_DIR = os.environ.get(
    "GRIMVAULT_MAPPING_DIR",
    os.path.join(os.path.dirname(__file__), "..", "mapping"),
)
PORT = int(os.environ.get("GRIMVAULT_OCR_PORT", "19529"))
OCR_TOP_PADDING = 72

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("grimvault-korean")

app = Flask(__name__)
HAN_PATTERN = re.compile(r"[\u3400-\u9fff]")

detector = None
ocr = None
translator = None


def initialize():
    global detector, ocr, translator

    model_path = os.path.abspath(TOOLTIP_MODEL_PATH)

    if not os.path.exists(model_path):
        candidates = [
            os.path.expandvars(r"%LOCALAPPDATA%\Programs\GrimVault-KR\resources\models\tooltip.onnx"),
            os.path.expandvars(r"%PROGRAMFILES%\GrimVault-KR\resources\models\tooltip.onnx"),
            os.path.expandvars(r"%LOCALAPPDATA%\Programs\GrimVault\resources\models\tooltip.onnx"),
        ]

        for candidate in candidates:
            if os.path.exists(candidate):
                model_path = candidate
                break

    if not os.path.exists(model_path):
        raise FileNotFoundError(f"Tooltip model not found: {model_path}")

    logger.info("Loading tooltip model: %s", model_path)
    detector = TooltipDetector(model_path)

    logger.info("Initializing Korean OCR")
    ocr = KoreanOCR()

    logger.info("Loading Korean mappings: %s", MAPPING_DIR)
    translator = Translator(MAPPING_DIR)
    logger.info("Loaded %s mappings", len(translator.get_all_mappings()))


@app.route("/health", methods=["GET"])
def health():
    return jsonify({
        "status": "ok",
        "model_loaded": detector is not None,
        "ocr_loaded": ocr is not None,
        "mappings": len(translator.get_all_mappings()) if translator else 0,
    })


@app.route("/scan", methods=["POST"])
def scan():
    start = time.time()
    screenshot, game_bounds = capture_game_window()

    if screenshot is None:
        return jsonify({"tooltip": None, "error": "Game window not found"}), 200

    boxes = detector.find_tooltips(screenshot)
    if not boxes:
        return jsonify({"tooltip": None}), 200

    last_error_tooltip = None

    for x, y, width, height in boxes:
        x = max(0, int(x))
        y = max(0, int(y))
        top_padding = min(y, OCR_TOP_PADDING)
        y -= top_padding
        width = min(int(width), screenshot.shape[1] - x)
        height = min(int(height) + top_padding, screenshot.shape[0] - y)

        if width <= 0 or height <= 0:
            continue

        region = screenshot[y:y + height, x:x + width]
        original_text = ocr.read(region)

        if not original_text:
            continue

        rarity = _detect_rarity_from_title_color(region) or translator.detect_rarity(original_text)

        if _looks_like_bad_korean_ocr(original_text):
            logger.info("Rejected non-Korean OCR text: %s", original_text.replace("\n", " | "))
            last_error_tooltip = _build_error_tooltip(
                original_text,
                rarity,
                game_bounds,
                x,
                y,
                width,
                height,
                "OCR 결과가 한국어로 인식되지 않았습니다.",
            )
            continue

        if _looks_like_grimvault_overlay(original_text):
            continue

        english_text = translator.translate_text(original_text, rarity)
        if not english_text:
            logger.info("OCR text had no English mapping: %s", original_text.replace("\n", " | "))
            last_error_tooltip = _build_error_tooltip(
                original_text,
                rarity,
                game_bounds,
                x,
                y,
                width,
                height,
                "OCR은 되었지만 아이템 이름을 영어로 매핑하지 못했습니다.",
            )
            continue

        lines = original_text.strip().split("\n")
        korean_item_name = lines[0].strip() if lines else ""
        elapsed = int((time.time() - start) * 1000)
        logger.info("Korean OCR text: %s", original_text.replace("\n", " | "))
        logger.info("Korean scan complete in %sms: %s", elapsed, english_text.replace("\n", " | "))

        return jsonify({
            "tooltip": {
                "text": english_text,
                "original_text": original_text,
                "korean_item_name": korean_item_name,
                "rarity": rarity,
                "display_lines": translator.display_lines(original_text),
                "reverse_attributes": translator.reverse_attributes(),
                "reverse_keywords": translator.reverse_keywords(),
                "unmapped_terms": translator.get_unmapped_terms(original_text),
                "game_bounds": game_bounds,
                "x": x,
                "y": y,
                "width": width,
                "height": height,
            }
        })

    if last_error_tooltip:
        return jsonify({"tooltip": last_error_tooltip}), 200

    return jsonify({"tooltip": None}), 200


@app.route("/translate", methods=["POST"])
def translate():
    data = request.get_json(force=True, silent=True) or {}
    text = data.get("text", "")
    return jsonify({
        "text": translator.translate_text(text),
        "unmapped_terms": translator.get_unmapped_terms(text),
    })


@app.route("/mapping/list", methods=["GET"])
def mapping_list():
    return jsonify({
        "items": translator.items,
        "attributes": translator.attributes,
        "keywords": translator.keywords,
        "custom": translator.custom,
    })


@app.route("/mapping/add", methods=["POST"])
def mapping_add():
    data = request.get_json(force=True, silent=True) or {}
    korean = data.get("korean", "").strip()
    english = data.get("english", "").strip()

    if not korean or not english:
        return jsonify({"error": "korean and english are required"}), 400

    translator.add_custom_mapping(korean, english)
    return jsonify({"success": True})


@app.route("/mapping/remove", methods=["POST"])
def mapping_remove():
    data = request.get_json(force=True, silent=True) or {}
    korean = data.get("korean", "").strip()

    if not korean:
        return jsonify({"error": "korean is required"}), 400

    translator.remove_custom_mapping(korean)
    return jsonify({"success": True})


def _looks_like_grimvault_overlay(text):
    patterns = (
        "Item Statistics",
        "Powered by DarkerDB",
        "Market:",
        "Vendor:",
        "Density:",
        "아이템 통계",
        "시세",
        "상점가",
    )
    return any(pattern in text for pattern in patterns)


def _looks_like_bad_korean_ocr(text):
    # Dark and Darker Korean tooltips should not contain Han ideographs. The
    # default RapidOCR Chinese recognizer often hallucinates them for Hangul.
    return bool(HAN_PATTERN.search(text))


def _build_error_tooltip(original_text, rarity, game_bounds, x, y, width, height, error):
    lines = original_text.strip().split("\n")
    korean_item_name = lines[0].strip() if lines else ""

    return {
        "text": "",
        "error": error,
        "original_text": original_text,
        "korean_item_name": korean_item_name,
        "rarity": rarity or translator.detect_rarity(original_text),
        "display_lines": translator.display_lines(original_text),
        "reverse_attributes": translator.reverse_attributes(),
        "reverse_keywords": translator.reverse_keywords(),
        "unmapped_terms": translator.get_unmapped_terms(original_text),
        "game_bounds": game_bounds,
        "x": x,
        "y": y,
        "width": width,
        "height": height,
    }


def _detect_rarity_from_title_color(region):
    if region is None or region.size == 0:
        return None

    height = region.shape[0]
    title_band = region[:max(1, int(height * 0.22)), :]
    hsv = cv2.cvtColor(title_band, cv2.COLOR_BGR2HSV)
    rgb = cv2.cvtColor(title_band, cv2.COLOR_BGR2RGB)

    saturation = hsv[:, :, 1]
    value = hsv[:, :, 2]
    mask = (value > 150) & (saturation > 35)

    if int(np.count_nonzero(mask)) < 20:
        return None

    median_hsv = np.median(hsv[mask], axis=0)
    hue = float(median_hsv[0])
    sat = float(median_hsv[1])

    if (hue <= 8 or hue >= 172) and sat >= 100:
        return "Artifact"
    if 45 <= hue <= 80 and sat >= 70:
        return "Uncommon"
    if 90 <= hue <= 115 and sat >= 70:
        return "Rare"
    if 125 <= hue <= 155 and sat >= 50:
        return "Epic"
    if 10 <= hue <= 35 and sat >= 100:
        return "Legendary"
    if 10 <= hue <= 35 and 35 <= sat < 100:
        return "Unique"

    median_rgb = np.median(rgb[mask], axis=0)
    targets = {
        "Artifact": np.array([255, 0, 0]),
        "Uncommon": np.array([128, 214, 0]),
        "Rare": np.array([0, 170, 238]),
        "Epic": np.array([208, 103, 255]),
        "Legendary": np.array([255, 154, 0]),
        "Unique": np.array([236, 217, 154]),
    }

    best_rarity = None
    best_distance = float("inf")

    for rarity, target_rgb in targets.items():
        distance = float(np.linalg.norm(median_rgb - target_rgb))
        if distance < best_distance:
            best_distance = distance
            best_rarity = rarity

    if best_distance <= 90:
        return best_rarity

    return None


if __name__ == "__main__":
    initialize()
    app.run(host="127.0.0.1", port=PORT, threaded=False)
