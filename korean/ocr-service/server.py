import json
import logging
import os
import sys
import time

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

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("grimvault-korean")

app = Flask(__name__)

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

    for x, y, width, height in boxes:
        x = max(0, int(x))
        y = max(0, int(y))
        width = min(int(width), screenshot.shape[1] - x)
        height = min(int(height), screenshot.shape[0] - y)

        if width <= 0 or height <= 0:
            continue

        region = screenshot[y:y + height, x:x + width]
        original_text = ocr.read(region)

        if not original_text:
            continue

        if _looks_like_grimvault_overlay(original_text):
            continue

        english_text = translator.translate_text(original_text)
        if not english_text:
            logger.info("OCR text had no English mapping: %s", original_text.replace("\n", " | "))
            continue

        lines = original_text.strip().split("\n")
        korean_item_name = lines[0].strip() if lines else ""
        elapsed = int((time.time() - start) * 1000)
        logger.info("Korean scan complete in %sms: %s", elapsed, english_text.replace("\n", " | "))

        return jsonify({
            "tooltip": {
                "text": english_text,
                "original_text": original_text,
                "korean_item_name": korean_item_name,
                "rarity": translator.detect_rarity(original_text),
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


if __name__ == "__main__":
    initialize()
    app.run(host="127.0.0.1", port=PORT, threaded=False)
