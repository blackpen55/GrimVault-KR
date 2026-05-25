import cv2
import numpy as np

MODEL_WIDTH = 640
MODEL_HEIGHT = 640
MINIMUM_OBJECT_CONFIDENCE = 0.90
NMS_SCORE_THRESHOLD = 0.25
NMS_THRESHOLD = 0.45


class TooltipDetector:
    def __init__(self, model_path):
        self.net = cv2.dnn.readNetFromONNX(model_path)

    def find_tooltips(self, screenshot):
        if screenshot is None or screenshot.size == 0:
            return []

        height, width = screenshot.shape[:2]
        max_side = max(width, height)
        padded = np.zeros((max_side, max_side, 3), dtype=np.uint8)
        padded[:height, :width] = screenshot

        blob = cv2.dnn.blobFromImage(
            padded,
            1 / 255.0,
            (MODEL_WIDTH, MODEL_HEIGHT),
            swapRB=True,
            crop=False,
        )

        self.net.setInput(blob)
        outputs = self.net.forward(self.net.getUnconnectedOutLayersNames())
        output = outputs[0]
        rows = output.shape[2]
        dimensions = output.shape[1]
        output = output.reshape(dimensions, rows).T

        x_scale = padded.shape[1] / MODEL_WIDTH
        y_scale = padded.shape[0] / MODEL_HEIGHT
        boxes = []
        confidences = []

        for row in output:
            score = float(np.max(row[4:]))
            if score <= MINIMUM_OBJECT_CONFIDENCE:
                continue

            x, y, w, h = row[:4]
            left = int((x - 0.5 * w) * x_scale)
            top = int((y - 0.5 * h) * y_scale)
            box_width = int(w * x_scale)
            box_height = int(h * y_scale)

            boxes.append([left, top, box_width, box_height])
            confidences.append(score)

        indexes = cv2.dnn.NMSBoxes(
            boxes,
            confidences,
            NMS_SCORE_THRESHOLD,
            NMS_THRESHOLD,
        )

        if len(indexes) == 0:
            return []

        return [boxes[int(i)] for i in np.array(indexes).flatten()]
