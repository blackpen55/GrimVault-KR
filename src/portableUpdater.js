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

const { app, BrowserWindow, ipcMain } = electron;
const execFileAsync = promisify (execFile);

const RELEASES_API = 'https://api.github.com/repos/blackpen55/GrimVault-KR/releases/latest';
const UPDATE_DIR_NAME = 'grimvault-kr-update';
const HIDE_PROGRESS_CHANNEL = 'portable-update-hide-progress';

let isUpdating = false;
let progressWindow = null;
let progressWindowHidden = false;
let closingProgressWindow = false;

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

  notify (`새 버전 ${latest.version} 사용 가능`);
  return latest;
}

export async function installPortableUpdate (notify = () => {}, latest = null) {
  if (isUpdating) {
    notify ('업데이트가 이미 진행 중입니다.');
    return;
  }

  isUpdating = true;
  progressWindowHidden = false;

  try {
    latest = latest || await checkForPortableUpdate (notify);
    if (!latest) return false;

    if (!app.isPackaged) {
      notify (`개발 실행에서는 설치를 생략합니다. 최신 버전: ${latest.version}`);
      logger.info ('Portable updater skipped install in development mode', latest);
      return false;
    }

    notify (`${latest.version} 다운로드 중...`);
    showUpdateProgress (`${latest.version} 다운로드 중...`, '잠시만 기다려주세요.');

    const updateRoot = join (app.getPath ('temp'), UPDATE_DIR_NAME);
    const versionRoot = join (updateRoot, `${latest.version}-${Date.now ()}`);
    const extractDir = join (versionRoot, 'extracted');
    const zipPath = join (versionRoot, latest.asset.name);

    mkdirSync (extractDir, { recursive: true });

    let lastProgressPercent = -1;
    let lastProgressUpdate = 0;

    await downloadFile (latest.asset.browser_download_url, zipPath, (progress) => {
      const now = Date.now ();
      if (progress.percent === lastProgressPercent && now - lastProgressUpdate < 1000) return;

      lastProgressPercent = progress.percent;
      lastProgressUpdate = now;

      showUpdateProgress (
        `${latest.version} 다운로드 중...`,
        `${progress.percent}% (${formatBytes (progress.downloaded)} / ${formatBytes (progress.total)})`
      );
    });
    showUpdateProgress ('업데이트 파일 검증 중...', '다운로드한 파일을 확인하고 있습니다.');
    await verifyDigest (zipPath, latest.asset.digest);
    showUpdateProgress ('압축 해제 중...', '업데이트 파일을 준비하고 있습니다.');
    await extractZip (zipPath, extractDir);
    showUpdateProgress ('업데이트 파일 확인 중...', '필수 파일이 모두 있는지 확인하고 있습니다.');
    verifyPortableTree (extractDir);

    notify ('업데이트 설치를 준비합니다...');
    showUpdateProgress ('업데이트 설치 준비 완료', '앱을 재시작하고 새 버전으로 교체합니다.');
    launchInstallHelper (versionRoot, extractDir, latest.version);
    return true;
  } catch (error) {
    logger.error ('Portable update failed:', error);
    closeUpdateProgress ();
    notify (`업데이트 실패: ${error.message}`);
    return false;
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

async function downloadFile (url, destination, onProgress = null) {
  const response = await fetch (url);

  if (!response.ok) {
    throw new Error (`업데이트 다운로드 실패: ${response.status}`);
  }

  const total = Number (response.headers.get ('content-length')) || 0;
  let downloaded = 0;
  const progressStream = new TransformStream ({
    transform (chunk, controller) {
      downloaded += chunk.byteLength;

      if (onProgress) {
        onProgress ({
          downloaded,
          total,
          percent: total ? Math.floor ((downloaded / total) * 100) : 0
        });
      }

      controller.enqueue (chunk);
    }
  });

  await pipeline (
    Readable.fromWeb (response.body.pipeThrough (progressStream)),
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
      '& { param($zipPath, $destinationPath) Expand-Archive -LiteralPath $zipPath -DestinationPath $destinationPath -Force }',
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

function launchInstallHelper (workDir, sourceDir, version) {
  closeUpdateProgress ();

  const targetDir = dirname (process.execPath);
  const helperPath = join (app.getPath ('temp'), UPDATE_DIR_NAME, `install-${version}.ps1`);
  const launcherPath = join (app.getPath ('temp'), UPDATE_DIR_NAME, `launch-${version}.cmd`);
  const logPath = join (app.getPath ('temp'), UPDATE_DIR_NAME, `install-${version}.log`);

  writeFileSync (helperPath, getInstallHelperScript ({
    processId: process.pid,
    updateRoot: join (app.getPath ('temp'), UPDATE_DIR_NAME),
    workDir,
    sourceDir,
    targetDir,
    exePath: process.execPath,
    logPath
  }), 'utf8');
  writeFileSync (launcherPath, `@echo off\r\nstart "" /min powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${helperPath}"\r\n`, 'utf8');
  writeFileSync (logPath, `${new Date ().toISOString ()} Launching portable update helper\n`, 'utf8');

  const child = spawn (
    'cmd.exe',
    [
      '/d',
      '/c',
      launcherPath
    ],
    {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    }
  );

  child.on ('error', (error) => {
    logger.error ('Portable update helper launch failed:', error);
  });

  child.unref ();
  logger.info (`Portable update helper launched for ${version}: ${logPath}`);
  app.quit ();

  const forceExitTimer = setTimeout (() => {
    logger.warn ('Forcing app exit for portable update');
    app.exit (0);
  }, 1500);
  forceExitTimer.unref?.();
}

function showUpdateProgress (title, detail) {
  if (progressWindowHidden) return;

  if (!progressWindow || progressWindow.isDestroyed ()) {
    progressWindow = new BrowserWindow ({
      width: 420,
      height: 150,
      frame: false,
      resizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        sandbox: false
      }
    });
    progressWindow.setAlwaysOnTop (true, 'screen-saver');
    progressWindow.on ('close', (event) => {
      if (!closingProgressWindow && !progressWindowHidden) {
        event.preventDefault ();
        hideUpdateProgressWindow ();
      }
    });
    progressWindow.on ('closed', () => { progressWindow = null; });
    progressWindow.webContents.on ('before-input-event', (event, input) => {
      if (input.key === 'Escape') {
        hideUpdateProgressWindow ();
      }
    });
  }

  const body = encodeURIComponent (`
    <meta charset="utf-8">
    <style>
      body{margin:0;padding:18px 20px;color:#fff;background:#202124;border:1px solid #5f6368;font:15px sans-serif}
      b{display:block;margin-bottom:10px;font-size:16px}
      p{margin:0 0 12px 0;line-height:1.45}
      button{position:absolute;right:12px;top:10px;border:1px solid #5f6368;border-radius:6px;background:#2b2c2f;color:#f1f3f4;padding:5px 10px;font:12px sans-serif;cursor:pointer}
      button:hover{background:#3c4043}
      .bar{height:8px;background:#3c4043;border-radius:999px;overflow:hidden}
      .fill{height:100%;width:100%;background:#8ab4f8;animation:pulse 1.2s ease-in-out infinite}
      @keyframes pulse{0%{opacity:.45}50%{opacity:1}100%{opacity:.45}}
    </style>
    <button onclick="hideProgress()">숨기기</button>
    <b>${escapeHtml (title)}</b>
    <p>${escapeHtml (detail)}</p>
    <div class="bar"><div class="fill"></div></div>
    <script>
      const { ipcRenderer } = require('electron');
      function hideProgress() {
        ipcRenderer.send('${HIDE_PROGRESS_CHANNEL}');
      }
    </script>
  `);

  ipcMain.removeAllListeners (HIDE_PROGRESS_CHANNEL);
  ipcMain.once (HIDE_PROGRESS_CHANNEL, () => {
    hideUpdateProgressWindow ();
  });

  if (progressWindowHidden) return;
  progressWindow.loadURL (`data:text/html;charset=utf-8,${body}`);
  if (progressWindowHidden) return;
  progressWindow.showInactive ();
}

function hideUpdateProgressWindow () {
  progressWindowHidden = true;
  if (progressWindow && !progressWindow.isDestroyed ()) {
    progressWindow.hide ();
  }
}

function closeUpdateProgress () {
  ipcMain.removeAllListeners (HIDE_PROGRESS_CHANNEL);
  if (progressWindow && !progressWindow.isDestroyed ()) {
    closingProgressWindow = true;
    progressWindow.close ();
  }
  progressWindow = null;
  closingProgressWindow = false;
}

function formatBytes (bytes) {
  if (!bytes) return '?';
  const mb = bytes / 1024 / 1024;
  return `${mb.toFixed (1)} MB`;
}

function escapeHtml (value) {
  return String (value)
    .replace (/&/g, '&amp;')
    .replace (/</g, '&lt;')
    .replace (/>/g, '&gt;')
    .replace (/"/g, '&quot;')
    .replace (/'/g, '&#39;');
}

function getInstallHelperScript ({ processId, updateRoot, workDir, sourceDir, targetDir, exePath, logPath }) {
  return `
$ErrorActionPreference = 'Stop'

$ProcessIdToWait = ${Number (processId)}
$UpdateRoot = ${toPowerShellString (updateRoot)}
$WorkDir = ${toPowerShellString (workDir)}
$SourceDir = ${toPowerShellString (sourceDir)}
$TargetDir = ${toPowerShellString (targetDir)}
$ExePath = ${toPowerShellString (exePath)}
$LogPath = ${toPowerShellString (logPath)}

function Write-UpdateLog($Message) {
  $timestamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
  Add-Content -LiteralPath $LogPath -Value "$timestamp $Message"
}

try {
  Write-UpdateLog "Waiting for GrimVault-KR process $ProcessIdToWait"
  Wait-Process -Id $ProcessIdToWait -Timeout 60 -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 1

  $deadline = (Get-Date).AddSeconds(60)
  do {
    $running = Get-Process -Name 'GrimVault-KR' -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $ExePath }
    if (-not $running) {
      break
    }
    Start-Sleep -Seconds 1
  } while ((Get-Date) -lt $deadline)

  $running = Get-Process -Name 'GrimVault-KR' -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $ExePath }
  if ($running) {
    Write-UpdateLog "Forcing remaining GrimVault-KR processes to stop"
    $running | Stop-Process -Force
    Start-Sleep -Seconds 1
  }

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

  $resolvedUpdateRoot = [System.IO.Path]::GetFullPath($UpdateRoot)
  $resolvedWorkDir = [System.IO.Path]::GetFullPath($WorkDir)
  $expectedPrefix = $resolvedUpdateRoot.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
  $workParent = [System.IO.Directory]::GetParent($resolvedWorkDir)

  if ($workParent -and
      $workParent.FullName -eq $resolvedUpdateRoot -and
      $resolvedWorkDir.StartsWith($expectedPrefix, [System.StringComparison]::OrdinalIgnoreCase) -and
      (Test-Path -LiteralPath $resolvedWorkDir)) {
    Write-UpdateLog "Cleaning update temp folder $WorkDir"
    Remove-Item -LiteralPath $resolvedWorkDir -Recurse -Force -ErrorAction SilentlyContinue
  } else {
    Write-UpdateLog "Skipped cleanup because work folder is outside update temp root: $WorkDir"
  }
} catch {
  Write-UpdateLog "Update failed: $($_.Exception.Message)"
}
`;
}

function toPowerShellString (value) {
  return `'${String (value).replace (/'/g, "''")}'`;
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
