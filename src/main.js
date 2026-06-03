// import { app, BrowserWindow, ipcMain, screen } from 'electron';
import electron, { dialog, globalShortcut, Menu, shell, Tray } from 'electron';
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

const { app, BrowserWindow } = electron;

let debugging = false;

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

app.on ('ready', async () => {
  logSystemInformation ();

  if (settings.general.auto_updates) {
    checkForPortableUpdate (showToast).catch ((error) => {
      logger.error ('Portable update check failed:', error);
    });
  }

  logger.info ('Setting up system tray');

  let menu = Menu.buildFromTemplate ([
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
      label: '업데이트 확인',
      type: 'normal',
      click: async () => {
        const latest = await checkForPortableUpdate (showToast);
        if (!latest) return;

        const result = await dialog.showMessageBox ({
          type: 'question',
          buttons: [ '예', '아니오' ],
          defaultId: 0,
          cancelId: 1,
          title: 'GrimVault-KR 업데이트',
          message: `새 버전 ${latest.version}을 설치할까요?`,
          detail: `현재 버전: ${DISPLAY_VERSION}\n다운로드: ${latest.asset.name}`
        });

        if (result.response === 0) {
          installPortableUpdate (showToast, latest);
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
  
  let tray = new Tray (join (ROOT, 'assets/images/Icon-81x89.png'));

  tray.setToolTip ('GrimVault-KR');
  tray.setContextMenu (menu);
  tray.on ('click', () => {
    tray.popUpContextMenu (menu);
  });

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

  if (settings.general.auto_updates) {
    logger.info ('Checking for updates every hour');

    setInterval (() => {
      checkForPortableUpdate (showToast).catch ((error) => {
        logger.error ('Portable update check failed:', error);
      });
    }, 60 * 60 * 1000);
  } else {
    logger.info ('Auto updates are disabled');
  }

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
