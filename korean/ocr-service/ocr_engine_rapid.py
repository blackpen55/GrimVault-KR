class KoreanOCR:
    def __init__(self):
        try:
            from rapidocr import RapidOCR
            from rapidocr.utils.typings import LangRec, ModelType, OCRVersion
        except ImportError as exc:
            try:
                from rapidocr_onnxruntime import RapidOCR
            except ImportError:
                raise RuntimeError(
                    "rapidocr is required. Install korean/ocr-service/requirements.txt."
                ) from exc

            self.engine = RapidOCR()
            self.output_style = "legacy"
            return

        self.engine = RapidOCR(params={
            "Global.log_level": "warning",
            "Rec.lang_type": LangRec.KOREAN,
            "Rec.ocr_version": OCRVersion.PPOCRV5,
            "Rec.model_type": ModelType.MOBILE,
        })
        self.output_style = "rapidocr3"

    def read(self, image):
        result = self.engine(image)

        if self.output_style == "rapidocr3":
            return "\n".join(line.strip() for line in result.txts if line.strip())

        result, _ = result

        if not result:
            return ""

        lines = []
        for item in result:
            if len(item) >= 2 and item[1]:
                lines.append(str(item[1]).strip())

        return "\n".join(line for line in lines if line)
