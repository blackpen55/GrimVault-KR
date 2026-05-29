# Security Notes

## Network

GrimVault-KR sends translated tooltip data to the DarkerDB API for price lookup. Korean OCR runs locally.

The Korean OCR service binds to `127.0.0.1`, not to a public network interface. The local auth callback server listens on `localhost:7777` only while the app is running.

## Privacy

The app no longer includes a machine identifier in the DarkerDB `User-Agent` header and no longer writes the machine identifier to the local app log.

## Release Risk

The current portable Windows build is unsigned, so Windows SmartScreen or antivirus tools may warn users on first launch.

`npm audit --omit=dev` reports zero production dependency vulnerabilities. The full audit still reports Electron-related advisories that require a major Electron upgrade and separate regression testing.
