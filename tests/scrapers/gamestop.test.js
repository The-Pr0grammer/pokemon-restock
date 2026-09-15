const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeJsonProduct,
  parseHtmlProducts,
  isPokemonTcgProduct,
  extractJsonPrices,
} = require('../../scrapers/gamestop');

describe('GameStop scraper', () => {
  it('keeps TCG products and rejects non-card Pokemon merchandise', () => {
    assert.equal(isPokemonTcgProduct('Pokemon TCG: Scarlet & Violet Booster Bundle'), true);
    assert.equal(isPokemonTcgProduct('Pokemon Elite Trainer Box'), true);
    assert.equal(isPokemonTcgProduct('Pokemon Legends: Z-A Nintendo Switch 2 Edition'), false);
    assert.equal(isPokemonTcgProduct('Pokemon Pikachu Plush'), false);
  });

  it('preserves public and member pricing from JSON products', () => {
    const prices = extractJsonPrices({
      salePrice: 49.99,
      memberPrice: 44.99,
      originalPrice: 59.99,
    });

    assert.deepEqual(prices, {
      publicPrice: 49.99,
      memberPrice: 44.99,
      regularPrice: 59.99,
    });
  });

  it('normalizes JSON products with first-party and member price fields', () => {
    const product = normalizeJsonProduct({
      sku: '416667',
      productName: 'Pokemon TCG: Elite Trainer Box',
      salePrice: 49.99,
      memberPrice: 44.99,
      availability: 'available',
      productUrl: '/products/pokemon-tcg-etb/416667.html',
    });

    assert.equal(product.id, 'gamestop-416667');
    assert.equal(product.retailer, 'gamestop');
    assert.equal(product.sellerType, 'first_party');
    assert.equal(product.publicPrice, 49.99);
    assert.equal(product.memberPrice, 44.99);
    assert.equal(product.priceNumeric, 49.99);
    assert.equal(product.stockStatus, 'in_stock');
    assert.equal(product.productKind, 'ETB');
  });

  it('parses HTML products while rejecting non-TCG Pokemon results', () => {
    const html = `
      <ul>
        <li class="product-card" data-sku-id="card-1">
          <h4><a href="/products/pokemon-booster/111.html">Pokemon TCG Booster Bundle</a></h4>
          <div class="price-con"><span class="current-price">$26.99</span></div>
          <button class="add-to-cart">Add to Cart</button>
        </li>
        <li class="product-card" data-sku-id="game-1">
          <h4><a href="/products/pokemon-game/222.html">Pokemon Legends Nintendo Switch Game</a></h4>
          <div class="price-con"><span class="current-price">$69.99</span></div>
          <button class="add-to-cart">Add to Cart</button>
        </li>
      </ul>
    `;

    const products = parseHtmlProducts(html, new Set());
    assert.equal(products.length, 1);
    assert.equal(products[0].sku, '111');
    assert.equal(products[0].publicPrice, 26.99);
    assert.equal(products[0].stockStatus, 'in_stock');
  });
});
