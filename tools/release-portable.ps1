param (
  [Parameter(Mandatory = $true)]
  [string] $Version,
  [string] $Repository = 'blackpen55/GrimVault-KR',
  [string] $Target = 'master'
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$unpacked = Join-Path $root 'dist\win-unpacked'
$zip = Join-Path $root "dist\GrimVault-KR-portable-$Version.zip"
$tag = "v$Version"

$required = @(
  'GrimVault-KR.exe',
  'resources\korean\ocr-service\ocr-service.exe',
  'resources\models\tooltip.onnx',
  'resources\korean\mapping\items.json',
  'resources\korean\mapping\attributes.json'
)

foreach ($relativePath in $required) {
  $path = Join-Path $unpacked $relativePath
  if (-not (Test-Path -LiteralPath $path)) {
    throw "Missing portable resource: $relativePath"
  }
}

if (Test-Path -LiteralPath $zip) {
  Remove-Item -LiteralPath $zip -Force
}

Compress-Archive -Path (Join-Path $unpacked '*') -DestinationPath $zip -CompressionLevel Optimal

$archive = [System.IO.Compression.ZipFile]::OpenRead($zip)
try {
  $entries = @($archive.Entries | ForEach-Object { $_.FullName.Replace('/', '\') })
  foreach ($relativePath in $required) {
    if ($entries -notcontains $relativePath) {
      throw "ZIP validation failed: $relativePath"
    }
  }
} finally {
  $archive.Dispose()
}

$hash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash
$size = (Get-Item -LiteralPath $zip).Length
$notes = @"
GrimVault-KR $Version portable build

Local build commit: $(git -C $root rev-parse HEAD)
SHA256: $hash
"@

gh release create $tag $zip --repo $Repository --target $Target --title "GrimVault-KR $Version" --notes $notes --latest
if ($LASTEXITCODE -ne 0) {
  throw 'GitHub Release upload failed'
}

$url = gh release view $tag --repo $Repository --json url --jq .url
if ($LASTEXITCODE -ne 0) {
  throw 'GitHub Release URL lookup failed'
}

"version=$Version"
"zip_size=$size"
"sha256=$hash"
"release_url=$url"
