import electron from 'electron';
import { join } from 'node:path';
import { RESOURCES, ROOT, SOURCE } from './config.js';
import { logger } from './logger.js';
import { createRequire } from 'module';
import { existsSync } from 'node:fs';

const { app } = electron;

logger.info ('Loading native screen module');

// %APPDATA%/../Local/Programs/GrimVault/resources/app.asar/src

// GrimVault needs several DLLs to load. 
// The necessary DLLs are added to resources/dlls when the app is packaged.
process.env.PATH = `${join (RESOURCES, 'dlls')};${process.env.PATH}`;

let nativeModulePath;

if (app.isPackaged) {
  nativeModulePath = join (RESOURCES, 'native.node');
} else {
  nativeModulePath = join (SOURCE, 'native', '.build', 'native.node');
}

let native = null;
let nativeAvailable = false;

if (existsSync (nativeModulePath)) {
  try {
    native = createRequire (import.meta.url) (nativeModulePath);
    nativeAvailable = true;
  } catch (error) {
    logger.warn (`Native screen module could not be loaded: ${error.message}`);
  }
} else {
  logger.warn (`Native screen module does not exist: ${nativeModulePath}`);
}

let ocrModelPath;
let ocrDictPath;
let onnxModelPath;
let debugPath;

if (app.isPackaged) {
  ocrModelPath = join (ROOT, '..', 'models', 'paddleocr', 'latin_PP-OCRv5_mobile_rec.onnx');
  ocrDictPath = join (ROOT, '..', 'models', 'paddleocr', 'latin_pp_ocrv5_dict.txt');
  onnxModelPath = join (ROOT, '..', 'models', 'tooltip.onnx');
  debugPath = join (ROOT, '..', 'debug');
} else {
  ocrModelPath = join (ROOT, 'models', 'paddleocr', 'latin_PP-OCRv5_mobile_rec.onnx');
  ocrDictPath = join (ROOT, 'models', 'paddleocr', 'latin_pp_ocrv5_dict.txt');
  onnxModelPath = join (ROOT, 'models', 'tooltip.onnx');
  debugPath = join (ROOT, 'debug');
}

let onMessageCallback = (level, message) => {
  logger [level] (`[Native] ${message}`);
};

logger.info (`Initializing native screen module`);

let success = false;

if (nativeAvailable) {
  success = native.initialize (
    ocrModelPath,
    ocrDictPath,
    onnxModelPath,
    onMessageCallback,
    debugPath
  );

  if (!success) {
    logger.warn ('Failed to initialize native screen module; Korean OCR fallback remains available');
    nativeAvailable = false;
  }
}

let getTooltip = nativeAvailable
  ? native.getTooltip
  : async () => null;

let getActiveWindow = nativeAvailable
  ? native.getActiveWindow
  : async () => null;

let getGameWindow = nativeAvailable
  ? native.getGameWindow
  : async () => null;

let startWindowHooks = nativeAvailable
  ? native.startWindowHooks
  : () => false;

let stopWindowHooks = nativeAvailable
  ? native.stopWindowHooks
  : () => {};

function isNativeAvailable () {
  return nativeAvailable;
}

export {
  getTooltip,
  getActiveWindow,
  getGameWindow,
  startWindowHooks,
  stopWindowHooks,
  isNativeAvailable
};
