/**
 * GameStop scraper — Pokemon TCG products sold new by GameStop.
 *
 * Strategy:
 *   1. Fetch the search page HTML (GameStop is server-side rendered via Next.js)
 *   2. Try to extract product data from the embedded __NEXT_DATA__ JSON blob
 *   3. Fall back to Cheerio HTML parsing if __NEXT_DATA__ structure changes
 *
 * GameStop is the sole seller on its own site (no third-party marketplace),
 * so there is no seller filtering needed. We filter for New condition only
 * to exclude pre-owned items priced above MSRP.
 *
 * Stock status:
 *   Derived from the availability field in __NEXT_DATA__ or from the
 *   "Add to Cart" / "Pre-Order" / "Not Available" button state in HTML.
 *
 * If __NEXT_DATA__ paths break after a GameStop site update, open a search
 * page in DevTools → Network tab → look for XHR requests to /api/ endpoints
 * or inspect the <script id="__NEXT_DATA__"> tag to find the new product path.
 *
 * If HTML selectors break, look for the product grid in DevTools Elements and
 * update HTML_SELECTORS below.
 */

const axios   = require('axios');
const cheerio = require('cheerio');
const config  = require('../config');
const { withRetry, sleep, throwIfAborted } = require('../utils/retry');

// ── Constants ─────────────────────────────────────────────────────────────────

const GS_BASE    = 'https://www.gamestop.com';
const SEARCH_URL = `${GS_BASE}/search/`;
const DELAY_MS   = 2000;
const MAX_RETRIES = 3;

// Page size GameStop uses in their search (typically 24 or 48)
const PAGE_SIZE = 24;

const SEARCH_KEYWORDS = [
  'pokemon trading card game',
  'pokemon booster pack',
  'pokemon elite trainer box',
];

// ── HTML selectors — update if GameStop redesigns ─────────────────────────────
// Inspect https://www.gamestop.com/search/?q=pokemon in DevTools if these break.
const SEL = {
  productItem:  '[data-testid="product-card"], .c-product-card, .product-card, li.sku-item',
  title:        '[data-testid="product-title"] a, .c-product-card__title a, .product-title a, h4 a',
  price:        '[data-testid="product-price"], .c-product-card__price, .price-con .current-price',
  condition:    '[data-testid="product-condition"], .c-product-card__condition, .product-condition',
  addToCart:    'button[data-testid="add-to-cart"], button.add-to-cart, .atc-button',
  preOrder:     'button[data-testid="pre-order"], .pre-order-button',
  unavailable:  '.not-available, .sold-out, [data-testid="unavailable"]',
};

// ── HTTP ──────────────────────────────────────────────────────────────────────

const BASE_HEADERS = {
  'User-Agent':                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':                    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language':           'en-US,en;q=0.9',
  'Accept-Encoding':           'gzip, deflate, br',
  'Connection':                'keep-alive',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest':            'document',
  'Sec-Fetch-Mode':            'navigate',
  'Sec-Fetch-Site':            'none',
  'Sec-Fetch-User':            '?1',
};

/**
 * Fetch the GameStop homepage to establish session cookies required to bypass
 * bot detection on subsequent search requests.
 */
async function initSession(signal) {
  const res = await axios.get(GS_BASE + '/', {
    headers: BASE_HEADERS,
    timeout: 20000,
    signal,
    maxRedirects: 5,
  });
  const cookies = (res.headers['set-cookie'] ?? []).map(c => c.split(';')[0]).join('; ');
  return cookies || null;
}

async function fetchPage(cookieStr, keyword, page, signal) {
  return withRetry(
    async () => {
      const headers = {
        ...BASE_HEADERS,
        Referer:          GS_BASE + '/',
        'Sec-Fetch-Site': 'same-origin',
      };
      if (cookieStr) headers.Cookie = cookieStr;

      const res = await axios.get(SEARCH_URL, {
        params: {
          q:         keyword,
          condition: 'new',
          start:     (page - 1) * PAGE_SIZE,
          sz:        PAGE_SIZE,
        },
        headers,
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
        // 403 is not retried — it indicates a persistent bot block for this request
        return status === 429 || !status || status >= 500 || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT';
      },
      getDelay(err, attempt, baseDelayMs) {
        if (err.response?.status === 429) return 6000 * (2 ** (attempt - 1));
        return baseDelayMs * (2 ** (attempt - 1));
      },
      onRetry(err, attempt, delayMs) {
        console.warn(`[GameStop] Attempt ${attempt} failed (${err.message}) — retrying in ${delayMs / 1000}s…`);
      },
      signal,
    },
  );
}

// ── __NEXT_DATA__ extraction ──────────────────────────────────────────────────

function parseNextData(html) {
  const match = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

/**
 * Try multiple known paths in __NEXT_DATA__ where GameStop embeds search results.
 * Returns array of raw product objects or null if not found.
 */
function extractFromNextData(nextData) {
  const candidates = [
    // Path variants observed across GameStop's Next.js versions:
    nextData?.props?.pageProps?.search?.productResults?.results,
    nextData?.props?.pageProps?.searchResult?.products,
    nextData?.props?.pageProps?.initialData?.products,
    nextData?.props?.pageProps?.data?.search?.products,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate) && candidate.length > 0) return candidate;
  }
  return null;
}

function extractPaginationFromNextData(nextData) {
  const page = nextData?.props?.pageProps;
  // Try common pagination paths
  const total = page?.search?.productResults?.total
    ?? page?.searchResult?.count
    ?? page?.totalCount
    ?? 0;
  return { total };
}

// ── Stock status helpers ──────────────────────────────────────────────────────

function getStockStatusFromJson(raw) {
  // Availability field variants seen in GameStop's data
  const avail = (raw.availability ?? raw.availabilityStatus ?? raw.status ?? '').toLowerCase();
  if (avail.includes('preorder') || avail.includes('pre-order') || avail.includes('pre_order')) {
    return 'pre_order';
  }
  if (avail === 'available' || avail === 'in_stock' || avail === 'instock') return 'in_stock';
  if (avail === 'unavailable' || avail === 'out_of_stock' || avail === 'outofstock') return 'out_of_stock';

  // Fallback: check addToCartEnabled, addable, etc.
  if (raw.addToCartEnabled === true || raw.addable === true) return 'in_stock';
  if (raw.preorderable === true) return 'pre_order';

  return 'out_of_stock';
}

function getStockStatusFromHtml($, $item) {
  if ($item.find(SEL.preOrder).length)   return 'pre_order';
  if ($item.find(SEL.unavailable).length) return 'out_of_stock';
  const btn = $item.find(SEL.addToCart).first();
  if (!btn.length) return 'out_of_stock';
  if (btn.is('[disabled]') || btn.hasClass('disabled')) return 'out_of_stock';
  const text = btn.text().trim().toLowerCase();
  if (text.includes('pre-order') || text.includes('preorder')) return 'pre_order';
  if (text.includes('add to cart') || text.includes('shop now')) return 'in_stock';
  return 'out_of_stock';
}

// ── Normalisation ─────────────────────────────────────────────────────────────

function isPokemonProduct(name) {
  const lower = (name ?? '').toLowerCase();
  return lower.includes('pokemon') || lower.includes('pokémon');
}

function isNewCondition(raw) {
  const cond = (raw.condition ?? raw.productCondition ?? '').toLowerCase();
  return !cond || cond === 'new';  // absent condition field → assume new (searching with condition=new param)
}

function extractSkuFromUrl(href) {
  // GameStop product URLs: /products/product-name/SKU.html
  const match = (href ?? '').match(/\/(\d+)\.html?/i);
  return match ? match[1] : null;
}

function parsePriceText(text) {
  if (!text) return null;
  const num = parseFloat(text.replace(/[^0-9.]/g, ''));
  return isNaN(num) ? null : num;
}

function normalizeJsonProduct(raw) {
  const sku         = String(raw.id ?? raw.sku ?? raw.productId ?? '');
  const name        = raw.productName ?? raw.name ?? raw.title ?? '';
  const stockStatus = getStockStatusFromJson(raw);

  const priceRaw    = raw.price ?? raw.salePrice ?? raw.currentPrice ?? null;
  const priceNumeric = priceRaw != null ? Number(priceRaw) : null;
  const regRaw      = raw.basePrice ?? raw.originalPrice ?? raw.msrp ?? null;
  const regNumeric  = regRaw != null && Number(regRaw) !== priceNumeric ? Number(regRaw) : null;

  const urlPath = raw.url ?? raw.productUrl ?? '';
  const url     = urlPath.startsWith('http') ? urlPath : `${GS_BASE}${urlPath}`;

  return {
    id:           `gamestop-${sku}`,
    retailer:     'gamestop',
    sku,
    name,
    brand:        raw.brand ?? raw.manufacturer ?? null,
    price:        priceNumeric != null ? `$${priceNumeric.toFixed(2)}` : 'N/A',
    priceNumeric,
    regularPrice: regNumeric != null ? `$${regNumeric.toFixed(2)}` : null,
    url,
    inStock:      stockStatus === 'in_stock',
    stockStatus,
    releaseDate:  raw.releaseDate ?? raw.streetDate ?? null,
  };
}

function parseHtmlProducts(html, seen) {
  const $        = cheerio.load(html);
  const products = [];

  $(SEL.productItem).each((_, el) => {
    const $item = $(el);

    // Skip used/pre-owned items
    const condText = $item.find(SEL.condition).text().trim().toLowerCase();
    if (condText && condText.includes('pre-owned')) return;

    const titleEl = $item.find(SEL.title).first();
    const name    = titleEl.text().trim();
    const href    = titleEl.attr('href') ?? '';

    if (!name || !isPokemonProduct(name)) return;

    // Extract SKU from URL or data attribute
    const sku = extractSkuFromUrl(href)
      ?? $item.attr('data-sku-id')
      ?? $item.attr('data-product-id')
      ?? '';
    if (!sku || seen.has(sku)) return;
    seen.add(sku);

    const priceText   = $item.find(SEL.price).first().text().trim();
    const priceNumeric = parsePriceText(priceText);
    const stockStatus  = getStockStatusFromHtml($, $item);
    const url          = href.startsWith('http') ? href : `${GS_BASE}${href}`;

    products.push({
      id:           `gamestop-${sku}`,
      retailer:     'gamestop',
      sku,
      name,
      brand:        null,
      price:        priceNumeric != null ? `$${priceNumeric.toFixed(2)}` : 'N/A',
      priceNumeric,
      regularPrice: null,
      url,
      inStock:      stockStatus === 'in_stock',
      stockStatus,
      releaseDate:  null,
    });
  });

  return products;
}

function hasNextHtmlPage($) {
  return $('[data-testid="pagination-next"]:not([disabled]), .pagination-next:not(.disabled), a.next-page').length > 0;
}

// ── Main scraper ──────────────────────────────────────────────────────────────

async function scrapeGameStop({ signal } = {}) {
  console.log('[GameStop] Initialising session…');
  let cookies = null;
  try {
    cookies = await initSession(signal);
    console.log(`[GameStop] Session ready${cookies ? '' : ' (no cookies — may hit bot check)'}`);
  } catch (err) {
    console.warn(`[GameStop] Session init failed (${err.message}) — continuing without cookies`);
  }

  await sleep(1000, signal);
  console.log('[GameStop] Starting Pokemon TCG search (New condition only)');

  const products = [];
  const seen     = new Set();

  for (const keyword of SEARCH_KEYWORDS) {
    let page    = 1;
    let hasMore = true;
    console.log(`[GameStop] Searching: "${keyword}"`);

    while (hasMore && page <= config.maxPages) {
      throwIfAborted(signal);
      let html;
      try {
        html = await fetchPage(cookies, keyword, page, signal);
      } catch (err) {
        console.error(`[GameStop] Fetch failed on "${keyword}" page ${page}: ${err.message}`);
        break;
      }

      // Strategy 1: __NEXT_DATA__ JSON
      const nextData    = parseNextData(html);
      const jsonItems   = nextData ? extractFromNextData(nextData) : null;

      if (jsonItems) {
        if (page === 1) {
          const { total } = extractPaginationFromNextData(nextData);
          const pages = total ? Math.ceil(total / PAGE_SIZE) : '?';
          console.log(`[GameStop] "${keyword}": ~${total} results via __NEXT_DATA__, ~${pages} pages`);
        }

        let newCount  = 0;
        let skipCount = 0;

        for (const raw of jsonItems) {
          const sku = String(raw.id ?? raw.sku ?? raw.productId ?? '');
          if (!sku || seen.has(sku)) continue;
          if (!isNewCondition(raw)) { skipCount++; continue; }

          const name = raw.productName ?? raw.name ?? raw.title ?? '';
          if (!isPokemonProduct(name)) { skipCount++; continue; }

          seen.add(sku);
          products.push(normalizeJsonProduct(raw));
          newCount++;
        }

        const morePages = nextData?.props?.pageProps?.search?.productResults?.hasNextPage
          ?? nextData?.props?.pageProps?.searchResult?.hasMorePages
          ?? (jsonItems.length >= PAGE_SIZE);
        hasMore = morePages;

        console.log(
          `[GameStop] "${keyword}" page ${page}: ` +
          `${jsonItems.length} items → ${newCount} added, ${skipCount} skipped`,
        );

      } else {
        // Strategy 2: Cheerio HTML fallback
        if (page === 1) {
          console.log(`[GameStop] No __NEXT_DATA__ found on "${keyword}" — using HTML fallback`);
        }

        const pageProducts = parseHtmlProducts(html, seen);
        products.push(...pageProducts);

        const $ = cheerio.load(html);
        hasMore = hasNextHtmlPage($) && pageProducts.length > 0;

        console.log(`[GameStop] "${keyword}" page ${page}: ${pageProducts.length} products (HTML mode)`);
      }

      page++;
      if (hasMore && page <= config.maxPages) await sleep(DELAY_MS, signal);
    }

    const kwIdx = SEARCH_KEYWORDS.indexOf(keyword);
    if (kwIdx < SEARCH_KEYWORDS.length - 1) await sleep(DELAY_MS * 2, signal);
  }

  const inStock    = products.filter(p => p.stockStatus === 'in_stock').length;
  const outOfStock = products.filter(p => p.stockStatus === 'out_of_stock').length;
  const preOrder   = products.filter(p => p.stockStatus === 'pre_order').length;

  console.log(
    `[GameStop] Done: ${products.length} products ` +
    `(${inStock} in-stock, ${outOfStock} OOS, ${preOrder} pre-order)`,
  );

  return products;
}

// ── CLI ───────────────────────────────────────────────────────────────────────
// node scrapers/gamestop.js            → run and show 5 sample products
// node scrapers/gamestop.js --all      → show all products
// node scrapers/gamestop.js --json     → output raw JSON

if (require.main === module) {
  require('dotenv').config();
  const args    = process.argv.slice(2);
  const showAll = args.includes('--all');
  const asJson  = args.includes('--json');

  scrapeGameStop()
    .then(products => {
      if (asJson) {
        console.log(JSON.stringify(products, null, 2));
        return;
      }

      const sample = showAll ? products : products.slice(0, 5);

      console.log(`\n${'─'.repeat(70)}`);
      console.log(`GameStop Pokemon TCG — ${sample.length} of ${products.length} products shown`);
      console.log(`  In-stock:     ${products.filter(p => p.stockStatus === 'in_stock').length}`);
      console.log(`  Out-of-stock: ${products.filter(p => p.stockStatus === 'out_of_stock').length}`);
      console.log(`  Pre-order:    ${products.filter(p => p.stockStatus === 'pre_order').length}`);
      console.log('─'.repeat(70));

      if (!sample.length) {
        console.log('\nNo products found.');
        console.log('If this consistently returns 0, GameStop may have changed their page structure.');
        console.log('Open https://www.gamestop.com/search/?q=pokemon in DevTools and update SEL selectors.');
        return;
      }

      sample.forEach((p, i) => {
        const statusLabel = {
          in_stock:     '✅ In Stock',
          out_of_stock: '❌ OOS',
          pre_order:    '🔜 Pre-order',
        }[p.stockStatus] ?? p.stockStatus;

        console.log(`\n[${i + 1}] ${p.name}`);
        if (p.brand) console.log(`    Brand:  ${p.brand}`);
        console.log(`    SKU:    ${p.sku}`);
        console.log(`    Price:  ${p.price}${p.regularPrice ? ` (was ${p.regularPrice})` : ''}`);
        console.log(`    Status: ${statusLabel}`);
        if (p.releaseDate) console.log(`    Release: ${p.releaseDate}`);
        console.log(`    URL:    ${p.url}`);
      });
      console.log(`\n${'─'.repeat(70)}`);
    })
    .catch(err => {
      console.error('[GameStop] Fatal:', err.message);
      process.exit(1);
    });
}

module.exports = {
  scrapeGameStop,
  normalizeJsonProduct,
  parseHtmlProducts,
  getStockStatusFromJson,
  isPokemonProduct,
};
