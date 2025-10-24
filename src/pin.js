import { logger } from './logger.js';
import { getActiveWindow, getGameWindow } from './native.js';

const TASKBAR_HEIGHT = 50;

const ALLOWED_WINDOWS = [
  'Dark and Darker',
  'GrimVault',
  'Electron'
];

// Debounce timing (in milliseconds)
const DEBOUNCE_DELAY = 16; // ~60fps

let previousGameBounds = null;

let isActive = false;
let isShown = false;

let debounceTimer = null;
let overlayRef = null;
let debuggingMode = false;
let isMinimized = false;

// Handle window event from native hook
export function handleWindowEvent (eventData) {
  if (!overlayRef) {
    logger.warn ('Overlay not initialized for window events');
    return;
  }

  // Clear existing debounce timer
  if (debounceTimer) {
    clearTimeout (debounceTimer);
  }

  // Debounce the update to avoid excessive calls
  debounceTimer = setTimeout (() => {
    updateOverlay (eventData);
  }, DEBOUNCE_DELAY);
}

// Update overlay based on event data
function updateOverlay (eventData) {
  if (!overlayRef) {
    return;
  }

  try {
    const { bounds, monitor, visible, focused } = eventData;

    // If the window is not visible, hide the overlay
    if (!visible) {
      if (isShown && !debuggingMode) {
        overlayRef.hide ();
        isShown = false;
      }
      isActive = false;
      isMinimized = false;
      previousGameBounds = null;
      return;
    }

    // Handle focus changes - minimize when game loses focus
    if (!focused && !debuggingMode) {
      if (isShown && !isMinimized) {
        logger.info ('Game lost focus - minimizing overlay');
        overlayRef.minimize ();
        isMinimized = true;
      }
      return;
    }

    // Game has focus - restore if minimized
    if (focused && isMinimized && !debuggingMode) {
      logger.info ('Game gained focus - restoring overlay');
      overlayRef.restore ();
      isMinimized = false;
    }

    // Send bounds to renderer
    overlayRef.webContents.send ('game:bounds', {
      ... bounds,
      // x and y relative to the monitor the game is running on
      x: bounds.x - monitor.x,
      y: bounds.y - monitor.y
    });

    // Check if position changed
    let positionChanged = !previousGameBounds ||
      bounds.x !== previousGameBounds.x ||
      bounds.y !== previousGameBounds.y ||
      bounds.width !== previousGameBounds.width ||
      bounds.height !== previousGameBounds.height;

    if (positionChanged) {
      logger.debug ('Updating overlay bounds via event: ', bounds);

      overlayRef.setBounds ({
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height
      });
    }

    // Show overlay if not already shown
    if (!isShown) {
      overlayRef.setIgnoreMouseEvents (true, { forward: true });
      overlayRef.setAlwaysOnTop (true, 'screen-saver');
      overlayRef.setVisibleOnAllWorkspaces (true);
      overlayRef.show ();
      overlayRef.moveTop ();

      isShown = true;
      isMinimized = false;
      logger.info ('Overlay shown via window event');
    }

    previousGameBounds = bounds;
    isActive = true;

  } catch (e) {
    logger.error ('Error in handleWindowEvent:', e);
  }
}

// Set overlay reference for event handling
export function setOverlayReference (overlay, debugging) {
  overlayRef = overlay;
  debuggingMode = debugging;
}

// Legacy pin function for fallback polling
export async function pin (overlay, debugging) {
  let shouldHide = true;

  try {
    let activeWindow = await getActiveWindow ();

    if (activeWindow) {
      activeWindow = activeWindow.trim ();

      // Check if the active window is the game window

      logger.debug (`Active window: ${activeWindow}`);

      let allowed = false;

      for (let allowedWindow of ALLOWED_WINDOWS) {
        if (activeWindow.toLowerCase ().indexOf (allowedWindow.toLowerCase ()) !== -1) {
          allowed = true;
          break;
        }
      }

      if (allowed) {
        // If we are already active, we don't need to rebind anything.

        if (isActive) {
          return;
        }

        // Otherwise we became active and need to rebind the overlay.

        // The game window is not always the active window because GrimVault may
        // take active focus.

        let gameInfo = await getGameWindow ();

        logger.debug (`Game info: `, gameInfo);

        if (gameInfo) {
          let bounds = gameInfo.bounds;
          let monitor = gameInfo.monitor;
          let scale = monitor.scale;

          // bounds.x *= scale;
          // bounds.y *= scale;
          // bounds.width *= scale;
          // bounds.height *= scale;

          overlay.webContents.send ('game:bounds', {
            ... bounds,

            // x and y relative to the monitor the game is running on
            x: bounds.x - monitor.x,
            y: bounds.y - monitor.y
          });

          let positionChanged = !previousGameBounds ||
            bounds.x !== previousGameBounds.x ||
            bounds.y !== previousGameBounds.y ||
            bounds.width !== previousGameBounds.width ||
            bounds.height !== previousGameBounds.height;

          if (positionChanged) {
            logger.info ('Updating overlay bounds: ', bounds);

            overlay.setBounds ({
              x: bounds.x,
              y: bounds.y,
              width: bounds.width,
              height: bounds.height
            });
          }

          if (!isShown) {
            overlay.setIgnoreMouseEvents (true, { forward: true });
            overlay.setAlwaysOnTop (true, 'screen-saver');
            overlay.setVisibleOnAllWorkspaces (true);
            overlay.show ();
            overlay.moveTop ();

            isShown = true;
          }

          previousGameBounds = bounds;

          isActive = true;
          shouldHide = false;
        } else {
          logger.warn ('Found a valid active window but could not find the game window');
        }
      } else {
        logger.debug ('Active window is not of interest');
      }
    } else {
      logger.warn ('Failed to get active window');
    }
  } catch (e) {
    logger.error ('Error in pin function:', e);
  }

  if (shouldHide) {
    if (isShown) {
      if (!debugging) {
        overlay.hide ();
      }

      isShown = false;
    }

    isActive = false;
    previousGameBounds = null;
  }
}