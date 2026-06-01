import electron from 'electron';
import { logger } from './logger.js';
import { settings } from './settings.js';
import { getTooltip as getNativeTooltip } from './native.js';
import { api } from './api.js';
import { authServer } from './authServer.js';
import { getCanScan } from './pin.js';
import * as korean from './korean/index.js';
import { showToast } from './toast.js';

const { ipcMain } = electron;
const frontend = ipcMain;
let isScanning = false;
let lastScanCache = { text: null, result: null, timestamp: 0 };
const CACHE_TTL_MS = 10000;
const MARKET_CACHE_TTL_MS = 60000;
const MARKET_PAGE_LIMIT = 50;
const QUICK_SALE_UNDERCUT = 10;
const ATTRIBUTE_PRESENCE_RANGE = '>=-999999';
const FALLBACK_PRICE_RANGE_GROUPS = [
  [ '0:100', '100:250', '250:500', '500:1000' ],
  [ '1000:2500', '2500:5000', '5000:10000', '10000:25000' ],
  [ '25000:100000', '100000:1000000' ]
];
const marketCache = new Map ();

export function wire (overlay) {
  let transientErrorTimer = null;

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

  frontend.on ('manual:scan-disabled', () => {
    showToast ('가격 조회가 비활성화되어 있습니다. F6을 눌러 수동 또는 자동 모드로 변경해 주세요.');
  });

  frontend.on ('scan', async (event, data) => {
    const scanId = data?.scanId || 0;
    const isManualScan = data?.manual === true;

    if (isScanning) {
      logger.debug ('Scan skipped: another scan is already running');

      if (isManualScan) {
        showToast ('가격 조회가 이미 진행 중입니다. 잠시 기다려 주세요.');
      }

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

    const reportError = (message, tooltip = null) => {
      sendError (message, tooltip);

      if (isManualScan && !tooltip?.game_bounds) {
        logger.warn (`Manual scan failed: ${message}`);
        showToast (message);
      }
    };

    const reportTransientError = (message) => {
      if (transientErrorTimer) {
        clearTimeout (transientErrorTimer);
      }

      sendError (message);
      transientErrorTimer = setTimeout (() => {
        send ('clear', { scanId });
        transientErrorTimer = null;
      }, 1000);
    };

    // Safety check: Verify window state before scanning
    const koreanStatus = await korean.getStatus ();
    const koreanAvailable = koreanStatus.available;

    if (!getCanScan () && !koreanAvailable) {
      logger.debug ('Scan rejected: game window not in valid state for scanning');
      if (isManualScan) {
        if (koreanStatus.starting) {
          reportTransientError (koreanStatus.message);
        } else {
          reportError (koreanStatus.message);
        }
      } else {
        send ('clear', { scanId });
      }
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
          reportError (
            translateScanError (tooltip.error) || 'OCR은 되었지만 DarkerDB에 보낼 아이템 정보를 만들지 못했습니다.',
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
          result.pricingPromises?.forEach ((pricingPromise) => pricingPromise.then (() => {
            send ('hover:pricing', { scanId, pricing: result.data.pricing });
          }));

          send ('hover:item', {
            scanId,
            ... tooltip,
            ... result.data
          });
        } else {
          // Error occurred during API call
          reportError (result.error, tooltip);
        }
      } else {
        if (isManualScan) {
          reportError ('아이템 툴팁을 찾지 못했습니다. 게임에서 아이템 툴팁을 연 뒤 F5를 다시 눌러 주세요.');
        } else {
          send ('clear', { scanId });
        }
      }
    } catch (e) {
      logger.error (`Scan failed: ${e.message || e}`);
      reportError ('가격 조회 중 오류가 발생했습니다.');
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

function translateScanError (message) {
  const errorMap = {
    'Game window not found': 'Dark and Darker 게임 창을 찾지 못했습니다. 게임 실행 상태를 확인해 주세요.'
  };

  return errorMap [message] || message;
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

    const data = response.data.body;
    data.pricing = data.pricing || {};
    data.pricing.exact_listing = null;
    data.pricing.similar_listing = null;
    data.pricing.quick_sale = null;
    data.pricing.pending = { market: true, exact: true, similar: true, quick: true };
    const pricingPromises = applyListingPricing (data);

    return {
      success: true,
      data,
      pricingPromises
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

function applyListingPricing (data) {
  const item = data?.item;
  const attributes = item?.secondary || [];

  if (!item?.name || !item?.rarity) {
    data.pricing.pending = { market: false, exact: false, similar: false, quick: false };
    return [];
  }

  const validAttributes = attributes.filter ((attribute) =>
    attribute?.name && attribute.value !== undefined && attribute.value !== null
  );
  const baseParams = new URLSearchParams ({
    item: item.name,
    rarity: item.rarity,
    limit: String (MARKET_PAGE_LIMIT),
    order: 'asc',
    condense: 'true',
    has_sold: 'false',
    has_expired: 'false'
  });
  const exactParams = new URLSearchParams (baseParams);
  const similarParams = new URLSearchParams (baseParams);

  for (const attribute of validAttributes) {
    exactParams.append (`secondary[${attribute.name}]`, attribute.value);
    similarParams.append (
      `secondary[${attribute.name}]`,
      isPresenceOnlySimilarAttribute (attribute) ? ATTRIBUTE_PRESENCE_RANGE : attribute.value
    );
  }

  const previousMarket = data.pricing.market;
  const previousDensity = data.pricing.density;
  const recentSoldParams = new URLSearchParams (exactParams);
  recentSoldParams.set ('has_sold', 'true');
  recentSoldParams.delete ('has_expired');
  recentSoldParams.set ('order', 'desc');
  recentSoldParams.set ('from', new Date (Date.now () - (7 * 24 * 60 * 60 * 1000)).toISOString ());

  let exactCandidate = null;
  let similarCandidate = null;
  let quickCandidate = null;
  const updateListingPrices = () => {
    data.pricing.exact_listing = exactCandidate;
    data.pricing.similar_listing = similarCandidate !== exactCandidate
      ? similarCandidate
      : null;
    data.pricing.quick_sale = quickCandidate === null ? null : quickCandidate - QUICK_SALE_UNDERCUT;
  };

  const marketPromise = getMarketListings (`sold:${recentSoldParams.toString ()}`, recentSoldParams)
    .then ((listings) => {
      const market = median (marketPrices (listings));

      if (market !== null) {
        data.pricing.market = market;
      }

      if (market !== null && previousMarket > 0 && previousDensity > 0) {
        data.pricing.density = Math.round (market / (previousMarket / previousDensity));
      }

      logger.info (`Applied market pricing: median=${market}`);
    })
    .catch ((error) => {
      logger.warn (`Market pricing lookup failed: ${error.message || error}`);
    })
    .finally (() => {
      data.pricing.pending.market = false;
    });

  if (validAttributes.length === 0) {
    data.pricing.pending.exact = false;
    data.pricing.pending.similar = false;
    data.pricing.pending.quick = false;

    return [ marketPromise ];
  }

  const quickPromise = getLowestBaseListingPrice (baseParams)
    .then ((price) => {
      quickCandidate = price;
      updateListingPrices ();
      logger.info (`Applied base listing quick sale pricing: ${data.pricing.quick_sale}`);
    })
    .catch ((error) => {
      logger.warn (`Base listing quick sale pricing lookup failed: ${error.message || error}`);
    })
    .finally (() => {
      data.pricing.pending.quick = false;
    });

  const exactPromise = getLowestMarketPrice (exactParams)
    .then ((price) => {
      exactCandidate = price;
      updateListingPrices ();
      logger.info (`Applied exact listing price: ${exactCandidate}`);
    })
    .catch ((error) => {
      logger.warn (`Exact listing pricing lookup failed: ${error.message || error}`);
    })
    .finally (() => {
      data.pricing.pending.exact = false;
    });

  const similarPromise = getLowestMarketPrice (similarParams)
    .then ((price) => {
      similarCandidate = price;
      updateListingPrices ();
      logger.info (`Applied similar listing price: ${data.pricing.similar_listing}`);
    })
    .catch ((error) => {
      logger.warn (`Similar listing pricing lookup failed: ${error.message || error}`);
    })
    .finally (() => {
      data.pricing.pending.similar = false;
    });

  return [ marketPromise, exactPromise, similarPromise, quickPromise ];
}

async function getMarketListings (cacheKey, params) {
  const cached = marketCache.get (cacheKey);

  if (cached && (Date.now () - cached.timestamp) < MARKET_CACHE_TTL_MS) {
    logger.info (`Using cached active listings: ${cacheKey}`);
    return cached.listings ?? cached.promise;
  }

  const promise = api.get (`/v1/market?${params.toString ()}`)
    .then ((response) => {
      const listings = Array.isArray (response.data?.body) ? response.data.body : [];
      marketCache.set (cacheKey, { listings, timestamp: Date.now () });
      return listings;
    })
    .catch ((error) => {
      marketCache.delete (cacheKey);
      throw error;
    });

  marketCache.set (cacheKey, { promise, timestamp: Date.now () });
  return promise;
}

async function getLowestMarketPrice (params, predicate = () => true) {
  let cursor = null;
  let lowest = null;
  const seenCursors = new Set ();

  while (true) {
    const pageParams = new URLSearchParams (params);

    if (cursor !== null) {
      pageParams.set ('cursor', cursor);
    }

    const listings = await getMarketListings (`lowest:${pageParams.toString ()}`, pageParams);
    lowest = minimum ([ lowest, ... activeMarketPrices (listings, predicate) ].filter ((price) => price !== null));

    if (listings.length < MARKET_PAGE_LIMIT) {
      return lowest;
    }

    const nextCursor = Math.max (
      ... listings
        .map ((listing) => Number (listing.cursor))
        .filter ((listingCursor) => Number.isFinite (listingCursor))
    ) + 1;

    if (!Number.isFinite (nextCursor) || seenCursors.has (nextCursor)) {
      return lowest;
    }

    seenCursors.add (nextCursor);
    cursor = nextCursor;
  }
}

async function getLowestBaseListingPrice (params) {
  for (const ranges of FALLBACK_PRICE_RANGE_GROUPS) {
    const candidates = await Promise.all (
      ranges.map (async (range) => {
        const rangeParams = new URLSearchParams (params);
        rangeParams.set ('price', range);
        const listings = await getMarketListings (`fallback:${rangeParams.toString ()}`, rangeParams);
        return { listings, params: rangeParams };
      })
    );

    for (const candidate of candidates) {
      if (candidate.listings.length === 0) {
        continue;
      }

      const price = candidate.listings.length < MARKET_PAGE_LIMIT
        ? minimum (activeMarketPrices (candidate.listings, hasUsableQuickSalePrice))
        : await getLowestMarketPrice (candidate.params, hasUsableQuickSalePrice);

      if (price !== null) {
        return price;
      }
    }
  }

  return getLowestMarketPrice (params, hasUsableQuickSalePrice);
}

function isPresenceOnlySimilarAttribute (attribute) {
  return attribute.is_percentage === true || !Number.isInteger (Number (attribute.value));
}

function marketPrices (list) {
  return (Array.isArray (list) ? list : [])
    .map ((listing) => Number (listing.price ?? listing.price_per_unit))
    .filter ((price) => Number.isFinite (price) && price > 0);
}

function hasUsableQuickSalePrice (listing) {
  return Number (listing.price ?? listing.price_per_unit) > QUICK_SALE_UNDERCUT;
}

function activeMarketPrices (list, predicate = () => true) {
  return marketPrices ((Array.isArray (list) ? list : []).filter ((listing) => {
    const expiresAt = Date.parse (listing.expires_at);

    return listing.has_sold !== true
      && listing.has_expired !== true
      && (!Number.isFinite (expiresAt) || expiresAt > Date.now ())
      && predicate (listing);
  }));
}

function minimum (prices) {
  return prices.length ? Math.min (... prices) : null;
}

function median (prices) {
  if (!prices.length) {
    return null;
  }

  const sorted = [ ... prices ].sort ((a, b) => a - b);
  const middle = Math.floor (sorted.length / 2);

  return sorted.length % 2
    ? sorted [middle]
    : Math.round ((sorted [middle - 1] + sorted [middle]) / 2);
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
