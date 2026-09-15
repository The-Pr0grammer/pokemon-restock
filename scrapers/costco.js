const axios = require('axios');
const cheerio = require('cheerio');
const config = require('../config');
const { throwIfAborted } = require('../utils/retry');
const club = require('./clubstore');

const COSTCO_BASE = 'https://www.costco.com';
const SEARCH_URLS = [
  `${COSTCO_BASE}/trading-cards.html?currentPage=1`,
  `${COSTCO_BASE}/CatalogSearch?keyword=pokemon%20trading%20card`,
];

const HEADERS = {
  ...config.requestHeaders,
  Referer: COSTCO_BASE + '/',
};

async function fetchPage(url, signal) {
  const res = await axios.get(url, {
    headers: HEADERS,
    timeout: 15000,
    signal,
  });
  return res.data;
}

function normalizeCostcoProduct(raw, sourceUrl = COSTCO_BASE) {
  const name = raw.name || raw.title || '';
  const details = raw.description || raw.details || '';
  const priceNumeric = raw.priceNumeric ?? club.parsePrice(raw.offers?.price ?? raw.price);
  const stockStatus = raw.stockStatus || club.inferStockStatus(`${raw.availability || ''} ${details}`);
  const itemNumber = raw.itemNumber || raw.sku || raw.productID || raw.id || null;
  const url = raw.url
    ? new URL(raw.url, COSTCO_BASE).toString()
    : sourceUrl;
  const bundleComponents = club.buildBundleComponents(name, details);

  return {
    id: club.stableId('costco', itemNumber, name),
    retailer: 'costco',
    itemNumber: itemNumber ? String(itemNumber) : null,
    name,
    brand: raw.brand?.name || raw.brand || 'Pokemon',
    price: priceNumeric != null ? `$${priceNumeric.toFixed(2)}` : 'N/A',
    priceNumeric,
    regularPrice: null,
    url,
    inStock: stockStatus === 'in_stock',
    stockStatus,
    sellerName: 'Costco',
    sellerType: 'first_party',
    membershipRequired: true,
    productKind: club.inferProductKind(name, details),
    bundleComponents,
    quantity: bundleComponents.reduce((sum, c) => sum + (Number.isFinite(c.quantity) ? c.quantity : 0), 0) || null,
    unitAcquisitionPrice: club.unitAcquisitionPrice(priceNumeric, bundleComponents),
    fulfillment: club.inferFulfillment(`${raw.availability || ''} ${details}`),
  };
}

function productsFromJsonLd(html, sourceUrl) {
  return club.readJsonLdProducts(html)
    .filter(product => club.isTcgProduct(product.name, product.description))
    .map(product => normalizeCostcoProduct(product, sourceUrl));
}

function productsFromComparePage(html, sourceUrl) {
  const $ = cheerio.load(html);
  const text = $('body').text().replace(/\s+/g, ' ');
  const title = $('h1, h2').toArray()
    .map(el => $(el).text().trim())
    .find(value => club.isTcgProduct(value, text));
  if (!title) return [];

  const itemMatch = text.match(/\bItem\s+([0-9A-Z-]+)/i) || sourceUrl.match(/partNumbers=([^&]+)/i);
  return [normalizeCostcoProduct({
    name: title,
    details: text,
    priceNumeric: club.parsePrice(text),
    itemNumber: itemMatch?.[1] || null,
    url: sourceUrl,
  }, sourceUrl)];
}

function dedupe(products) {
  const seen = new Set();
  return products.filter(product => {
    if (!product.id || seen.has(product.id)) return false;
    seen.add(product.id);
    return true;
  });
}

async function scrapeCostco({ signal } = {}) {
  console.log('[Costco] Starting Pokemon TCG club-store scrape');
  const products = [];

  for (const url of SEARCH_URLS.slice(0, config.maxPages)) {
    throwIfAborted(signal);
    const html = await fetchPage(url, signal);
    products.push(...productsFromJsonLd(html, url));
    products.push(...productsFromComparePage(html, url));
  }

  const filtered = dedupe(products).filter(product => club.isTcgProduct(product.name, JSON.stringify(product.bundleComponents)));
  if (!filtered.length) {
    const err = new Error('[Costco] No Pokemon TCG club-store products parsed from public pages');
    err.sourceStatus = 'parser_stale';
    throw err;
  }

  console.log(`[Costco] Done: ${filtered.length} product(s)`);
  return filtered;
}

if (require.main === module) {
  scrapeCostco()
    .then(products => console.log(JSON.stringify(products, null, 2)))
    .catch(err => {
      console.error('[Costco] Fatal:', err.message);
      process.exit(1);
    });
}

module.exports = {
  scrapeCostco,
  normalizeCostcoProduct,
  productsFromJsonLd,
  productsFromComparePage,
};
