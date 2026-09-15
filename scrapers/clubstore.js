const cheerio = require('cheerio');

function parsePrice(value) {
  const compact = String(value || '').replace(/,/g, '');
  const match = compact.match(/\$?\s*([0-9]+(?:\.[0-9]{1,2})?)/);
  return match ? Number(match[1]) : null;
}

function isPokemonProduct(name) {
  const lower = String(name || '').toLowerCase();
  return lower.includes('pokemon') || lower.includes('pokémon');
}

function isTcgProduct(name, details = '') {
  const text = `${name} ${details}`.toLowerCase();
  if (!isPokemonProduct(text)) return false;

  const strongTcgSignals = [
    'trading card',
    'tcg',
    'booster',
    'elite trainer',
    'etb',
    ' tin',
    'trainer box',
    'battle academy',
  ];
  if (strongTcgSignals.some(signal => text.includes(signal))) return true;

  const nonTcgSignals = [
    'book',
    'hardcover',
    'paperback',
    'storybook',
    'manual',
    'sticker',
    'crochet',
    'puzzle',
    'plush',
    'clothes',
    'boxer brief',
  ];
  if (nonTcgSignals.some(signal => text.includes(signal))) return false;

  return ['collection', 'box set'].some(signal => text.includes(signal));
}

function inferStockStatus(text) {
  const lower = String(text || '').toLowerCase();
  if (/out of stock|sold out|unavailable|item not available/.test(lower)) return 'out_of_stock';
  if (/pre[-\s]?order/.test(lower)) return 'pre_order';
  if (/add to cart|available|shipping|delivery|pickup|in stock/.test(lower)) return 'in_stock';
  return 'unknown';
}

function inferFulfillment(text) {
  const lower = String(text || '').toLowerCase();
  return {
    shipping: /shipping|delivery|ship/.test(lower) ? inferStockStatus(lower) : null,
    pickup: /pickup|warehouse|club/.test(lower) ? inferStockStatus(lower) : null,
    same_day: /same[-\s]?day/.test(lower) ? inferStockStatus(lower) : null,
    in_store_only: /warehouse only|club only|in[-\s]?club only|in store only/.test(lower),
  };
}

function extractBoosterPackCount(text) {
  const match = String(text || '').match(/\((\d+)\)\s*(?:pokemon|pokémon)?\s*(?:tcg)?\s*booster packs?/i)
    || String(text || '').match(/\b(\d+)\s*(?:pokemon|pokémon)?\s*(?:tcg)?\s*booster packs?\b/i);
  return match ? Number(match[1]) : null;
}

function inferProductKind(name, details = '') {
  const text = `${name} ${details}`.toLowerCase();
  if (/elite trainer|\betb\b/.test(text)) return 'ETB_BUNDLE';
  if (/booster box/.test(text)) return 'BOOSTER_BOX';
  if (/booster bundle/.test(text)) return 'BOOSTER_BUNDLE';
  if (/\btins?\b/.test(text)) return 'TIN_BUNDLE';
  if (/collection/.test(text)) return 'COLLECTION_BUNDLE';
  if (/booster pack/.test(text)) return 'BOOSTER_PACK_BUNDLE';
  return 'CLUB_BUNDLE';
}

function buildBundleComponents(name, details) {
  const text = `${name} ${details}`;
  const boosterPacks = extractBoosterPackCount(text);
  const components = [];
  if (boosterPacks) {
    components.push({ type: 'booster_pack', quantity: boosterPacks, description: `${boosterPacks} booster packs` });
  }
  if (/\btins?\b/i.test(text)) {
    components.push({ type: 'tin', quantity: null, description: 'Tin component present; exact count may require product-page verification' });
  }
  if (/promo/i.test(text)) {
    components.push({ type: 'promo_card', quantity: null, description: 'Promo-card component present; exact count may require product-page verification' });
  }
  return components;
}

function unitAcquisitionPrice(priceNumeric, components) {
  const booster = components.find(c => c.type === 'booster_pack' && Number.isFinite(c.quantity) && c.quantity > 0);
  if (!booster || !Number.isFinite(priceNumeric)) return null;
  return Number((priceNumeric / booster.quantity).toFixed(2));
}

function readJsonLdProducts(html) {
  const $ = cheerio.load(html);
  const products = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    const text = $(el).contents().text();
    if (!text.trim()) return;
    try {
      const parsed = JSON.parse(text);
      const nodes = Array.isArray(parsed) ? parsed : [parsed];
      for (const node of nodes) {
        if (node?.['@type'] === 'Product') products.push(node);
        if (Array.isArray(node?.['@graph'])) {
          products.push(...node['@graph'].filter(entry => entry?.['@type'] === 'Product'));
        }
      }
    } catch {
      // Ignore malformed JSON-LD blocks; page-specific extractors can still work.
    }
  });
  return products;
}

function stableId(retailer, rawId, name) {
  const base = rawId || String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${retailer}-${base}`;
}

module.exports = {
  parsePrice,
  isPokemonProduct,
  isTcgProduct,
  inferStockStatus,
  inferFulfillment,
  inferProductKind,
  buildBundleComponents,
  unitAcquisitionPrice,
  readJsonLdProducts,
  stableId,
};
