/**
 * Best Buy scraper — two-mode design:
 *
 * Mode 1 (API):  Uses the official Best Buy Products API when BESTBUY_API_KEY is set.
 *   Free key at https://developer.bestbuy.com — instant approval, no review needed.
 *   Most reliable: full stock signals, pricing, pagination, and category filtering.
 *
 * Mode 2 (HTML): Falls back to scraping bestbuy.com search pages with Cheerio when
 *   no API key is configured. Products are server-rendered as static HTML tiles.
 *   Stock status is derived from button state (Add to Cart vs. Sold Out).
 *   If selectors break after a Best Buy redesign, open a Best Buy search page in
 *   DevTools and update the HTML_SELECTORS block below.
 *
 * API stock fields:
 *   onlineAvailability     — true when available for online purchase
 *   inStoreAvailability    — true when available in stores
 *   preorderable           — true when item can be pre-ordered
 *   onlineAvailabilityText — 'Available' | 'Sold Out' | 'Coming Soon'
 *
 * HTML stock signals (fallback):
 *   button.add-to-cart-button present and not disabled → in_stock
 *   'Sold Out' text or button absent/disabled          → out_of_stock
 *   'Pre-Order Now' button text                        → pre_order
 */

const axios   = require('axios');
const cheerio = require('cheerio');
const config  = require('../config');
const { withRetry, sleep, throwIfAborted } = require('../utils/retry');

// ── Constants ─────────────────────────────────────────────────────────────────

const API_BASE   = 'https://api.bestbuy.com/v1/products';
const HTML_BASE  = 'https://www.bestbuy.com';
const PAGE_SIZE  = 100;  // max allowed by the Products API
const DELAY_MS   = 1000;
const MAX_RETRIES = 3;
const HTML_FALLBACK_TIMEOUT_MS = parseInt(process.env.BESTBUY_HTML_TIMEOUT_MS || '8000', 10);
const HTML_FALLBACK_MAX_ATTEMPTS = parseInt(process.env.BESTBUY_HTML_MAX_ATTEMPTS || '1', 10);

// Fields requested from the Products API — extend here if more data is needed.
const API_SHOW_FIELDS = [
  'sku', 'name', 'manufacturer', 'salePrice', 'regularPrice', 'url',
  'addToCartUrl', 'onlineAvailability', 'onlineAvailabilityText',
  'inStoreAvailability', 'preorderable', 'releaseDate',
].join(',');

// HTML selectors for fallback mode — update if Best Buy redesigns their pages.
const HTML_SELECTORS = {
  productItem:   'li.sku-item',
  title:         '.sku-title a, h4.sku-header a',
  price:         '.priceView-customer-price span[aria-hidden="true"]',
  regularPrice:  '.pricing-price__regular-price, .priceView-layout-large .pricing-price__regular-price',
  addToCart:     'button.add-to-cart-button',
  soldOut:       '.btn-disabled, .fulfillment-fulfillment-summary',
};

// Search terms used in HTML fallback mode; keyword used in API mode comes from config.
const HTML_KEYWORDS = [
  'pokemon trading card game',
  'pokemon booster pack',
  'pokemon elite trainer box',
];

const BASE_HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection':      'keep-alive',
};

// ── Shared utilities ──────────────────────────────────────────────────────────

function isPokemonProduct(name) {
  const lower = (name ?? '').toLowerCase();
  return lower.includes('pokemon') || lower.includes('pokémon');
}

function formatPrice(numeric) {
  return numeric != null ? `$${Number(numeric).toFixed(2)}` : 'N/A';
}

// ── Mode 1: Official Products API ─────────────────────────────────────────────

async function fetchApiPage(apiKey, query, page, signal) {
  return withRetry(
    async () => {
      try {
        const res = await axios.get(`${API_BASE}${query}`, {
          params:  { apiKey, format: 'json', pageSize: PAGE_SIZE, page, show: API_SHOW_FIELDS, sort: 'bestsellersRank.asc' },
          headers: { Accept: 'application/json' },
          timeout: 25000,
          signal,
        });
        return res.data;
      } catch (err) {
        const status = err.response?.status;
        if (status === 403) {
          const e = new Error('[Best Buy] API key rejected (403). Check BESTBUY_API_KEY.');
          e.permanent = true;
          throw e;
        }
        if (status === 400) {
          const msg = err.response?.data?.error?.message ?? 'Bad Request';
          const e   = new Error(`[Best Buy] API 400: ${msg}`);
          e.permanent = true;
          throw e;
        }
        throw err;
      }
    },
    {
      maxAttempts: MAX_RETRIES,
      baseDelayMs: 2000,
      isRetryable(err) {
        if (err.permanent) return false;
        const status = err.response?.status;
        return !status || status >= 500 || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT';
      },
      onRetry(err, attempt, delayMs) {
        console.warn(`[Best Buy] API attempt ${attempt} failed (${err.message}) — retrying in ${delayMs / 1000}s…`);
      },
      signal,
    },
  );
}

function getStockStatusFromApi(item) {
  if (item.preorderable === true) return 'pre_order';
  const text = (item.onlineAvailabilityText ?? '').toLowerCase();
  if (text.includes('coming soon') || text.includes('pre-order')) return 'pre_order';
  if (item.onlineAvailability === true || item.inStoreAvailability === true) return 'in_stock';
  return 'out_of_stock';
}

function normalizeApiItem(item) {
  const stockStatus   = getStockStatusFromApi(item);
  const saleNumeric   = item.salePrice != null ? Number(item.salePrice) : null;
  const regNumeric    = item.regularPrice != null ? Number(item.regularPrice) : null;

  const regularPrice = (regNumeric != null && regNumeric !== saleNumeric)
    ? formatPrice(regNumeric)
    : null;

  return {
    id:           `bestbuy-${item.sku}`,
    retailer:     'bestbuy',
    sku:          String(item.sku),
    name:         item.name ?? '',
    brand:        item.manufacturer ?? null,
    price:        formatPrice(saleNumeric),
    priceNumeric: saleNumeric,
    regularPrice,
    url:          item.url ?? `${HTML_BASE}/site/-/${item.sku}.p`,
    inStock:      stockStatus === 'in_stock',
    stockStatus,  // 'in_stock' | 'out_of_stock' | 'pre_order'
    releaseDate:  item.releaseDate ?? null,
  };
}

async function scrapeViaApi(apiKey, signal) {
  const products = [];
  const seen     = new Set();

  for (const keyword of config.retailers.bestbuy.keywords) {
    // Best Buy query DSL wraps the search term in parentheses
    const query      = `(search=${encodeURIComponent(keyword)})`;
    let   currentPage = 1;
    let   totalPages  = Infinity;

    console.log(`[Best Buy] API — searching: "${keyword}"`);

    while (currentPage <= totalPages && currentPage <= config.maxPages) {
      throwIfAborted(signal);
      let data;
      try {
        data = await fetchApiPage(apiKey, query, currentPage, signal);
      } catch (err) {
        console.error(`[Best Buy] API error on "${keyword}" page ${currentPage}: ${err.message}`);
        break;
      }

      const items = data?.products ?? [];
      if (currentPage === 1) {
        totalPages = data?.totalPages ?? 1;
        console.log(`[Best Buy] "${keyword}": ${data?.total ?? '?'} results, ${totalPages} pages`);
      }

      if (items.length === 0) {
        console.log(`[Best Buy] Empty page for "${keyword}" page ${currentPage} — stopping`);
        break;
      }

      let newCount  = 0;
      let skipCount = 0;

      for (const item of items) {
        const sku = item.sku;
        if (!sku || seen.has(sku)) continue;
        seen.add(sku);

        if (!isPokemonProduct(item.name)) {
          skipCount++;
          continue;
        }

        products.push(normalizeApiItem(item));
        newCount++;
      }

      console.log(
        `[Best Buy] "${keyword}" page ${currentPage}/${Math.min(totalPages, config.maxPages)}: ` +
        `${items.length} items → ${newCount} added, ${skipCount} non-Pokemon skipped`,
      );

      currentPage++;
      if (currentPage <= totalPages && currentPage <= config.maxPages) await sleep(DELAY_MS, signal);
    }

    const kwIdx = config.retailers.bestbuy.keywords.indexOf(keyword);
    if (kwIdx < config.retailers.bestbuy.keywords.length - 1) await sleep(DELAY_MS * 2, signal);
  }

  return products;
}

// ── Mode 2: HTML / Cheerio fallback ──────────────────────────────────────────

async function fetchHtmlPage(keyword, page, signal) {
  const url = `${HTML_BASE}/site/searchpage.jsp`;
  return withRetry(
    async () => {
      const res = await axios.get(url, {
        params:     { st: keyword, cp: page },
        headers:    { ...BASE_HEADERS, Referer: `${HTML_BASE}/` },
        timeout:    HTML_FALLBACK_TIMEOUT_MS,
        signal,
        decompress: true,
      });
      return res.data;
    },
    {
      maxAttempts: HTML_FALLBACK_MAX_ATTEMPTS,
      baseDelayMs: 2000,
      isRetryable(err) {
        const status = err.response?.status;
        return status === 429 || !status || status >= 500 || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT';
      },
      getDelay(err, attempt, baseDelayMs) {
        if (err.response?.status === 429) return 6000 * (2 ** (attempt - 1));
        return baseDelayMs * (2 ** (attempt - 1));
      },
      onRetry(err, attempt, delayMs) {
        if (err.response?.status === 429) {
          console.warn(`[Best Buy] HTML rate limited (429) — backing off ${delayMs / 1000}s…`);
        } else {
          console.warn(`[Best Buy] HTML attempt ${attempt} failed (${err.message}) — retrying in ${delayMs / 1000}s…`);
        }
      },
      signal,
    },
  );
}

function extractSkuFromUrl(href) {
  // Best Buy product URLs end in /SKU.p?skuId=SKU
  const match = href.match(/\/(\d+)\.p/);
  return match ? match[1] : null;
}

function getStockStatusFromHtml($, $item) {
  const btnText = $item.find(HTML_SELECTORS.addToCart).text().trim().toLowerCase();
  if (!btnText) return 'out_of_stock';
  if (btnText.includes('pre-order') || btnText.includes('pre order')) return 'pre_order';
  if ($item.find(HTML_SELECTORS.addToCart).is(':disabled, .btn-disabled')) return 'out_of_stock';
  if (btnText.includes('add to cart') || btnText.includes('shop now')) return 'in_stock';
  // Sold-out signal can also appear as a label rather than a button
  const summaryText = $item.find(HTML_SELECTORS.soldOut).text().toLowerCase();
  if (summaryText.includes('sold out') || summaryText.includes('unavailable')) return 'out_of_stock';
  return 'out_of_stock'; // conservative default when button state is ambiguous
}

function parsePriceText(text) {
  if (!text) return null;
  const cleaned = text.replace(/[^0-9.]/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

function parseHtmlProducts(html, seen) {
  const $        = cheerio.load(html);
  const products = [];

  $('li.sku-item').each((_, el) => {
    const $item = $(el);

    const titleEl  = $item.find(HTML_SELECTORS.title).first();
    const name     = titleEl.text().trim();
    const href     = titleEl.attr('href') ?? '';
    if (!name || !isPokemonProduct(name)) return;

    const sku = extractSkuFromUrl(href) ?? $item.attr('data-sku-id') ?? $item.attr('data-listing-id');
    if (!sku || seen.has(sku)) return;
    seen.add(sku);

    const priceText   = $item.find(HTML_SELECTORS.price).first().text().trim();
    const regPriceEl  = $item.find(HTML_SELECTORS.regularPrice).first().text().trim();
    const saleNumeric = parsePriceText(priceText);
    const regNumeric  = parsePriceText(regPriceEl);
    const stockStatus = getStockStatusFromHtml($, $item);

    const url = href.startsWith('http') ? href : `${HTML_BASE}${href}`;

    const regularPrice = (regNumeric != null && regNumeric !== saleNumeric)
      ? formatPrice(regNumeric)
      : null;

    products.push({
      id:           `bestbuy-${sku}`,
      retailer:     'bestbuy',
      sku,
      name,
      brand:        null,  // not reliably present in search result tiles
      price:        formatPrice(saleNumeric),
      priceNumeric: saleNumeric,
      regularPrice,
      url,
      inStock:      stockStatus === 'in_stock',
      stockStatus,
      releaseDate:  null,
    });
  });

  return products;
}

function hasNextPage(html) {
  const $ = cheerio.load(html);
  return $('a.sku-list-page-next, [data-testid="pagination-next"]:not([disabled])').length > 0;
}

async function scrapeViaHtml(signal) {
  const products = [];
  const seen     = new Set();

  console.log(`[Best Buy] No API key — using capped HTML fallback (${HTML_FALLBACK_TIMEOUT_MS}ms, ${HTML_FALLBACK_MAX_ATTEMPTS} attempt)`);

  for (const keyword of HTML_KEYWORDS.slice(0, 1)) {
    let page = 1;
    console.log(`[Best Buy] HTML — searching: "${keyword}"`);

    while (page <= config.maxPages) {
      throwIfAborted(signal);
      let html;
      try {
        html = await fetchHtmlPage(keyword, page, signal);
      } catch (err) {
        console.error(`[Best Buy] HTML fetch failed on "${keyword}" page ${page}: ${err.message}`);
        err.sourceStatus = err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT' ? 'timeout' : 'blocked';
        throw err;
      }

      const pageProducts = parseHtmlProducts(html, seen);

      let newCount = 0;
      for (const p of pageProducts) {
        products.push(p);
        newCount++;
      }

      const more = hasNextPage(html);
      console.log(
        `[Best Buy] "${keyword}" page ${page}: ${pageProducts.length} products added` +
        (more ? '' : ' (last page)'),
      );

      if (!more || pageProducts.length === 0) break;

      page++;
      await sleep(DELAY_MS * 2, signal);  // be gentler without an API key
    }

    const kwIdx = HTML_KEYWORDS.indexOf(keyword);
    if (kwIdx < HTML_KEYWORDS.length - 1) await sleep(DELAY_MS * 3, signal);
  }

  return products;
}

// ── Main scraper ──────────────────────────────────────────────────────────────

async function scrapeBestBuy({ signal } = {}) {
  const apiKey = config.retailers.bestbuy.apiKey;

  let products;
  if (apiKey) {
    console.log('[Best Buy] Starting — API mode');
    products = await scrapeViaApi(apiKey, signal);
  } else {
    console.log('[Best Buy] Starting — HTML fallback mode (set BESTBUY_API_KEY for better results)');
    products = await scrapeViaHtml(signal);
  }

  const inStock    = products.filter(p => p.stockStatus === 'in_stock').length;
  const outOfStock = products.filter(p => p.stockStatus === 'out_of_stock').length;
  const preOrder   = products.filter(p => p.stockStatus === 'pre_order').length;

  console.log(
    `[Best Buy] Done: ${products.length} products ` +
    `(${inStock} in-stock, ${outOfStock} OOS, ${preOrder} pre-order)`,
  );

  return products;
}

// ── CLI ───────────────────────────────────────────────────────────────────────
// node scrapers/bestbuy.js            → run and show 5 sample products
// node scrapers/bestbuy.js --all      → show all products
// node scrapers/bestbuy.js --json     → output raw JSON

if (require.main === module) {
  const args    = process.argv.slice(2);
  const showAll = args.includes('--all');
  const asJson  = args.includes('--json');

  scrapeBestBuy()
    .then(products => {
      if (asJson) {
        console.log(JSON.stringify(products, null, 2));
        return;
      }

      const sample = showAll ? products : products.slice(0, 5);

      console.log(`\n${'─'.repeat(70)}`);
      console.log(`Best Buy Pokemon TCG — ${sample.length} of ${products.length} products shown`);
      console.log(`  In-stock:     ${products.filter(p => p.stockStatus === 'in_stock').length}`);
      console.log(`  Out-of-stock: ${products.filter(p => p.stockStatus === 'out_of_stock').length}`);
      console.log(`  Pre-order:    ${products.filter(p => p.stockStatus === 'pre_order').length}`);
      console.log('─'.repeat(70));

      if (sample.length === 0) {
        console.log('\nNo products found.');
        console.log('HTML mode tip: Best Buy may be blocking the request. Try setting BESTBUY_API_KEY.');
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
      console.error('[Best Buy] Fatal:', err.message);
      process.exit(1);
    });
}

module.exports = {
  scrapeBestBuy,
  getStockStatusFromApi,
  normalizeApiItem,
  parseHtmlProducts,
  isPokemonProduct,
};
