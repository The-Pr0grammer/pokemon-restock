const axios = require('axios');
const config = require('../config');
const { throwIfAborted } = require('../utils/retry');
const club = require('./clubstore');

const SAMS_BASE = 'https://www.samsclub.com';
const SEARCH_URLS = [
  `${SAMS_BASE}/browse/Pokemon/16860219?facet=fulfillment_method%3ADelivery&sort=relevance`,
  `${SAMS_BASE}/s/pokemon%20trading%20card`,
];

const HEADERS = {
  ...config.requestHeaders,
  Referer: SAMS_BASE + '/',
};

async function fetchPage(url, signal) {
  const res = await axios.get(url, {
    headers: HEADERS,
    timeout: 15000,
    signal,
  });
  return res.data;
}

function parseNextData(html) {
  const match = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

function walk(value, visit) {
  if (!value || typeof value !== 'object') return;
  visit(value);
  if (Array.isArray(value)) {
    for (const entry of value) walk(entry, visit);
    return;
  }
  for (const entry of Object.values(value)) walk(entry, visit);
}

function extractItems(nextData) {
  const items = [];
  const seen = new Set();
  walk(nextData, value => {
    const id = value.productId || value.usItemId || value.itemId || value.id;
    const name = value.name || value.productName || value.title;
    if (!id || !name || seen.has(id)) return;
    if (!club.isPokemonProduct(name)) return;
    seen.add(id);
    items.push(value);
  });
  return items;
}

function normalizeSamsClubItem(item) {
  const name = item.name || item.productName || item.title || '';
  const details = item.description || item.shortDescription || item.productDescription || '';
  const priceNumeric = Number(item.price) || club.parsePrice(item.priceInfo?.linePrice || item.displayPrice || item.currentPrice?.priceString);
  const stockStatus = club.inferStockStatus(`${item.availabilityStatus || ''} ${item.fulfillmentText || ''} ${item.shippingText || ''} ${details}`);
  const rawId = item.productId || item.usItemId || item.itemId || item.id;
  const path = item.canonicalUrl || item.productUrl || item.url || `/s/${encodeURIComponent(name)}`;
  const bundleComponents = club.buildBundleComponents(name, details);

  return {
    id: club.stableId('samsclub', rawId, name),
    retailer: 'samsclub',
    itemNumber: rawId ? String(rawId) : null,
    name,
    brand: item.brand || item.brandName || 'Pokemon',
    price: priceNumeric != null ? `$${priceNumeric.toFixed(2)}` : 'N/A',
    priceNumeric,
    regularPrice: null,
    url: new URL(path, SAMS_BASE).toString(),
    inStock: stockStatus === 'in_stock',
    stockStatus,
    sellerName: "Sam's Club",
    sellerType: 'first_party',
    membershipRequired: true,
    productKind: club.inferProductKind(name, details),
    bundleComponents,
    quantity: bundleComponents.reduce((sum, c) => sum + (Number.isFinite(c.quantity) ? c.quantity : 0), 0) || null,
    unitAcquisitionPrice: club.unitAcquisitionPrice(priceNumeric, bundleComponents),
    fulfillment: club.inferFulfillment(`${item.fulfillmentText || ''} ${item.shippingText || ''} ${details}`),
  };
}

function isSamsClubTcgItem(item) {
  return club.isTcgProduct(item.name || item.productName || item.title, item.description || item.shortDescription);
}

function dedupe(products) {
  const seen = new Set();
  return products.filter(product => {
    if (!product.id || seen.has(product.id)) return false;
    seen.add(product.id);
    return true;
  });
}

async function scrapeSamsClub({ signal } = {}) {
  console.log('[Sam\'s Club] Starting Pokemon TCG club-store scrape');
  const products = [];

  for (const url of SEARCH_URLS.slice(0, config.maxPages)) {
    throwIfAborted(signal);
    const html = await fetchPage(url, signal);
    const nextData = parseNextData(html);
    if (!nextData) continue;
    products.push(...extractItems(nextData).filter(isSamsClubTcgItem).map(normalizeSamsClubItem));
  }

  const filtered = dedupe(products);
  if (!filtered.length) {
    const err = new Error('[Sam\'s Club] No Pokemon TCG products parsed from public pages');
    err.sourceStatus = 'parser_stale';
    throw err;
  }

  console.log(`[Sam's Club] Done: ${filtered.length} product(s)`);
  return filtered;
}

if (require.main === module) {
  scrapeSamsClub()
    .then(products => console.log(JSON.stringify(products, null, 2)))
    .catch(err => {
      console.error('[Sam\'s Club] Fatal:', err.message);
      process.exit(1);
    });
}

module.exports = {
  scrapeSamsClub,
  parseNextData,
  extractItems,
  isSamsClubTcgItem,
  normalizeSamsClubItem,
};
