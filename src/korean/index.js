/**
 * Korean OCR bridge.
 *
 * Starts a local Python service that reads Korean Dark and Darker tooltips,
 * translates them back to English text for DarkerDB, and returns Korean display
 * metadata for the overlay.
 */

import electron from 'electron';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import axios from 'axios';
import { logger } from '../logger.js';
import { RESOURCES, ROOT } from '../config.js';

const { app } = electron;

const OCR_PORT = 19529;
const OCR_URL = `http://127.0.0.1:${OCR_PORT}`;

let ocrProcess = null;
let lastServiceError = '';
let lastServiceStderr = '';
let lastAvailabilityCheck = { available: false, timestamp: 0 };
const AVAILABILITY_TTL_MS = 5000;

const ocrClient = axios.create ({
  baseURL: OCR_URL,
  timeout: 30000,
});

export function startService (pythonPath = 'python') {
  if (ocrProcess) {
    logger.info ('[Korean] OCR service already running');
    return;
  }

  const koreanDir = app.isPackaged
    ? join (RESOURCES, 'korean')
    : join (ROOT, 'korean');

  const modelsDir = app.isPackaged
    ? join (RESOURCES, 'models')
    : join (ROOT, 'models');
  const tooltipModelPath = resolveTooltipModelPath (modelsDir);

  const mappingDir = join (koreanDir, 'mapping');
  const ocrExe = join (koreanDir, 'ocr-service', 'ocr-service.exe');
  const serverScript = join (koreanDir, 'ocr-service', 'server.py');

  const env = { ...process.env };
  env.GRIMVAULT_TOOLTIP_MODEL = tooltipModelPath;
  env.GRIMVAULT_MAPPING_DIR = mappingDir;
  env.GRIMVAULT_OCR_PORT = String (OCR_PORT);

  let cmd;
  let args;

  if (!app.isPackaged && existsSync (serverScript)) {
    const venvPython = join (ROOT, 'ocr_env', 'Scripts', 'python.exe');
    cmd = existsSync (venvPython) ? venvPython : pythonPath;
    args = [ serverScript ];
    logger.info (`[Korean] Starting OCR service: ${cmd} ${serverScript}`);
  } else if (existsSync (ocrExe)) {
    cmd = ocrExe;
    args = [];
    logger.info (`[Korean] Starting OCR service executable: ${cmd}`);
  } else {
    lastServiceError = `OCR service executable not found: ${ocrExe}`;
    logger.warn (`[Korean] ${lastServiceError}`);
    return;
  }

  try {
    lastServiceError = '';
    lastServiceStderr = '';
    lastAvailabilityCheck = { available: false, timestamp: 0 };
    ocrProcess = spawn (cmd, args, {
      env,
      stdio: [ 'pipe', 'pipe', 'pipe' ],
      detached: false,
    });

    ocrProcess.stdout.on ('data', (data) => {
      const msg = data.toString ().trim ();
      if (msg) logger.info (`[Korean OCR] ${msg}`);
    });

    ocrProcess.stderr.on ('data', (data) => {
      const msg = data.toString ().trim ();
      if (msg) {
        lastServiceStderr = `${lastServiceStderr}\n${msg}`.slice (-4000);
      }

      if (msg && !msg.includes ('UserWarning') && !msg.includes ('FutureWarning')) {
        logger.warn (`[Korean OCR] ${msg}`);
      }
    });

    ocrProcess.on ('close', (code) => {
      logger.info (`[Korean] OCR service exited with code ${code}`);
      if (code !== null && code !== 0) {
        lastServiceError = describeServiceFailure (code, lastServiceStderr);
      }
      ocrProcess = null;
    });

    ocrProcess.on ('error', (err) => {
      lastServiceError = err.message;
      logger.error (`[Korean] Failed to start OCR service: ${err.message}`);
      ocrProcess = null;
    });
  } catch (e) {
    lastServiceError = e.message;
    logger.error (`[Korean] Error spawning OCR service: ${e.message}`);
  }
}

export function stopService () {
  if (!ocrProcess) return;

  logger.info ('[Korean] Stopping OCR service');

  try {
    if (process.platform === 'win32' && ocrProcess.pid) {
      spawnSync ('taskkill.exe', [ '/pid', String (ocrProcess.pid), '/t', '/f' ], {
        windowsHide: true,
        stdio: 'ignore'
      });
    } else {
      ocrProcess.kill ();
    }
  } catch (e) {
    logger.warn (`[Korean] OCR service stop failed: ${e.message}`);
  }

  ocrProcess = null;
  lastAvailabilityCheck = { available: false, timestamp: Date.now () };
}

export async function isAvailable (force = false) {
  if (!force && (Date.now () - lastAvailabilityCheck.timestamp) < AVAILABILITY_TTL_MS) {
    return lastAvailabilityCheck.available;
  }

  try {
    const response = await ocrClient.get ('/health');
    const available = response.data?.status === 'ok';
    lastAvailabilityCheck = { available, timestamp: Date.now () };
    return available;
  } catch (e) {
    lastAvailabilityCheck = { available: false, timestamp: Date.now () };
    return false;
  }
}

export async function getStatus () {
  if (await isAvailable ()) {
    return { available: true, message: '' };
  }

  if (ocrProcess) {
    return {
      available: false,
      starting: true,
      message: '한국어 OCR 서비스를 시작하는 중입니다. 잠시 후 다시 F5를 눌러 주세요.'
    };
  }

  return {
    available: false,
    message: lastServiceError
      ? `한국어 OCR 서비스를 실행하지 못했습니다: ${lastServiceError}`
      : '한국어 OCR 서비스를 사용할 수 없습니다. 앱을 다시 실행해 주세요.'
  };
}

export async function getTooltip () {
  try {
    const response = await ocrClient.post ('/scan');
    lastAvailabilityCheck = { available: true, timestamp: Date.now () };

    if (!response.data || !response.data.tooltip) {
      if (response.data?.error) {
        return { error: response.data.error };
      }

      return null;
    }

    const tooltip = response.data.tooltip;

    if (tooltip.unmapped_terms?.length) {
      logger.info (`[Korean] ${tooltip.unmapped_terms.length} unmapped terms found`);
    }

    return {
      text: tooltip.text,
      error: tooltip.error || '',
      original_text: tooltip.original_text || '',
      korean_item_name: tooltip.korean_item_name || '',
      rarity: tooltip.rarity || 'Common',
      display_lines: tooltip.display_lines || [],
      reverse_attributes: tooltip.reverse_attributes || {},
      reverse_keywords: tooltip.reverse_keywords || {},
      unmapped_terms: tooltip.unmapped_terms || [],
      game_bounds: tooltip.game_bounds || null,
      x: tooltip.x,
      y: tooltip.y,
      width: tooltip.width,
      height: tooltip.height,
    };
  } catch (e) {
    lastAvailabilityCheck = { available: false, timestamp: Date.now () };
    logger.warn (`[Korean] OCR scan unavailable: ${e.message}`);
    return null;
  }
}

export async function getMappings () {
  try {
    const response = await ocrClient.get ('/mapping/list');
    return response.data;
  } catch (e) {
    return { error: e.message };
  }
}

export async function addMapping (korean, english) {
  try {
    const response = await ocrClient.post ('/mapping/add', { korean, english });
    return response.data;
  } catch (e) {
    return { error: e.message };
  }
}

export async function removeMapping (korean) {
  try {
    const response = await ocrClient.post ('/mapping/remove', { korean });
    return response.data;
  } catch (e) {
    return { error: e.message };
  }
}

function resolveTooltipModelPath (modelsDir) {
  const candidates = [
    join (modelsDir, 'tooltip.onnx'),
    join (modelsDir, 'vision', 'runs', 'detect', 'train', 'weights', 'best.onnx'),
  ];

  return candidates.find (candidate => existsSync (candidate)) || candidates [0];
}

function describeServiceFailure (code, stderr) {
  const cleanStderr = stderr
    .replace (/\u001b\[[0-9;]*m/g, '')
    .trim ();

  if (/Address already in use|Port 19529 is in use|Only one usage of each socket address/i.test (cleanStderr)) {
    return 'OCR 포트 19529를 다른 프로세스가 사용 중입니다. 실행 중인 GrimVault-KR을 모두 종료한 뒤 다시 실행해 주세요.';
  }

  if (/Tooltip model not found/i.test (cleanStderr)) {
    return 'tooltip.onnx 모델 파일을 찾지 못했습니다. ZIP을 새 폴더에 다시 압축 해제해 주세요.';
  }

  if (/rapidocr is required|DLL load failed|ImportError|ModuleNotFoundError/i.test (cleanStderr)) {
    return 'OCR 런타임을 불러오지 못했습니다. ZIP을 새 폴더에 다시 압축 해제한 뒤 다시 실행해 주세요.';
  }

  const detail = cleanStderr
    .split (/\r?\n/)
    .map (line => line.trim ())
    .filter (line => line && !line.startsWith ('*'))
    .at (-1);

  return detail
    ? `OCR service exited with code ${code}: ${detail}`
    : `OCR service exited with code ${code}`;
}
