/**
 * Korean OCR bridge.
 *
 * Starts a local Python service that reads Korean Dark and Darker tooltips,
 * translates them back to English text for DarkerDB, and returns Korean display
 * metadata for the overlay.
 */

import electron from 'electron';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import axios from 'axios';
import { logger } from '../logger.js';
import { RESOURCES, ROOT } from '../config.js';

const { app } = electron;

const OCR_PORT = 19529;
const OCR_URL = `http://127.0.0.1:${OCR_PORT}`;

let ocrProcess = null;

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

  if (existsSync (ocrExe)) {
    cmd = ocrExe;
    args = [];
    logger.info (`[Korean] Starting OCR service executable: ${cmd}`);
  } else if (existsSync (serverScript)) {
    const venvPython = join (ROOT, 'ocr_env', 'Scripts', 'python.exe');
    cmd = existsSync (venvPython) ? venvPython : pythonPath;
    args = [ serverScript ];
    logger.info (`[Korean] Starting OCR service: ${cmd} ${serverScript}`);
  } else {
    logger.warn (`[Korean] OCR service not found at ${serverScript}`);
    return;
  }

  try {
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
      if (msg && !msg.includes ('UserWarning') && !msg.includes ('FutureWarning')) {
        logger.warn (`[Korean OCR] ${msg}`);
      }
    });

    ocrProcess.on ('close', (code) => {
      logger.info (`[Korean] OCR service exited with code ${code}`);
      ocrProcess = null;
    });

    ocrProcess.on ('error', (err) => {
      logger.error (`[Korean] Failed to start OCR service: ${err.message}`);
      ocrProcess = null;
    });
  } catch (e) {
    logger.error (`[Korean] Error spawning OCR service: ${e.message}`);
  }
}

export function stopService () {
  if (!ocrProcess) return;

  logger.info ('[Korean] Stopping OCR service');

  try {
    ocrProcess.kill ();
  } catch (e) {
    logger.warn (`[Korean] OCR service stop failed: ${e.message}`);
  }

  ocrProcess = null;
}

export async function isAvailable () {
  try {
    const response = await ocrClient.get ('/health');
    return response.data?.status === 'ok';
  } catch (e) {
    return false;
  }
}

export async function getTooltip () {
  try {
    const response = await ocrClient.post ('/scan');

    if (!response.data || !response.data.tooltip) {
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
