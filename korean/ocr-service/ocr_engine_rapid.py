class KoreanOCR:
    def __init__(self):
        try:
            from rapidocr_onnxruntime import RapidOCR
        except ImportError as exc:
            raise RuntimeError(
                "rapidocr-onnxruntime is required. Install korean/ocr-service/requirements.txt."
            ) from exc

        self.engine = RapidOCR()

    def read(self, image):
        result, _ = self.engine(image)

        if not result:
            return ""

        lines = []
        for item in result:
            if len(item) >= 2 and item[1]:
                lines.append(str(item[1]).strip())

        return "\n".join(line for line in lines if line)
