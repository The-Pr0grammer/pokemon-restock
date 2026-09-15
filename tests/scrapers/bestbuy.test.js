const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  scrapeBestBuy,
  getStockStatusFromApi,
  normalizeApiItem,
  parseHtmlProducts,
  isPokemonProduct,
} = require('../../scrapers/bestbuy');

const makeApiItem = (overrides = {}) => ({
  sku: 6482492,
  name: 'Pokemon Trading Card Game: Scarlet & Violet ETB',
  manufacturer: 'The Pokemon Company',
  salePrice: 49.99,
  regularPrice: 49.99,
  url: 'https://www.bestbuy.com/site/-/6482492.p',
  onlineAvailability: true,
  onlineAvailabilityText: 'Available',
  inStoreAvailability: true,
  preorderable: false,
  releaseDate: null,
  ...overrides,
});

describe('Best Buy scraper — getStockStatusFromApi', () => {
  it('returns in_stock when onlineAvailability is true', () => {
    assert.equal(getStockStatusFromApi(makeApiItem()), 'in_stock');
  });

  it('returns in_stock when only inStoreAvailability is true', () => {
    assert.equal(getStockStatusFromApi(makeApiItem({ onlineAvailability: false })), 'in_stock');
  });

  it('returns pre_order when preorderable is true', () => {
    assert.equal(getStockStatusFromApi(makeApiItem({ preorderable: true })), 'pre_order');
  });

  it('returns pre_order from onlineAvailabilityText "Coming Soon"', () => {
    assert.equal(
      getStockStatusFromApi(makeApiItem({ onlineAvailability: false, inStoreAvailability: false, onlineAvailabilityText: 'Coming Soon' })),
      'pre_order',
    );
  });

  it('returns out_of_stock when not available anywhere', () => {
    assert.equal(
      getStockStatusFromApi(makeApiItem({ onlineAvailability: false, inStoreAvailability: false, onlineAvailabilityText: 'Sold Out' })),
      'out_of_stock',
    );
  });
});

describe('Best Buy scraper — access gate', () => {
  it('fails fast as credentials_missing when no API key is configured', async () => {
    await assert.rejects(
      () => scrapeBestBuy(),
      err => err.sourceStatus === 'credentials_missing' && err.message === 'Missing BESTBUY_API_KEY',
    );
  });
});

describe('Best Buy scraper — normalizeApiItem', () => {
  it('produces correct shape for in-stock item', () => {
    const p = normalizeApiItem(makeApiItem());
    assert.equal(p.id, 'bestbuy-6482492');
    assert.equal(p.retailer, 'bestbuy');
    assert.equal(p.sku, '6482492');
    assert.equal(p.name, 'Pokemon Trading Card Game: Scarlet & Violet ETB');
    assert.equal(p.brand, 'The Pokemon Company');
    assert.equal(p.price, '$49.99');
    assert.equal(p.priceNumeric, 49.99);
    assert.equal(p.regularPrice, null);   // same as salePrice
    assert.equal(p.inStock, true);
    assert.equal(p.stockStatus, 'in_stock');
  });

  it('shows regularPrice when salePrice differs', () => {
    const p = normalizeApiItem(makeApiItem({ salePrice: 39.99, regularPrice: 49.99 }));
    assert.equal(p.price, '$39.99');
    assert.equal(p.regularPrice, '$49.99');
  });

  it('handles null salePrice gracefully', () => {
    const p = normalizeApiItem(makeApiItem({ salePrice: null }));
    assert.equal(p.price, 'N/A');
    assert.equal(p.priceNumeric, null);
  });

  it('sets releaseDate from API field', () => {
    const p = normalizeApiItem(makeApiItem({ releaseDate: '2026-03-28' }));
    assert.equal(p.releaseDate, '2026-03-28');
  });
});

describe('Best Buy scraper — parseHtmlProducts', () => {
  function makeBestBuyHtml({ buttonText = 'Add to Cart', sku = '9876543' } = {}) {
    return `<html><body><ol>
      <li class="sku-item" data-sku-id="${sku}">
        <div class="sku-title">
          <a href="/site/pokemon-tcg-etb/${sku}.p?skuId=${sku}">Pokemon TCG Elite Trainer Box</a>
        </div>
        <div class="priceView-customer-price">
          <span aria-hidden="true">$49.99</span>
        </div>
        <button class="add-to-cart-button">${buttonText}</button>
      </li>
      <li class="sku-item" data-sku-id="1111111">
        <div class="sku-title">
          <a href="/site/board-game/1111111.p">Monopoly Classic Edition</a>
        </div>
        <div class="priceView-customer-price">
          <span aria-hidden="true">$19.99</span>
        </div>
        <button class="add-to-cart-button">Add to Cart</button>
      </li>
    </ol></body></html>`;
  }

  it('extracts Pokemon products and skips non-Pokemon', () => {
    const seen = new Set();
    const products = parseHtmlProducts(makeBestBuyHtml(), seen);
    assert.equal(products.length, 1);
    assert.equal(products[0].name, 'Pokemon TCG Elite Trainer Box');
  });

  it('sets in_stock when Add to Cart button is present', () => {
    const products = parseHtmlProducts(makeBestBuyHtml({ buttonText: 'Add to Cart' }), new Set());
    assert.equal(products[0].stockStatus, 'in_stock');
  });

  it('sets pre_order when button says Pre-Order', () => {
    const products = parseHtmlProducts(makeBestBuyHtml({ buttonText: 'Pre-Order Now' }), new Set());
    assert.equal(products[0].stockStatus, 'pre_order');
  });

  it('deduplicates by SKU using the seen set', () => {
    const seen = new Set();
    parseHtmlProducts(makeBestBuyHtml(), seen);
    const second = parseHtmlProducts(makeBestBuyHtml(), seen);
    assert.equal(second.length, 0);  // same SKU already in seen
  });

  it('extracts price correctly', () => {
    const products = parseHtmlProducts(makeBestBuyHtml(), new Set());
    assert.equal(products[0].price, '$49.99');
    assert.equal(products[0].priceNumeric, 49.99);
  });
});

describe('Best Buy scraper — isPokemonProduct', () => {
  it('matches "pokemon" case-insensitively', () => {
    assert.equal(isPokemonProduct('Pokemon TCG Booster Pack'), true);
    assert.equal(isPokemonProduct('POKEMON Elite Trainer Box'), true);
  });

  it('matches "pokémon" with accent', () => {
    assert.equal(isPokemonProduct('Pokémon Scarlet & Violet'), true);
  });

  it('returns false for non-Pokemon items', () => {
    assert.equal(isPokemonProduct('Magic: The Gathering Booster Pack'), false);
  });
});
