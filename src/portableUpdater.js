import electron from 'electron';
import { createHash } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { logger } from './logger.js';
import { DISPLAY_VERSION } from './version.js';

const { app } = electron;
const execFileAsync = promisify (execFile);

const RELEASES_API = 'https://api.github.com/repos/blackpen55/GrimVault-KR/releases/latest';
const UPDATE_DIR_NAME = 'grimvault-kr-update';

let isUpdating = false;

export async function checkForPortableUpdate (notify = () => {}) {
  const latest = await getLatestPortableRelease ();

  if (!latest) {
    notify ('업데이트 정보를 찾지 못했습니다.');
    return null;
  }

  if (compareVersions (latest.version, DISPLAY_VERSION) <= 0) {
    notify (`이미 최신 버전입니다. (${DISPLAY_VERSION})`);
    return null;
  }

  notify (`새 버전 ${latest.version} 사용 가능 (${latest.asset.download_count || 0} downloads)`);
  return latest;
}

export async function installPortableUpdate (notify = () => {}) {
  if (isUpdating) {
    notify ('업데이트가 이미 진행 중입니다.');
    return;
  }

  isUpdating = true;

  try {
    const latest = await checkForPortableUpdate (notify);
    if (!latest) return;

    if (!app.isPackaged) {
      notify (`개발 실행에서는 설치를 생략합니다. 최신 버전: ${latest.version}`);
      logger.info ('Portable updater skipped install in development mode', latest);
      return;
    }

    notify (`${latest.version} 다운로드 중...`);

    const updateRoot = join (app.getPath ('temp'), UPDATE_DIR_NAME);
    const versionRoot = join (updateRoot, latest.version);
    const extractDir = join (versionRoot, 'extracted');
    const zipPath = join (versionRoot, latest.asset.name);

    rmSync (versionRoot, { recursive: true, force: true });
    mkdirSync (extractDir, { recursive: true });

    await downloadFile (latest.asset.browser_download_url, zipPath);
    await verifyDigest (zipPath, latest.asset.digest);
    await extractZip (zipPath, extractDir);
    verifyPortableTree (extractDir);

    notify ('업데이트 설치를 준비합니다...');
    launchInstallHelper (extractDir, latest.version);
  } catch (error) {
    logger.error ('Portable update failed:', error);
    notify (`업데이트 실패: ${error.message}`);
  } finally {
    isUpdating = false;
  }
}

async function getLatestPortableRelease () {
  const response = await fetch (RELEASES_API, {
    headers: {
      Accept: 'application/vnd.github+json'
    }
  });

  if (!response.ok) {
    throw new Error (`GitHub 릴리스 확인 실패: ${response.status}`);
  }

  const release = await response.json ();
  const version = String (release.tag_name || '').replace (/^v/i, '');
  const asset = (release.assets || []).find ((candidate) => {
    return candidate.name === `GrimVault-KR-portable-${version}.zip`;
  }) || (release.assets || []).find ((candidate) => {
    return /^GrimVault-KR-portable-.*\.zip$/i.test (candidate.name);
  });

  if (!version || !asset?.browser_download_url) return null;

  return {
    version,
    releaseUrl: release.html_url,
    asset
  };
}

async function downloadFile (url, destination) {
  const response = await fetch (url);

  if (!response.ok) {
    throw new Error (`업데이트 다운로드 실패: ${response.status}`);
  }

  await pipeline (
    Readable.fromWeb (response.body),
    createWriteStream (destination)
  );
}

async function verifyDigest (filePath, digest) {
  if (!digest || !digest.startsWith ('sha256:')) return;

  const expected = digest.slice ('sha256:'.length).toLowerCase ();
  const actual = await sha256 (filePath);

  if (actual !== expected) {
    throw new Error ('다운로드 파일 검증 실패');
  }
}

function sha256 (filePath) {
  return new Promise ((resolve, reject) => {
    const hash = createHash ('sha256');
    const stream = createReadStream (filePath);

    stream.on ('data', (chunk) => hash.update (chunk));
    stream.on ('error', reject);
    stream.on ('end', () => resolve (hash.digest ('hex')));
  });
}

async function extractZip (zipPath, destination) {
  await execFileAsync (
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      'Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force',
      zipPath,
      destination
    ],
    {
      windowsHide: true,
      timeout: 10 * 60 * 1000
    }
  );
}

function verifyPortableTree (directory) {
  const required = [
    'GrimVault-KR.exe',
    'resources\\app.asar',
    'resources\\korean\\ocr-service\\ocr-service.exe',
    'resources\\models\\tooltip.onnx',
    'resources\\korean\\mapping\\items.json',
    'resources\\korean\\mapping\\attributes.json'
  ];

  for (const relativePath of required) {
    if (!existsSync (join (directory, relativePath))) {
      throw new Error (`업데이트 파일 누락: ${relativePath}`);
    }
  }
}

function launchInstallHelper (sourceDir, version) {
  const targetDir = dirname (process.execPath);
  const helperPath = join (app.getPath ('temp'), UPDATE_DIR_NAME, `install-${version}.ps1`);
  const logPath = join (app.getPath ('temp'), UPDATE_DIR_NAME, `install-${version}.log`);

  writeFileSync (helperPath, getInstallHelperScript (), 'utf8');

  const child = spawn (
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      helperPath,
      String (process.pid),
      sourceDir,
      targetDir,
      process.execPath,
      logPath
    ],
    {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    }
  );

  child.unref ();
  logger.info (`Portable update helper launched for ${version}`);
  app.quit ();
}

function getInstallHelperScript () {
  return `
$ErrorActionPreference = 'Stop'

$ProcessIdToWait = [int] $args[0]
$SourceDir = $args[1]
$TargetDir = $args[2]
$ExePath = $args[3]
$LogPath = $args[4]

function Write-UpdateLog($Message) {
  $timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  Add-Content -LiteralPath $LogPath -Value "$timestamp $Message"
}

try {
  Write-UpdateLog "Waiting for GrimVault-KR process $ProcessIdToWait"
  Wait-Process -Id $ProcessIdToWait -Timeout 60 -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1

  if (-not (Test-Path -LiteralPath (Join-Path $SourceDir 'GrimVault-KR.exe'))) {
    throw "Extracted update is missing GrimVault-KR.exe"
  }

  Write-UpdateLog "Copying update from $SourceDir to $TargetDir"
  & robocopy $SourceDir $TargetDir /E /COPY:DAT /DCOPY:DAT /R:20 /W:1 /NFL /NDL /NP
  $exitCode = $LASTEXITCODE

  if ($exitCode -gt 7) {
    throw "robocopy failed with exit code $exitCode"
  }

  Write-UpdateLog "Restarting $ExePath"
  Start-Process -FilePath $ExePath -WorkingDirectory $TargetDir
  Write-UpdateLog "Update completed"
} catch {
  Write-UpdateLog "Update failed: $($_.Exception.Message)"
}
`;
}

function compareVersions (left, right) {
  const leftParts = String (left).split ('.').map ((part) => Number.parseInt (part, 10) || 0);
  const rightParts = String (right).split ('.').map ((part) => Number.parseInt (part, 10) || 0);
  const length = Math.max (leftParts.length, rightParts.length);

  for (let index = 0; index < length; index++) {
    const diff = (leftParts [index] || 0) - (rightParts [index] || 0);
    if (diff !== 0) return diff;
  }

  return 0;
}
