/**
 * Walmart scraper — parses the __NEXT_DATA__ JSON blob embedded in Walmart's
 * server-side-rendered search pages.
 *
 * Session note:
 *   Walmart returns a "Robot or human?" Cloudflare challenge (200 but no product
 *   data) if cookies aren't present. The fix is to first hit the Walmart homepage
 *   to receive session cookies, then carry them into every subsequent search
 *   request. The scraper handles this automatically via initSession().
 *
 * Seller filtering:
 *   item.sellerName === 'Walmart.com' is the only reliable first-party signal.
 *   item.sellerType is null for BOTH Walmart and marketplace sellers so cannot
 *   be used. Walmart's internal sellerId (F55CDC…) is used as a secondary check.
 *
 * Stock status:
 *   item.isOutOfStock (bool) + item.availabilityStatusV2.value ('IN_STOCK' /
 *   'OUT_OF_STOCK') provide reliable stock data. item.preOrder.isPreOrder
 *   surfaces pre-release listings.
 *
 * If __NEXT_DATA__ paths stop working, open a Walmart search page in DevTools,
 * find the <script id="__NEXT_DATA__"> tag, and trace from
 * props.pageProps.initialData.searchResult.itemStacks[].items[].
 */

const axios = require('axios');
const zlib = require('zlib');
const config = require('../config');
const { withRetry, sleep, throwIfAborted } = require('../utils/retry');

// ── Constants ─────────────────────────────────────────────────────────────────

const WALMART_BASE   = 'https://www.walmart.com';
const SEARCH_URL     = `${WALMART_BASE}/search`;
const WALMART_IO_BASE = 'https://developer.api.walmart.com/api-proxy/service';

// Walmart's own seller ID in their marketplace system — used as backup filter.
const WALMART_SELLER_ID = 'F55CDC31AB754BB68FE0B39041159D63';

// Search terms focused on TCG products; broader terms first for best coverage.
const SEARCH_KEYWORDS = [
  'pokemon trading card game',
  'pokemon booster pack',
  'pokemon elite trainer box',
  'pokemon tin',
  'pokemon collection box',
];

const DELAY_MS   = 2000;  // polite delay between pages; Walmart rate-limits aggressively
const MAX_RETRIES = 3;

// ── Session / HTTP ────────────────────────────────────────────────────────────

const BASE_HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection':      'keep-alive',
  'Upgrade-Insecure-Requests': '1',
};

/**
 * Fetch the Walmart homepage to obtain the session cookies (isoLoc, akavpau_p2)
 * required to bypass Cloudflare bot detection on subsequent requests.
 * Returns a cookie string suitable for the Cookie header.
 */
async function initSession(signal) {
  const res = await axios.get(WALMART_BASE + '/', {
    headers: { ...BASE_HEADERS },
    timeout: 20000,
    signal,
    maxRedirects: 5,
  });

  const cookies = (res.headers['set-cookie'] ?? [])
    .map(c => c.split(';')[0])
    .join('; ');

  if (!cookies) {
    throw new Error('[Walmart] Homepage returned no cookies — cannot establish session');
  }

  return cookies;
}

async function fetchPage(cookieStr, keyword, page, signal) {
  return withRetry(
    async () => {
      const res = await axios.get(SEARCH_URL, {
        params:  { q: keyword, page },
        headers: { ...BASE_HEADERS, Referer: WALMART_BASE + '/', Cookie: cookieStr },
        timeout: 30000,
        signal,
        decompress: true,
      });
      return res.data;
    },
    {
      maxAttempts: MAX_RETRIES,
      baseDelayMs: 2000,
      isRetryable(err) {
        const status = err.response?.status;
        return status === 429 || !status || status >= 500 || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT';
      },
      getDelay(err, attempt, baseDelayMs) {
        if (err.response?.status === 429) return 5000 * (2 ** (attempt - 1));  // 5s, 10s
        return baseDelayMs * (2 ** (attempt - 1));
      },
      onRetry(err, attempt, delayMs) {
        if (err.response?.status === 429) {
          console.warn(`[Walmart] Rate limited (429) — backing off ${delayMs / 1000}s…`);
        } else {
          console.warn(`[Walmart] Attempt ${attempt} failed (${err.message}) — retrying in ${delayMs / 1000}s…`);
        }
      },
      signal,
    },
  );
}

// ── Data extraction ───────────────────────────────────────────────────────────

function parseNextData(html) {
  const match = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function extractItems(nextData) {
  const itemStacks = nextData?.props?.pageProps?.initialData?.searchResult?.itemStacks ?? [];
  return itemStacks.flatMap(stack => stack.items ?? []).filter(i => i?.usItemId);
}

function extractPagination(nextData) {
  const sr = nextData?.props?.pageProps?.initialData?.searchResult ?? {};
  return {
    maxPage:      sr?.paginationV2?.maxPage ?? 1,
    hasMorePages: sr?.hasMorePages ?? false,
    total:        sr?.aggregatedCount ?? sr?.count ?? 0,
  };
}

// ── Seller filtering ──────────────────────────────────────────────────────────

/**
 * Returns true when the item is sold directly by Walmart.com.
 *
 * Reliable signals (from live API inspection):
 *   item.sellerName === 'Walmart.com'       — primary check
 *   item.sellerId   === WALMART_SELLER_ID   — secondary / backup
 *
 * NOT reliable: item.sellerType is null for both Walmart and marketplace sellers.
 * NOT reliable: item.catalogSellerId is undefined for Walmart AND some 3P sellers.
 */
function isSoldByWalmart(item) {
  if (item.sellerName === 'Walmart.com') return true;
  if (item.sellerId   === WALMART_SELLER_ID) return true;
  return false;
}

/**
 * Walmart's search returns sponsored non-Pokemon items (board games, electronics)
 * as "Walmart.com"-sold results alongside actual TCG products. Filter to items
 * whose name actually contains "pokemon" so we don't false-positive on them.
 */
function isPokemonProduct(item) {
  return (item.name ?? '').toLowerCase().includes('pokemon')
      || (item.name ?? '').toLowerCase().includes('pokémon');
}

function isPokemonTcgProductName(name) {
  const text = String(name || '').toLowerCase();
  if (!text.includes('pokemon') && !text.includes('pokémon')) return false;
  return /\b(tcg|trading card|booster|elite trainer|\betb\b|tin|collection|bundle|deck|card game|cards?)\b/.test(text);
}

// ── Stock status ──────────────────────────────────────────────────────────────

/**
 * Derives one of three statuses from Walmart item fields.
 *   'pre_order'    — item.preOrder.isPreOrder is true
 *   'in_stock'     — isOutOfStock false AND availabilityStatusV2.value IN_STOCK
 *   'out_of_stock' — isOutOfStock true OR value OUT_OF_STOCK
 */
function getStockStatus(item) {
  if (item.preOrder?.isPreOrder === true) return 'pre_order';

  const avStatus  = item.availabilityStatusV2?.value ?? '';
  const isOOS     = item.isOutOfStock === true;

  if (isOOS || avStatus === 'OUT_OF_STOCK') return 'out_of_stock';
  if (avStatus === 'IN_STOCK')              return 'in_stock';

  // Fallback: if we can add to cart the item is likely in stock
  if (item.canAddToCart === true || item.showAtc === true) return 'in_stock';

  return 'out_of_stock';
}

// ── Normalisation ─────────────────────────────────────────────────────────────

function buildUrl(item) {
  const canonical = item.canonicalUrl ?? '';
  // Strip marketplace condition params that don't apply to Walmart-sold items
  const cleanPath = canonical.split('?')[0];
  return cleanPath ? `${WALMART_BASE}${cleanPath}` : `${WALMART_BASE}/ip/${item.usItemId}`;
}

function buildPrice(item) {
  // item.price is a raw number; priceInfo.linePrice is formatted "$X.XX"
  const raw       = item.price;
  const formatted = item.priceInfo?.linePrice ?? '';
  const numeric   = raw != null ? Number(raw) : parseFloat(formatted.replace(/[^0-9.]/g, '')) || null;
  const wasPrice  = item.priceInfo?.wasPrice ? item.priceInfo.wasPrice.replace(/['"]/g, '') : null;

  return {
    price:        numeric != null ? `$${numeric.toFixed(2)}` : 'N/A',
    priceNumeric: numeric,
    regularPrice: wasPrice ?? null,
  };
}

function getPickupStatus(item) {
  // pickupMethod: 'PICKUP' when the item supports store pickup
  const fulfillment = item.fulfillmentBadges ?? item.fulfillmentType ?? '';
  const pickupAvail = item.pickupAndDeliveryStoreInfo?.pickupStores?.[0]?.available;
  if (pickupAvail === true)  return 'in_stock';
  if (pickupAvail === false) return 'out_of_stock';
  // Simpler flag
  const badge = (Array.isArray(item.fulfillmentBadges) ? item.fulfillmentBadges : [])
    .map(b => (b ?? '').toLowerCase());
  if (badge.includes('pickup_today') || badge.includes('free_pickup_today')) return 'in_stock';
  return null;
}

function normalizeItem(item) {
  const stockStatus  = getStockStatus(item);
  const { price, priceNumeric, regularPrice } = buildPrice(item);
  const preorder     = item.preOrder ?? {};

  return {
    id:             `walmart-${item.usItemId}`,
    retailer:       'walmart',
    usItemId:       item.usItemId,
    name:           item.name ?? '',
    brand:          item.brand ?? null,
    price,
    priceNumeric,
    regularPrice,
    url:            buildUrl(item),
    inStock:        stockStatus === 'in_stock',
    stockStatus,    // 'in_stock' | 'out_of_stock' | 'pre_order'
    pickupStatus:   getPickupStatus(item),  // 'in_stock' | 'out_of_stock' | null
    releaseDate:    preorder.streetDate ?? preorder.releaseDate ?? null,
  };
}

function ensureWalmartApiCredentials(walmartConfig = config.retailers.walmart) {
  const missing = [];
  if (!walmartConfig.consumerId) missing.push('WALMART_CONSUMER_ID');
  if (!walmartConfig.clientSecret) missing.push('WALMART_CLIENT_SECRET');
  if (missing.length) {
    const err = new Error(`[Walmart] Missing API credentials: ${missing.join(', ')}`);
    err.sourceStatus = 'credentials_missing';
    throw err;
  }
}

async function fetchWalmartAccessToken({ signal, walmartConfig = config.retailers.walmart, client = axios } = {}) {
  ensureWalmartApiCredentials(walmartConfig);
  const response = await client.post(
    `${WALMART_IO_BASE}/identity/oauth/v1/token`,
    new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: walmartConfig.consumerId,
      client_secret: walmartConfig.clientSecret,
    }).toString(),
    {
      headers: {
        'cache-control': 'no-cache',
        'content-type': 'application/x-www-form-urlencoded',
        'wm_consumer.id': walmartConfig.consumerId,
      },
      timeout: 15000,
      signal,
    },
  );
  return response.data?.access_token;
}

async function fetchWalmartSnapshotUrls(token, { signal, walmartConfig = config.retailers.walmart, client = axios } = {}) {
  const params = {};
  if (walmartConfig.categoryId) params.categoryId = walmartConfig.categoryId;
  if (walmartConfig.feedType) params.feedType = walmartConfig.feedType;

  const response = await client.get(`${WALMART_IO_BASE}/affil/catalog-api/v2/product/feeds/items`, {
    params,
    headers: {
      'content-type': 'application/json',
      'wm_consumer.id': walmartConfig.consumerId,
      authorization: `Bearer ${token}`,
    },
    timeout: 15000,
    signal,
  });
  return response.data?.product_snapshot_data || [];
}

async function downloadSnapshotPart(url, { signal, client = axios } = {}) {
  const response = await client.get(url, {
    responseType: 'arraybuffer',
    timeout: 30000,
    signal,
  });
  const buffer = Buffer.from(response.data);
  return zlib.gunzipSync(buffer).toString('utf8');
}

function parseSnapshotRecords(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return trimmed
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .map(line => JSON.parse(line));
  }
}

function isFirstPartySnapshotRecord(record) {
  if (record.marketplace === true) return false;
  if (record.sellerInfo && record.sellerInfo !== 'Walmart.com') return false;
  return true;
}

function getSnapshotStockStatus(record) {
  if (record.preOrder === true) return 'pre_order';
  if (record.availableOnline === true && record.stock !== 'Not available') return 'in_stock';
  return 'out_of_stock';
}

function normalizeSnapshotRecord(record) {
  const itemId = String(record.itemId || record.parentItemId || record.productId || '');
  const priceNumeric = Number(record.salePrice);
  const stockStatus = getSnapshotStockStatus(record);
  const productUrl = record.productTrackingUrl
    ? decodeURIComponent(String(record.productTrackingUrl).split('u=')[1] || '')
    : `${WALMART_BASE}/ip/${itemId}`;

  return {
    id: `walmart-${itemId}`,
    retailer: 'walmart',
    usItemId: itemId,
    name: record.name || '',
    brand: record.manufacturer || null,
    price: Number.isFinite(priceNumeric) ? `$${priceNumeric.toFixed(2)}` : 'N/A',
    priceNumeric: Number.isFinite(priceNumeric) ? priceNumeric : null,
    regularPrice: Number.isFinite(Number(record.msrp)) ? `$${Number(record.msrp).toFixed(2)}` : null,
    url: productUrl || `${WALMART_BASE}/ip/${itemId}`,
    inStock: stockStatus === 'in_stock',
    stockStatus,
    pickupStatus: null,
    releaseDate: record.preOrderShipsOn || null,
    sellerName: 'Walmart.com',
    sellerType: 'first_party',
    gtin: record.gtin || record.upc || null,
  };
}

async function scrapeWalmartCatalogSnapshot({ signal, client = axios, walmartConfig = config.retailers.walmart } = {}) {
  ensureWalmartApiCredentials(walmartConfig);
  console.log('[Walmart] Fetching Walmart I/O catalog snapshot feed...');
  const token = await fetchWalmartAccessToken({ signal, walmartConfig, client });
  if (!token) {
    const err = new Error('[Walmart] OAuth response did not include access_token');
    err.sourceStatus = 'credentials_invalid';
    throw err;
  }

  const urls = await fetchWalmartSnapshotUrls(token, { signal, walmartConfig, client });
  if (!urls.length) return [];

  const products = [];
  const seen = new Set();
  const maxParts = Math.max(1, walmartConfig.maxFeedParts || 1);

  for (const url of urls.slice(0, maxParts)) {
    throwIfAborted(signal);
    const text = await downloadSnapshotPart(url, { signal, client });
    for (const record of parseSnapshotRecords(text)) {
      if (!record?.itemId || seen.has(String(record.itemId))) continue;
      seen.add(String(record.itemId));
      if (!isFirstPartySnapshotRecord(record)) continue;
      if (!isPokemonTcgProductName(record.name)) continue;
      products.push(normalizeSnapshotRecord(record));
    }
  }

  console.log(`[Walmart] Catalog snapshot yielded ${products.length} first-party Pokemon TCG product(s)`);
  return products;
}

// ── Main scraper ──────────────────────────────────────────────────────────────

async function scrapeWalmart({ signal } = {}) {
  if (config.retailers.walmart.apiEnabled) {
    try {
      return await scrapeWalmartCatalogSnapshot({ signal });
    } catch (err) {
      if (err.response?.status === 401) err.sourceStatus = 'credentials_invalid';
      if (err.response?.status === 403) err.sourceStatus = 'blocked';
      throw err;
    }
  }

  console.log('[Walmart] Initialising session…');
  let cookies;
  try {
    cookies = await initSession(signal);
    console.log('[Walmart] Session ready');
  } catch (err) {
    console.error(`[Walmart] Session init failed: ${err.message}`);
    err.sourceStatus = err.code === 'SOURCE_TIMEOUT' ? 'timeout' : 'blocked';
    throw err;
  }

  await sleep(1000, signal); // brief pause before first search

  const products        = [];
  const seen            = new Set();
  let   thirdPartyCount = 0;

  for (const keyword of SEARCH_KEYWORDS) {
    let page    = 1;
    let maxPage = Infinity; // set after first response

    console.log(`[Walmart] Searching: "${keyword}"`);

    while (page <= maxPage && page <= config.maxPages) {
      throwIfAborted(signal);
      let html;
      try {
        html = await fetchPage(cookies, keyword, page, signal);
      } catch (err) {
        console.error(`[Walmart] Fetch failed on "${keyword}" page ${page}: ${err.message}`);
        if (page === 1 && products.length === 0) {
          err.sourceStatus = err.response?.status === 429 ? 'blocked' : err.sourceStatus;
          throw err;
        }
        break;
      }

      const nextData = parseNextData(html);
      if (!nextData) {
        console.warn(`[Walmart] No __NEXT_DATA__ on "${keyword}" page ${page} — bot check may have triggered`);
        if (page === 1 && products.length === 0) {
          const err = new Error(`[Walmart] No __NEXT_DATA__ on first result page — bot check may have triggered`);
          err.sourceStatus = 'blocked';
          throw err;
        }
        break;
      }

      const items = extractItems(nextData);
      const pagination = extractPagination(nextData);

      if (page === 1) {
        maxPage = Math.min(pagination.maxPage, config.maxPages);
        console.log(`[Walmart] "${keyword}": ${pagination.total} results, ${pagination.maxPage} pages`);
      }

      if (items.length === 0) {
        console.log(`[Walmart] Empty page for "${keyword}" page ${page} — stopping`);
        break;
      }

      let newCount   = 0;
      let skipCount  = 0;

      for (const item of items) {
        const id = item.usItemId;
        if (!id || seen.has(id)) continue;
        seen.add(id);

        if (!isSoldByWalmart(item) || !isPokemonProduct(item)) {
          if (!isSoldByWalmart(item)) thirdPartyCount++;
          skipCount++;
          continue;
        }

        products.push(normalizeItem(item));
        newCount++;
      }

      console.log(
        `[Walmart] "${keyword}" page ${page}/${maxPage}: ` +
        `${items.length} items → ${newCount} added, ${skipCount} 3rd-party skipped`,
      );

      page++;
      if (page <= maxPage && page <= config.maxPages) await sleep(DELAY_MS, signal);
    }

    // Pause between keywords to reduce risk of rate-limiting
    if (SEARCH_KEYWORDS.indexOf(keyword) < SEARCH_KEYWORDS.length - 1) await sleep(DELAY_MS * 2, signal);
  }

  const inStock    = products.filter(p => p.stockStatus === 'in_stock').length;
  const outOfStock = products.filter(p => p.stockStatus === 'out_of_stock').length;
  const preOrder   = products.filter(p => p.stockStatus === 'pre_order').length;

  console.log(
    `[Walmart] Done: ${products.length} Walmart-sold products ` +
    `(${inStock} in-stock, ${outOfStock} OOS, ${preOrder} pre-order, ${thirdPartyCount} 3rd-party skipped)`,
  );

  return products;
}

// ── CLI ───────────────────────────────────────────────────────────────────────
// node scrapers/walmart.js            → run and show 5 sample products
// node scrapers/walmart.js --all      → show all products
// node scrapers/walmart.js --json     → output raw JSON

if (require.main === module) {
  const args    = process.argv.slice(2);
  const showAll = args.includes('--all');
  const asJson  = args.includes('--json');

  scrapeWalmart()
    .then(products => {
      if (asJson) {
        console.log(JSON.stringify(products, null, 2));
        return;
      }

      const sample = showAll ? products : products.slice(0, 5);

      console.log(`\n${'─'.repeat(70)}`);
      console.log(`Walmart Pokemon TCG — ${sample.length} of ${products.length} products shown`);
      console.log(`  In-stock:    ${products.filter(p => p.stockStatus === 'in_stock').length}`);
      console.log(`  Out-of-stock: ${products.filter(p => p.stockStatus === 'out_of_stock').length}`);
      console.log(`  Pre-order:   ${products.filter(p => p.stockStatus === 'pre_order').length}`);
      console.log('─'.repeat(70));

      if (sample.length === 0) {
        console.log('\nNo Walmart-sold products found in this search batch.');
        console.log('Note: Walmart\'s Pokemon TCG inventory is currently dominated by marketplace');
        console.log('sellers. Walmart-sold items may appear on later pages (increase MAX_PAGES)');
        console.log('or when new products are released directly through Walmart.');
        return;
      }

      sample.forEach((p, i) => {
        const statusLabel = {
          in_stock:     '✅ In Stock',
          out_of_stock: '❌ OOS',
          pre_order:    '🔜 Pre-order',
        }[p.stockStatus] ?? p.stockStatus;

        console.log(`\n[${i + 1}] ${p.name}`);
        console.log(`    Brand:  ${p.brand ?? 'N/A'}`);
        console.log(`    Price:  ${p.price}${p.regularPrice ? ` (was ${p.regularPrice})` : ''}`);
        console.log(`    Status: ${statusLabel}`);
        if (p.releaseDate) console.log(`    Release: ${p.releaseDate}`);
        console.log(`    URL:    ${p.url}`);
      });
      console.log(`\n${'─'.repeat(70)}`);
    })
    .catch(err => {
      console.error('[Walmart] Fatal:', err.message);
      process.exit(1);
    });
}

module.exports = {
  scrapeWalmart,
  parseNextData,
  extractItems,
  extractPagination,
  isSoldByWalmart,
  isPokemonProduct,
  getStockStatus,
  normalizeItem,
  isPokemonTcgProductName,
  fetchWalmartAccessToken,
  fetchWalmartSnapshotUrls,
  parseSnapshotRecords,
  isFirstPartySnapshotRecord,
  normalizeSnapshotRecord,
  scrapeWalmartCatalogSnapshot,
};
