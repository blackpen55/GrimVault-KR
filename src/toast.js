import electron from 'electron';

const { BrowserWindow } = electron;
const TOAST_DURATION_MS = 1000;
let toast = null;
let closeTimer = null;

export function showToast (message) {
  if (closeTimer) clearTimeout (closeTimer);

  if (!toast || toast.isDestroyed ()) {
    toast = new BrowserWindow ({
      width: 420,
      height: 86,
      frame: false,
      resizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false
    });
    toast.setAlwaysOnTop (true, 'screen-saver');
    toast.on ('closed', () => { toast = null; });
  }

  const body = encodeURIComponent (String (message));
  toast.loadURL (`data:text/html;charset=utf-8,<meta charset="utf-8"><style>body{margin:0;padding:15px 18px;color:%23fff;background:%23202124;border:1px solid %235f6368;font:15px sans-serif}b{display:block;margin-bottom:8px}</style><b>GrimVault-KR</b>${body}`);
  toast.showInactive ();

  closeTimer = setTimeout (() => {
    toast?.close ();
    closeTimer = null;
  }, TOAST_DURATION_MS);
}
