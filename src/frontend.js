import electron from 'electron';
import { logger } from './logger.js';
import { settings } from './settings.js';
import { getTooltip as getNativeTooltip } from './native.js';
import { api } from './api.js';
import { authServer } from './authServer.js';
import { getCanScan } from './pin.js';
import * as korean from './korean/index.js';

const frontend = electron.ipcMain;
let isScanning = false;
let lastScanCache = { text: null, result: null, timestamp: 0 };
const CACHE_TTL_MS = 10000;

export function wire (overlay) {
  let send = (messageType, data) => {
    logger.debug (`Sending frontend message: ${messageType}`);
    overlay.webContents.send (messageType, data);
  };

  frontend.on ('ready', () => {
    logger.info ('Received frontend ready state');
    
    // If in safe mode, log it but don't send a notification
    if (settings.general.safe_mode) {
      logger.info('Running in safe mode with reduced performance');
    }
    
    send ('settings', settings);
  });

  frontend.on ('log', (event, data) => {
    logger.log (
      data.level,
      `[Frontend] ${data.message}`,
      data.meta || {}
    );
  });

  frontend.on ('scan', async (event, data) => {
    const scanId = data?.scanId || 0;

    if (isScanning) {
      logger.debug ('Scan skipped: another scan is already running');
      return;
    }

    isScanning = true;

    send ('scan:start');

    // Helper to send error events
    const sendError = (message, tooltip = null) => {
      send ('hover:error', {
        scanId,
        message,
        x: tooltip?.x || 0,
        y: tooltip?.y || 0,
        width: tooltip?.width || 100,
        height: tooltip?.height || 50
      });
    };

    // Safety check: Verify window state before scanning
    const koreanAvailable = await korean.isAvailable ();

    if (!getCanScan () && !koreanAvailable) {
      logger.debug ('Scan rejected: game window not in valid state for scanning');
      send ('clear', { scanId });
      send ('scan:finish');
      isScanning = false;
      return;
    }

    try {
      let tooltip;

      try {
        tooltip = koreanAvailable ? await korean.getTooltip () : null;

        if (!tooltip) {
          tooltip = await getNativeTooltip ();
        }
      } catch (e) {
        logger.error (`Error getting tooltip: ${e.message || e}`);

        try {
          tooltip = await getNativeTooltip ();
        } catch (fallbackError) {
          logger.error (`Native tooltip fallback failed: ${fallbackError.message || fallbackError}`);
        }
      }

      logger.debug ('Found tooltip: ', tooltip);

      if (tooltip) {
        if (tooltip.game_bounds) {
          overlay.setBounds ({
            x: tooltip.game_bounds.x,
            y: tooltip.game_bounds.y,
            width: tooltip.game_bounds.width,
            height: tooltip.game_bounds.height
          });
          overlay.setIgnoreMouseEvents (true, { forward: true });
          overlay.setAlwaysOnTop (true, 'screen-saver');
          overlay.show ();
          overlay.moveTop ();

          send ('game:bounds', {
            ... tooltip.game_bounds,
            x: 0,
            y: 0,
            scale: 1.0
          });

          send ('game:state', {
            canScan: true,
            visible: true,
            focused: true
          });
        }

        if (tooltip.korean_item_name || tooltip.display_lines?.length) {
          send ('hover:preview', {
            scanId,
            ...tooltip
          });
        }

        if (tooltip.error || !tooltip.text) {
          sendError (
            tooltip.error || 'OCR은 되었지만 DarkerDB에 보낼 아이템 정보를 만들지 못했습니다.',
            tooltip
          );
          return;
        }

        let result;
        const now = Date.now ();

        if (lastScanCache.text === tooltip.text && (now - lastScanCache.timestamp) < CACHE_TTL_MS) {
          logger.info ('Using cached item stats result');
          result = lastScanCache.result;
        } else {
          result = await getItemStats (tooltip.text);
          lastScanCache = { text: tooltip.text, result, timestamp: now };
        }

        if (result.success) {
          send ('hover:item', {
            scanId,
            ... tooltip,
            ... result.data
          });
        } else {
          // Error occurred during API call
          sendError (result.error, tooltip);
        }
      } else {
        send ('clear', { scanId });
      }
    } catch (e) {
      logger.error (`Scan failed: ${e.message || e}`);
      sendError ('가격 조회 중 오류가 발생했습니다.');
    } finally {
      send ('scan:finish');
      isScanning = false;
    }
  });
  
  frontend.handle ('auth:status', async () => {
    const hasCredentials = await authServer.hasCredentials ();
    return { linked: hasCredentials };
  });
  
  frontend.handle ('auth:logout', async () => {
    await authServer.clearCredentials ();
    return { success: true };
  });

  frontend.handle ('korean:status', async () => {
    return { enabled: true, available: await korean.isAvailable () };
  });

  frontend.handle ('korean:mappings', async () => {
    return await korean.getMappings ();
  });

  frontend.handle ('korean:add-mapping', async (event, data) => {
    return await korean.addMapping (data.korean, data.english);
  });

  frontend.handle ('korean:remove-mapping', async (event, data) => {
    return await korean.removeMapping (data.korean);
  });
}

async function getItemStats (tooltipText) {
  try {
    let response = await api.get ('/v1/internal/grimvault/analyze', {
      params: {
        tooltip: tooltipText
      }
    });

    if (!response) {
      return {
        success: false,
        error: '서버 응답이 없습니다'
      };
    }

    return {
      success: true,
      data: response.data.body
    };
  } catch (e) {
    logger.error (`API error: ${e.message || e}`);

    // Extract error message from response
    let errorMessage = '알 수 없는 오류가 발생했습니다';

    if (e.response) {
      // Server responded with error status
      if (e.response.data?.errors && Array.isArray (e.response.data.errors) && e.response.data.errors.length > 0) {
        // Use first error from errors array
        errorMessage = translateApiError (e.response.data.errors[0], tooltipText);
      } else if (e.response.data?.status) {
        // Use status message
        errorMessage = translateApiError (e.response.data.status, tooltipText);
      } else if (e.response.statusText) {
        // Use HTTP status text
        errorMessage = `${e.response.status}: ${e.response.statusText}`;
      }
    } else if (e.message) {
      // Network error or other client-side error
      errorMessage = e.message;
    }

    return {
      success: false,
      error: errorMessage
    };
  }
}

function translateApiError (message, tooltipText = '') {
  if (message === 'Failed to parse tooltip' && tooltipText.includes ('Rarity: Artifact')) {
    return '유물 이름은 인식했지만 DarkerDB 서버가 아직 이 아이템의 가격 조회를 지원하지 않습니다.';
  }

  const errorMap = {
    'Failed to parse tooltip': '아이템 정보를 해석하지 못했습니다. 한국어 매핑을 보강해야 할 수 있습니다.',
    'Item not found': '해당 아이템을 찾지 못했습니다.',
    'Invalid tooltip': '유효하지 않은 아이템 정보입니다.',
    'Rate limit exceeded': '요청이 너무 많습니다. 잠시 후 다시 시도하세요.',
    'Unauthorized': '인증되지 않았습니다. API 키 설정을 확인하세요.',
  };

  return errorMap [message] || message;
}
