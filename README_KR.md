# GrimVault-KR

GrimVault-KR은 한국어 Dark and Darker 클라이언트의 아이템 툴팁을 읽어 DarkerDB 가격/아이템 정보를 오버레이로 보여주기 위한 한국어판 작업입니다.

## 핵심 구조

기존 GrimVault의 Windows native 캡처, 툴팁 탐지, 오버레이, DarkerDB API 호출 구조는 유지합니다. 한국어판은 그 앞에 얇은 한국어 입력 변환 계층을 추가합니다.

```text
한국어 게임 툴팁
-> korean/ocr-service 로컬 OCR
-> korean/mapping JSON으로 영어 tooltip 복원
-> DarkerDB API 호출
-> 한국어 오버레이 표시
```

한국어 OCR 서비스가 시작되지 않거나 결과를 만들지 못하면 기존 native OCR 경로로 fallback합니다.

## 한국어 매핑 데이터

한국어 tooltip을 DarkerDB API가 읽을 수 있는 영어 tooltip으로 바꾸기 위해 로컬 JSON 매핑을 사용합니다.

- `korean/mapping/items.json`: 한국어 아이템명 -> 영어 아이템명
- `korean/mapping/attributes.json`: 한국어 옵션명 -> 영어 옵션명
- `korean/mapping/keywords.json`: 희귀도, 상인명, 공통 라벨
- `korean/mapping/custom.json`: 사용자가 추가하는 보정 매핑

초기 파일은 흐름 검증용 seed 데이터입니다. 실제 사용 범위를 넓히려면 OCR 로그의 `unmapped_terms`를 보면서 매핑을 계속 보강해야 합니다.

## 개발 실행

1. Node 의존성을 설치합니다.

```powershell
npm install
```

2. Python OCR 의존성을 설치합니다.

```powershell
python -m pip install -r korean/ocr-service/requirements.txt
```

3. 모델 파일을 준비합니다.

GrimVault의 툴팁 탐지 모델인 `tooltip.onnx`가 필요합니다. 개발 환경에서는 아래 위치 중 하나에 둡니다.

```text
models/tooltip.onnx
models/vision/runs/detect/train/weights/best.onnx
```

4. 앱을 실행합니다.

```powershell
npm run dev
```

## 설정

`settings.ini`의 기본값은 한국어판 기준으로 보수적으로 설정되어 있습니다.

- `telemetry = false`
- `auto_updates = false`
- `launch_on_startup = false`
- `default_mode = manual`
- `python_path = python`

패키징된 빌드에 `korean/ocr-service/ocr-service.exe`를 포함하면 Python 설치 없이도 한국어 OCR 서비스를 실행할 수 있습니다.

## 구현 원칙

- 한국어 OCR은 기존 native OCR을 대체하지 않습니다.
- 한국어 OCR/매핑이 실패하면 기존 GrimVault 기능으로 fallback합니다.
- DarkerDB API에는 한국어 원문이 아니라 영어로 복원된 tooltip을 보냅니다.
- 한국어 데이터는 처음부터 거대한 사이트로 관리하지 않고, 로컬 JSON과 미매핑 로그로 점진적으로 보강합니다.
