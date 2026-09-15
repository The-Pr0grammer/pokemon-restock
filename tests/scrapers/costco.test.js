const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { normalizeCostcoProduct, productsFromJsonLd, productsFromComparePage } = require('../../scrapers/costco');

describe('Costco scraper', () => {
  it('normalizes club bundle economics', () => {
    const product = normalizeCostcoProduct({
      name: 'Pokemon 3-pack Paldea Partners Tins',
      price: '$56.99',
      itemNumber: '4000352232',
      details: '(15) Pokemon TCG Booster Packs. Shipping & Handling Included.',
      url: '/pokemon-3-pack.product.4000352232.html',
    });

    assert.equal(product.id, 'costco-4000352232');
    assert.equal(product.retailer, 'costco');
    assert.equal(product.sellerType, 'first_party');
    assert.equal(product.membershipRequired, true);
    assert.equal(product.quantity, 15);
    assert.equal(product.unitAcquisitionPrice, 3.80);
    assert.equal(product.productKind, 'TIN_BUNDLE');
  });

  it('extracts TCG products from JSON-LD and skips non-TCG Pokemon items', () => {
    const html = `
      <script type="application/ld+json">
        [
          {"@type":"Product","name":"Pokemon TCG Charizard ex Super-Premium Collection","sku":"4000313298","description":"(10) Pokemon TCG Booster Packs","offers":{"price":"54.99","availability":"https://schema.org/InStock"}},
          {"@type":"Product","name":"Pokemon Crochet Kit","sku":"craft","description":"Craft kit","offers":{"price":"16.88"}}
        ]
      </script>
    `;

    const products = productsFromJsonLd(html, 'https://www.costco.com/trading-cards.html');
    assert.equal(products.length, 1);
    assert.equal(products[0].itemNumber, '4000313298');
  });

  it('extracts a compare-page product from visible page text', () => {
    const html = '<h1>Pokémon TCG: Unova Heavy Hitters Premium Collection, 2-pack</h1><main>$59.99 (24) Pokémon TCG Booster Packs Shipping & Handling Included*</main>';
    const products = productsFromComparePage(html, 'https://www.costco.com/CompareProductsDisplay?partNumbers=1943158');
    assert.equal(products.length, 1);
    assert.equal(products[0].quantity, 24);
  });
});
