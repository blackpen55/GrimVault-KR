// import { app, BrowserWindow, ipcMain, screen } from 'electron';
import electron, { globalShortcut, Menu, nativeImage, shell, Tray } from 'electron';
import { basename, join } from 'node:path';
import { logger, logPath } from './logger.js';
import { logSystemInformation } from './util.js';
import { checkAndInstallVCRedist } from './vcredist.js';
import { ROOT, SOURCE, isDebug } from './config.js';
import { settings, settingsPath } from './settings.js';
import { pin, handleWindowEvent, setOverlayReference } from './pin.js';
import { wire } from './frontend.js';
import { authServer } from './authServer.js';
import { startWindowHooks, stopWindowHooks } from './native.js';
import { startService as startKoreanOcr, stopService as stopKoreanOcr } from './korean/index.js';
import { DISPLAY_VERSION } from './version.js';
import { showToast } from './toast.js';
import { checkForPortableUpdate, installPortableUpdate } from './portableUpdater.js';

const { app, BrowserWindow, ipcMain, screen } = electron;

let debugging = false;
let pendingPortableUpdate = null;
let portableUpdateInstalling = false;
let portableUpdateStatus = '업데이트 진행 중...';

const UPDATE_BADGE_CHECK_INTERVAL_MS = 12 * 60 * 60 * 1000;

logger.info ('Loaded settings: ', settings);

process.on ('uncaughtException', (error) => {
  logger.error ('Uncaught Exception:', error);
  logger.error (`Stack trace: ${error.stack}`);
});

process.on ('unhandledRejection', (reason, promise) => {
  logger.error(`Unhandled Promise Rejection: ${reason.toString()}`);
  logger.error(`Stack trace: ${reason.stack}`);
});

process.on ('SIGTERM', () => {
  logger.info ('Received SIGTERM. Performing graceful shutdown');
  process.exit (0);
});

process.on ('SIGINT', () => {
  logger.info ('Received SIGINT. Performing graceful shutdown');
  process.exit (0);
});

process.on ('warning', (warning) => {
  logger.warn ('Node warning:', warning);
});

process.on ('exit', () => {
  logger.info ('Process exiting');
});

app.commandLine.appendSwitch ('high-dpi-support', 1);
app.commandLine.appendSwitch ('force-device-scale-factor', 1);
app.commandLine.appendSwitch ('disable-crash-reporter');

if (settings.general.launch_on_startup) {
  logger.info ('Registering app startup on login');

  app.setLoginItemSettings ({
    openAtLogin: true,
    path: process.execPath,
    args: [
      '--processStart',
      `${basename (process.execPath)}`,
      '--process-start-args',
      "--hidden"
    ]
  });
} else {
  logger.info ('Deregistering app startup on login');

  app.setLoginItemSettings ({ 
    openAtLogin: false
  });
}

if (!app.requestSingleInstanceLock ()) {
  app.quit ();
}

app.on ('second-instance', (event, argv, cwd) => {
  logger.info ('Prevented second instance from spawning');
});

app.on ('render-process-gone', (event, webContents, details) => {
  logger.error (`Render process crashed: ${JSON.stringify (details)}`);
});

app.on ('child-process-gone', (event, details) => {
  logger.error (`Child process crashed: ${JSON.stringify (details)}`);
});

app.on ('before-quit', () => {
  logger.info ('App preparing to quit, cleaning up resources');
  globalShortcut.unregisterAll ();

  stopKoreanOcr ();

  try {
    stopWindowHooks ();
    logger.info ('Window event hooks stopped');
  } catch (error) {
    logger.error ('Error stopping window event hooks:', error);
  }
});

function showUpdateInstallPrompt (latest) {
  return new Promise ((resolve) => {
    const width = 390;
    const height = 220;
    const workArea = screen.getPrimaryDisplay ().workArea;
    const x = Math.max (workArea.x, workArea.x + workArea.width - width - 24);
    const y = Math.max (workArea.y, workArea.y + workArea.height - height - 72);
    const responseChannel = `portable-update-response-${Date.now ()}-${Math.random ().toString (16).slice (2)}`;

    let settled = false;
    let prompt = new BrowserWindow ({
      width,
      height,
      x,
      y,
      frame: false,
      resizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      backgroundColor: '#202124',
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        sandbox: false
      }
    });

    const finish = (value) => {
      if (settled) return;

      settled = true;
      ipcMain.removeAllListeners (responseChannel);
      if (prompt && !prompt.isDestroyed ()) prompt.close ();
      prompt = null;
      resolve (value);
    };

    ipcMain.once (responseChannel, (event, value) => {
      finish (value === 'install');
    });

    prompt.on ('closed', () => {
      finish (false);
    });

    prompt.setAlwaysOnTop (true, 'screen-saver');
    prompt.loadURL (`data:text/html;charset=utf-8,${encodeURIComponent (getUpdatePromptHtml (latest, responseChannel))}`);
    prompt.once ('ready-to-show', () => {
      if (prompt && !prompt.isDestroyed ()) prompt.showInactive ();
    });
  });
}

function getUpdatePromptHtml (latest, responseChannel) {
  return `
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8">
        <style>
          *{box-sizing:border-box}
          body{margin:0;background:#202124;color:#f1f3f4;font:14px "Malgun Gothic",Segoe UI,sans-serif;user-select:none}
          .wrap{height:100vh;border:1px solid #5f6368;box-shadow:0 18px 45px rgba(0,0,0,.45);padding:18px 18px 16px}
          .title{font-weight:700;font-size:18px;margin-bottom:10px;color:#fff}
          .version{font-size:16px;line-height:1.45;margin-bottom:12px}
          .version b{color:#8ab4f8}
          .meta{color:#bdc1c6;line-height:1.55;margin-bottom:16px}
          .buttons{display:flex;gap:10px;justify-content:flex-end}
          button{border:1px solid #5f6368;background:#2b2c2f;color:#f1f3f4;border-radius:8px;padding:10px 18px;font:14px "Malgun Gothic",Segoe UI,sans-serif;cursor:pointer}
          button:hover{background:#3c4043}
          .primary{background:#8ab4f8;border-color:#8ab4f8;color:#111}
          .primary:hover{background:#a8c7fa}
          .close{position:absolute;right:10px;top:8px;border:0;background:transparent;color:#bdc1c6;padding:4px 8px;font-size:18px}
          .close:hover{background:#3c4043;color:#fff}
        </style>
      </head>
      <body>
        <div class="wrap">
          <button class="close" onclick="send('cancel')" title="닫기">×</button>
          <div class="title">GrimVault-KR 업데이트</div>
          <div class="version">새 버전 <b>${escapeHtml (latest.version)}</b>을 설치할까요?</div>
          <div class="meta">
            현재 버전: ${escapeHtml (DISPLAY_VERSION)}<br>
            다운로드: ${escapeHtml (latest.asset.name)}
          </div>
          <div class="buttons">
            <button onclick="send('cancel')">아니오</button>
            <button class="primary" onclick="send('install')">예, 설치</button>
          </div>
        </div>
        <script>
          const { ipcRenderer } = require('electron');
          function send(value) {
            ipcRenderer.send('${responseChannel}', value);
          }
        </script>
      </body>
    </html>
  `;
}

function escapeHtml (value) {
  return String (value)
    .replace (/&/g, '&amp;')
    .replace (/</g, '&lt;')
    .replace (/>/g, '&gt;')
    .replace (/"/g, '&quot;')
    .replace (/'/g, '&#39;');
}

function createTrayImages (iconPath) {
  const normal = nativeImage.createFromPath (iconPath);
  const update = createUpdateBadgeImage (normal);

  return { normal, update };
}

function createUpdateBadgeImage (sourceImage) {
  const size = 16;
  const image = sourceImage.resize ({ width: size, height: size });
  const bitmap = Buffer.from (image.toBitmap ());

  drawCircle (bitmap, size, size, size - 5, 5, 4, { r: 255, g: 255, b: 255, a: 255 });
  drawCircle (bitmap, size, size, size - 5, 5, 3, { r: 230, g: 24, b: 24, a: 255 });

  return nativeImage.createFromBitmap (bitmap, { width: size, height: size });
}

function drawCircle (bitmap, width, height, centerX, centerY, radius, color) {
  const radiusSquared = radius * radius;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const distanceX = x - centerX;
      const distanceY = y - centerY;

      if (distanceX * distanceX + distanceY * distanceY > radiusSquared) continue;

      const index = (y * width + x) * 4;
      bitmap [index] = color.b;
      bitmap [index + 1] = color.g;
      bitmap [index + 2] = color.r;
      bitmap [index + 3] = color.a;
    }
  }
}

function setTrayUpdateState (tray, trayImages, latest) {
  if (portableUpdateInstalling) return;

  pendingPortableUpdate = latest;

  if (latest) {
    tray.setImage (trayImages.update);
    tray.setToolTip (`GrimVault-KR - 새 버전 ${latest.version} 사용 가능`);
  } else {
    tray.setImage (trayImages.normal);
    tray.setToolTip ('GrimVault-KR');
  }
}

function setTrayInstallingState (tray, trayImages, installing, status = '업데이트 진행 중...') {
  portableUpdateInstalling = installing;
  portableUpdateStatus = status;

  if (installing) {
    tray.setImage (trayImages.normal);
    tray.setToolTip (`GrimVault-KR - ${portableUpdateStatus}`);
  } else {
    portableUpdateStatus = '업데이트 진행 중...';
    setTrayUpdateState (tray, trayImages, pendingPortableUpdate);
  }

  tray.setContextMenu (buildTrayMenu (tray, trayImages));
}

function updateTrayInstallingStatus (tray, trayImages, status) {
  if (!portableUpdateInstalling) return;

  portableUpdateStatus = status;
  tray.setImage (trayImages.normal);
  tray.setToolTip (`GrimVault-KR - ${portableUpdateStatus}`);
  tray.setContextMenu (buildTrayMenu (tray, trayImages));
}

async function refreshTrayUpdateState (tray, trayImages) {
  if (portableUpdateInstalling) return;

  try {
    const latest = await checkForPortableUpdate (() => {});
    setTrayUpdateState (tray, trayImages, latest);
    tray.setContextMenu (buildTrayMenu (tray, trayImages));
  } catch (error) {
    logger.error ('Portable update badge check failed:', error);
  }
}

function buildTrayMenu (tray, trayImages) {
  return Menu.buildFromTemplate ([
    {
      label: '버전',
      type: 'normal',
      click: () => {
        showToast (`Current version: ${DISPLAY_VERSION}`);
      }
    },
    {
      label: '로그',
      click: () => {
        shell.openPath (logPath);
      }
    },

    {
      label: '설정',
      click: () => {
        shell.openPath (settingsPath);
      }
    },

    {
      label: portableUpdateInstalling ? portableUpdateStatus : '업데이트 확인',
      type: 'normal',
      enabled: !portableUpdateInstalling,
      click: async () => {
        let updateMessage = null;
        const latest = pendingPortableUpdate || await checkForPortableUpdate ((message) => {
            updateMessage = message;
          });

        if (!latest) {
          if (updateMessage) showToast (updateMessage);
          return;
        }

        setTrayUpdateState (tray, trayImages, latest);
        const shouldInstall = await showUpdateInstallPrompt (latest);

        if (shouldInstall) {
          pendingPortableUpdate = null;
          setTrayInstallingState (tray, trayImages, true, `다운로드 준비 중... (${latest.version})`);
          const installed = await installPortableUpdate (showToast, latest, (status) => {
            updateTrayInstallingStatus (tray, trayImages, status);
          });

          if (!installed) {
            portableUpdateInstalling = false;
            await refreshTrayUpdateState (tray, trayImages);
          }
        } else {
          showToast ('업데이트를 취소했습니다.');
        }
      }
    },

    {
      label: '종료',
      type: 'normal',
      click: () => {
        app.quit ();
      }
    }
  ]);
}

app.on ('ready', async () => {
  logSystemInformation ();

  logger.info ('Setting up system tray');
  
  const trayImages = createTrayImages (join (ROOT, 'assets/images/Icon-81x89.png'));
  let tray = new Tray (trayImages.normal);
  let menu = buildTrayMenu (tray, trayImages);

  tray.setToolTip ('GrimVault-KR');
  tray.setContextMenu (menu);
  tray.on ('click', () => {
    tray.popUpContextMenu (menu);
  });

  refreshTrayUpdateState (tray, trayImages);
  setInterval (() => {
    refreshTrayUpdateState (tray, trayImages);
  }, UPDATE_BADGE_CHECK_INTERVAL_MS);

  logger.info ('Creating overlay window');

  let overlay = new BrowserWindow ({
    backgroundColor: '#00000000',
    // backgroundColor: '#ff000000',
    show: false,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    focusable: false,
    skipTaskbar: true,
    type: 'toolbar',
    webPreferences: {
      preload: join (SOURCE, 'preload.cjs'),
      sandbox: false,
      backgroundThrottling: true // Allow Electron to throttle rendering when hidden
    },
  });

  overlay.webContents.setZoomFactor (1);

  logger.info ('Initializing event-driven overlay positioning');

  // Set overlay reference for event handling
  setOverlayReference (overlay, debugging);

  // Start Windows event hooks for real-time window tracking
  try {
    const success = startWindowHooks ((eventData) => {
      handleWindowEvent (eventData);
    });

    if (success) {
      logger.info ('Window event hooks started successfully');
    } else {
      logger.error ('Failed to start window event hooks');
    }
  } catch (error) {
    logger.error ('Error starting window event hooks:', error);
  }

  // Fallback polling mechanism (much slower, only for safety)
  logger.info ('Starting fallback polling mechanism');
  setInterval (() => {
    pin (overlay, debugging);
  }, 30000); // 30 seconds instead of 2.5 seconds

  wire (overlay);

  logger.info ('Checking for portable update badges every 12 hours');

  const vcredistInstalled = await checkAndInstallVCRedist (overlay);
  
  if (!vcredistInstalled) {
    logger.error ('Required Visual C++ Redistributable is not installed');
    app.quit ();

    return;
  } else {
    logger.info ('Visual C++ Redistributable installed successfully or already installed');
  }

  startKoreanOcr (settings.general.python_path);

  try {
    await authServer.start ();
  } catch (error) {
    logger.error ('Failed to start auth server:', error);
  }

  if (app.isPackaged) {
    overlay.loadFile (join (ROOT, 'ui', 'overlay', 'dist', 'index.html'));
  } else {
    overlay.loadURL ('http://localhost:5173');
  }

  registerShortcut (settings.hotkeys.toggle_mode, () => {
    logger.info ('Toggling mode');
    overlay.webContents.send ('manual:toggle');
  });
  
  registerShortcut (settings.hotkeys.run_price_check, () => {
    logger.info ('Running manual price check');
    overlay.webContents.send ('manual:scan');
  }, true);

  registerShortcut ('F1', () => {
    showToast (`Current version: ${DISPLAY_VERSION}`);
  }, true);

  if (isDebug ()) {
    overlay.webContents.openDevTools ({
      mode: 'detach'
    });
  }

  registerShortcut ('F7', () => {
    logger.info ('Toggling debugger');
    overlay.webContents.send ('manual:debugger');

    debugging = !debugging;

    if (debugging) {
      overlay.webContents.openDevTools ({
        mode: 'detach'
      });
    } else {
      overlay.webContents.closeDevTools ();
    }
  });

  registerShortcut ('F8', () => {
    overlay.webContents.send ('clear');
  });
});

function registerShortcut (accelerator, callback, notifyFailure = false) {
  const registered = globalShortcut.register (accelerator, callback);

  if (registered) {
    logger.info (`Registered global shortcut: ${accelerator}`);
    return true;
  }

  const message = `단축키 ${accelerator}를 등록하지 못했습니다. 다른 프로그램이 같은 단축키를 사용 중인지 확인해 주세요.`;
  logger.error (message);

  if (notifyFailure) {
    showToast (message);
  }

  return false;
}
