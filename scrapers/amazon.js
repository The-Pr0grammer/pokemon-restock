/**
 * Amazon scraper — uses the Product Advertising API 5.0 (PA API v5).
 *
 * Setup (free, one-time):
 *   1. Sign up at https://affiliate-program.amazon.com (Amazon Associates — free)
 *   2. After approval, visit https://affiliate-program.amazon.com/home/account/tag/manage
 *      to get your PartnerTag (e.g. "yourtag-20")
 *   3. From your Associates account, go to Tools → Product Advertising API → Manage Credentials
 *      to create an AccessKey + SecretKey pair
 *   4. Add to .env:
 *        AMAZON_ACCESS_KEY=AKIA...
 *        AMAZON_SECRET_KEY=...
 *        AMAZON_PARTNER_TAG=yourtag-20
 *
 * Note: Amazon requires 3 qualifying sales within 180 days of account creation for full
 * approval. The API works during the trial period, but the account must remain active.
 *
 * Seller filtering:
 *   Default: only items where MerchantInfo.Name === 'Amazon.com' (sold directly by Amazon).
 *   Set AMAZON_FBA_ONLY=true to also include 3rd-party FBA (fulfilled by Amazon, prime-eligible),
 *   which widens results but may include above-MSRP marketplace sellers.
 *
 * Signing:
 *   PA API v5 uses AWS Signature V4 with a non-standard 'content-encoding: amz-1.0' header.
 *   Implemented here using Node's built-in `crypto` module — no extra dependencies.
 */

const crypto = require('crypto');
const axios  = require('axios');
const config = require('../config');
const { withRetry, sleep, throwIfAborted } = require('../utils/retry');

// ── API config ─────────────────────────────────────────────────────────────────

const PAAPI_HOST      = 'webservices.amazon.com';
const PAAPI_REGION    = 'us-east-1';
const PAAPI_SERVICE   = 'ProductAdvertisingAPI';
const PAAPI_OPERATION = 'SearchItems';
const PAAPI_PATH      = `/paapi5/${PAAPI_OPERATION.toLowerCase()}`;
const PAAPI_TARGET    = `com.amazon.paapi5.v1.ProductAdvertisingAPIv1.${PAAPI_OPERATION}`;

// Amazon.com's internal merchant ID — used as a secondary check when MerchantInfo.Name is absent
const AMAZON_MERCHANT_ID = 'ATVPDKIKX0DER';

const ITEM_COUNT  = 10;   // PA API max per page
const DELAY_MS    = 1500;
const MAX_RETRIES = 3;

// Resources to request per item — only what we need for normalisation
const RESOURCES = [
  'ItemInfo.Title',
  'Offers.Listings.Price',
  'Offers.Listings.MerchantInfo',
  'Offers.Listings.DeliveryInfo.IsAmazonFulfilled',
  'Offers.Listings.DeliveryInfo.IsPrimeEligible',
  'Offers.Listings.Availability.Type',
  'Offers.Listings.Availability.Message',
  'Offers.Summaries.LowestPrice',
];

const SEARCH_KEYWORDS = [
  'Pokemon Trading Card Game',
  'Pokemon Booster Pack',
  'Pokemon Elite Trainer Box',
];

// ── AWS Signature V4 for PA API v5 ────────────────────────────────────────────

function hmac(key, message, encoding = undefined) {
  return crypto.createHmac('sha256', key).update(message).digest(encoding);
}

function sha256Hex(message) {
  return crypto.createHash('sha256').update(message).digest('hex');
}

function getSigningKey(secretKey, dateStamp) {
  const kDate    = hmac(`AWS4${secretKey}`, dateStamp);
  const kRegion  = hmac(kDate, PAAPI_REGION);
  const kService = hmac(kRegion, PAAPI_SERVICE);
  return hmac(kService, 'aws4_request');
}

/**
 * Build the Authorization header and all required headers for a PA API request.
 * Returns { headers, body } ready to pass to axios.
 */
function buildSignedRequest(accessKey, secretKey, payload) {
  const now       = new Date();
  const amzDate   = now.toISOString().replace(/[:\-]/g, '').replace(/\.\d{3}/, '');
  const dateStamp = amzDate.slice(0, 8);
  const body      = JSON.stringify(payload);
  const bodyHash  = sha256Hex(body);

  // Headers must be sorted alphabetically for canonical form
  const headers = {
    'content-encoding': 'amz-1.0',
    'content-type':     'application/json; charset=UTF-8',
    'host':             PAAPI_HOST,
    'x-amz-date':       amzDate,
    'x-amz-target':     PAAPI_TARGET,
  };

  const sortedKeys      = Object.keys(headers).sort();
  const signedHeaders   = sortedKeys.join(';');
  const canonicalHeaders = sortedKeys.map(k => `${k}:${headers[k]}`).join('\n') + '\n';

  const canonicalRequest = [
    'POST',
    PAAPI_PATH,
    '',            // no query string
    canonicalHeaders,
    signedHeaders,
    bodyHash,
  ].join('\n');

  const credScope    = `${dateStamp}/${PAAPI_REGION}/${PAAPI_SERVICE}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, credScope, sha256Hex(canonicalRequest)].join('\n');

  const signingKey  = getSigningKey(secretKey, dateStamp);
  const signature   = hmac(signingKey, stringToSign, 'hex');

  return {
    headers: {
      ...headers,
      Authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${credScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    body,
  };
}

// ── HTTP ──────────────────────────────────────────────────────────────────────

async function fetchSearchPage(accessKey, secretKey, partnerTag, keyword, itemPage, signal) {
  const payload = {
    Keywords:    keyword,
    PartnerTag:  partnerTag,
    PartnerType: 'Associates',
    Marketplace: 'www.amazon.com',
    SearchIndex: 'All',
    Resources:   RESOURCES,
    ItemCount:   ITEM_COUNT,
    ItemPage:    itemPage,
  };

  const { headers, body } = buildSignedRequest(accessKey, secretKey, payload);

  return withRetry(
    async () => {
      try {
        const res = await axios.post(`https://${PAAPI_HOST}${PAAPI_PATH}`, body, {
          headers,
          timeout: 20000,
          signal,
        });
        return res.data;
      } catch (err) {
        const status = err.response?.status;
        const detail = err.response?.data?.Errors?.[0];

        if (status === 400) {
          const msg = detail?.Message ?? 'Bad Request';
          const code = detail?.Code ?? '';
          // InvalidPartnerTag / InvalidCredentials are permanent; TooManyRequests is not
          if (code && code !== 'TooManyRequests') {
            const e = new Error(`[Amazon] 400 ${code}: ${msg}`);
            e.permanent = true;
            throw e;
          }
          throw new Error(`[Amazon] 400 ${code}: ${msg}`);
        }
        if (status === 401 || status === 403) {
          const e = new Error(`[Amazon] ${status}: Access denied — check AMAZON_ACCESS_KEY / AMAZON_SECRET_KEY`);
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
        return !status || status === 429 || status >= 500 || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT';
      },
      getDelay(err, attempt, baseDelayMs) {
        if (err.response?.status === 429) return 5000 * (2 ** (attempt - 1));
        return baseDelayMs * (2 ** (attempt - 1));
      },
      onRetry(err, attempt, delayMs) {
        console.warn(`[Amazon] Attempt ${attempt} failed (${err.message}) — retrying in ${delayMs / 1000}s…`);
      },
      signal,
    },
  );
}

// ── Seller filtering ──────────────────────────────────────────────────────────

/**
 * Returns the best (buy-box) listing for a New-condition item from the item's Offers.
 * Returns null if no qualifying listing exists.
 *
 * fbaOnly=false (default): only items sold BY Amazon.com
 * fbaOnly=true:            also include 3rd-party FBA / Prime-eligible sellers
 */
function findQualifyingListing(offers, fbaOnly) {
  const listings = offers?.Listings ?? [];
  if (!listings.length) return null;

  // PA API returns the buy-box listing first; subsequent entries are other sellers.
  // We look at the first in-stock listing that meets our seller criteria.
  for (const listing of listings) {
    const availability = listing?.Availability?.Type ?? '';
    if (availability !== 'Now' && availability !== 'Available') continue;

    const merchant  = listing?.MerchantInfo ?? {};
    const byAmazon  = merchant.Name === 'Amazon.com' || merchant.Id === AMAZON_MERCHANT_ID;
    const fbaEligible = listing?.DeliveryInfo?.IsAmazonFulfilled === true
                     && listing?.DeliveryInfo?.IsPrimeEligible   === true;

    if (byAmazon)                     return listing;
    if (fbaOnly && fbaEligible)       return listing;
  }

  // No in-stock qualifying listing found — still return any listing to detect OOS
  return listings[0] ?? null;
}

// ── Product normalisation ─────────────────────────────────────────────────────

function isPokemonProduct(name) {
  const lower = (name ?? '').toLowerCase();
  return lower.includes('pokemon') || lower.includes('pokémon');
}

function getStockStatus(item, qualifyingListing) {
  if (!item.Offers?.Listings?.length)   return 'out_of_stock';
  if (!qualifyingListing)               return 'out_of_stock';

  const availType = qualifyingListing?.Availability?.Type ?? '';
  if (availType === 'Now' || availType === 'Available') return 'in_stock';
  if (availType === 'Preorder')                         return 'pre_order';
  return 'out_of_stock';
}

function buildProductUrl(item, partnerTag) {
  const asin = item.ASIN;
  const base = item.DetailPageURL ?? `https://www.amazon.com/dp/${asin}`;
  // Append Associates tag for attribution
  const sep = base.includes('?') ? '&' : '?';
  return `${base}${sep}tag=${partnerTag}`;
}

function normalizeItem(item, qualifyingListing, partnerTag) {
  const asin        = item.ASIN;
  const name        = item?.ItemInfo?.Title?.DisplayValue ?? '';
  const stockStatus = getStockStatus(item, qualifyingListing);

  const priceAmount = qualifyingListing?.Price?.Amount
    ?? item?.Offers?.Summaries?.[0]?.LowestPrice?.Amount
    ?? null;

  const priceNumeric = priceAmount != null ? Number(priceAmount) : null;

  const merchant = qualifyingListing?.MerchantInfo ?? {};
  const byAmazon = merchant.Name === 'Amazon.com' || merchant.Id === AMAZON_MERCHANT_ID;
  const sellerInfo = byAmazon
    ? 'Amazon.com'
    : (merchant.Name ? `3P FBA: ${merchant.Name}` : 'Unknown seller');

  return {
    id:           `amazon-${asin}`,
    retailer:     'amazon',
    asin,
    name,
    brand:        null,  // not reliably surfaced in search results; use ASIN lookup if needed
    price:        priceNumeric != null ? `$${priceNumeric.toFixed(2)}` : 'N/A',
    priceNumeric,
    regularPrice: null,
    url:          buildProductUrl(item, partnerTag),
    inStock:      stockStatus === 'in_stock',
    stockStatus,
    releaseDate:  null,
    sellerInfo,   // extra field specific to Amazon — useful for audit
  };
}

// ── Main scraper ──────────────────────────────────────────────────────────────

async function scrapeAmazon({ signal } = {}) {
  const { accessKey, secretKey, partnerTag, fbaOnly } = config.retailers.amazon;

  if (!accessKey || !secretKey || !partnerTag) {
    const err = new Error('Missing AMAZON_ACCESS_KEY, AMAZON_SECRET_KEY, or AMAZON_PARTNER_TAG');
    err.code = 'CREDENTIALS_MISSING';
    throw err;
  }

  console.log(`[Amazon] Starting — seller filter: ${fbaOnly ? 'FBA/Prime-eligible' : 'Amazon.com only'}`);

  const products = [];
  const seen     = new Set();

  for (const keyword of SEARCH_KEYWORDS) {
    let page       = 1;
    let totalPages = Infinity;

    console.log(`[Amazon] Searching: "${keyword}"`);

    while (page <= Math.min(totalPages, config.maxPages, 10)) {
      throwIfAborted(signal);
      let data;
      try {
        data = await fetchSearchPage(accessKey, secretKey, partnerTag, keyword, page, signal);
      } catch (err) {
        console.error(`[Amazon] Fetch failed on "${keyword}" page ${page}: ${err.message}`);
        break;
      }

      const searchResult = data?.SearchResult ?? {};
      const items        = searchResult?.Items ?? [];
      const totalCount   = searchResult?.TotalResultCount ?? 0;

      if (page === 1) {
        totalPages = Math.ceil(totalCount / ITEM_COUNT);
        console.log(`[Amazon] "${keyword}": ${totalCount} total results, ~${totalPages} pages`);
      }

      if (!items.length) {
        console.log(`[Amazon] Empty page — stopping "${keyword}"`);
        break;
      }

      let newCount     = 0;
      let skipCount    = 0;

      for (const item of items) {
        const asin = item.ASIN;
        if (!asin || seen.has(asin)) continue;
        seen.add(asin);

        const name = item?.ItemInfo?.Title?.DisplayValue ?? '';
        if (!isPokemonProduct(name)) {
          skipCount++;
          continue;
        }

        const qualifyingListing = findQualifyingListing(item.Offers, fbaOnly);
        products.push(normalizeItem(item, qualifyingListing, partnerTag));
        newCount++;
      }

      console.log(
        `[Amazon] "${keyword}" page ${page}: ` +
        `${items.length} items → ${newCount} added, ${skipCount} non-Pokemon skipped`,
      );

      page++;
      if (page <= Math.min(totalPages, config.maxPages, 10)) await sleep(DELAY_MS, signal);
    }

    const kwIdx = SEARCH_KEYWORDS.indexOf(keyword);
    if (kwIdx < SEARCH_KEYWORDS.length - 1) await sleep(DELAY_MS * 2, signal);
  }

  const inStock    = products.filter(p => p.stockStatus === 'in_stock').length;
  const outOfStock = products.filter(p => p.stockStatus === 'out_of_stock').length;
  const preOrder   = products.filter(p => p.stockStatus === 'pre_order').length;

  console.log(
    `[Amazon] Done: ${products.length} products ` +
    `(${inStock} in-stock, ${outOfStock} OOS, ${preOrder} pre-order)`,
  );

  return products;
}

// ── CLI ───────────────────────────────────────────────────────────────────────
// node scrapers/amazon.js            → run and show 5 sample products
// node scrapers/amazon.js --all      → show all products
// node scrapers/amazon.js --json     → output raw JSON

if (require.main === module) {
  require('dotenv').config();
  const args    = process.argv.slice(2);
  const showAll = args.includes('--all');
  const asJson  = args.includes('--json');

  scrapeAmazon()
    .then(products => {
      if (asJson) {
        console.log(JSON.stringify(products, null, 2));
        return;
      }

      const sample = showAll ? products : products.slice(0, 5);

      console.log(`\n${'─'.repeat(70)}`);
      console.log(`Amazon Pokemon TCG — ${sample.length} of ${products.length} products shown`);
      console.log(`  In-stock:     ${products.filter(p => p.stockStatus === 'in_stock').length}`);
      console.log(`  Out-of-stock: ${products.filter(p => p.stockStatus === 'out_of_stock').length}`);
      console.log(`  Pre-order:    ${products.filter(p => p.stockStatus === 'pre_order').length}`);
      console.log('─'.repeat(70));

      if (!sample.length) {
        console.log('\nNo products found.');
        console.log('Check that AMAZON_ACCESS_KEY, AMAZON_SECRET_KEY, and AMAZON_PARTNER_TAG are set.');
        console.log('PA API requires an approved Amazon Associates account.');
        return;
      }

      sample.forEach((p, i) => {
        const statusLabel = {
          in_stock:     '✅ In Stock',
          out_of_stock: '❌ OOS',
          pre_order:    '🔜 Pre-order',
        }[p.stockStatus] ?? p.stockStatus;

        console.log(`\n[${i + 1}] ${p.name}`);
        console.log(`    ASIN:   ${p.asin}`);
        console.log(`    Price:  ${p.price}`);
        console.log(`    Seller: ${p.sellerInfo}`);
        console.log(`    Status: ${statusLabel}`);
        console.log(`    URL:    ${p.url}`);
      });
      console.log(`\n${'─'.repeat(70)}`);
    })
    .catch(err => {
      console.error('[Amazon] Fatal:', err.message);
      process.exit(1);
    });
}

module.exports = { scrapeAmazon, normalizeItem, findQualifyingListing, isPokemonProduct };
