# GrimVault-KR Project Instructions

## Engineering

- Keep changes surgical, simple, and verified.
- Do not push commits until the user explicitly requests a push.
- Do not create, replace, or delete GitHub Releases until the user explicitly requests it.
- Preserve previous Releases unless the user explicitly requests deletion.
- Preserve required OCR models, mapping files, and packaged resources.
- Do not generate substitute resources when required files are missing.

## Release Cost Control

- Avoid repeated large GitHub Release asset uploads through interactive Codex tool calls.
- Avoid frequent polling while a large upload is running.
- Prefer one low-output release automation command for build, ZIP validation, and upload.
- Keep release automation output concise: status, version, ZIP size, SHA256, and Release URL.
- Prefer a reusable script at `tools/release-portable.ps1`.
- Ask before uploading or replacing a GitHub Release asset.

## Portable Release Requirements

- Publish a new versioned Release instead of overwriting the previous portable ZIP.
- Keep older portable ZIP downloads available.
- Mark the newly published version as `latest` only after validation succeeds.
- Use `0.1.x` for official Releases.
- Use `0.1.x.y` for private feature builds based on official `0.1.x`.
- Increment `y` for each private feature build. Reset `y` when official `x` changes.
- Keep `src/version.js` synchronized with the build version shown by the F1 shortcut.
- Portable ZIP must include:
  - `GrimVault-KR.exe`
  - `resources/korean/ocr-service/ocr-service.exe`
  - `resources/models/tooltip.onnx`
  - `resources/korean/mapping/items.json`
  - `resources/korean/mapping/attributes.json`
- Verify Korean OCR `/health` before upload when practical.
