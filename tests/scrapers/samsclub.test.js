const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { parseNextData, extractItems, isSamsClubTcgItem, normalizeSamsClubItem } = require('../../scrapers/samsclub');

function makeHtml(items) {
  return `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({
    props: { pageProps: { initialData: { products: items } } },
  })}</script>`;
}

describe("Sam's Club scraper", () => {
  it('extracts Pokemon items from nested Next data', () => {
    const nextData = parseNextData(makeHtml([
      { productId: '9801', name: 'Pokemon TCG Club Bundle', price: 39.98 },
      { productId: 'other', name: 'Storage Shelves', price: 99.98 },
    ]));

    const items = extractItems(nextData);
    assert.equal(items.length, 1);
    assert.equal(items[0].productId, '9801');
  });

  it('lets the club-store TCG filter reject Pokemon books', () => {
    assert.equal(isSamsClubTcgItem({
      productId: 'book',
      name: 'Pokémon Classic Story Collection Box Set, Paperback',
      price: 15.36,
    }), false);
    assert.equal(isSamsClubTcgItem({
      productId: 'cards',
      name: 'Pokemon TCG Club Bundle',
      description: '(10) Pokemon TCG Booster Packs',
    }), true);
  });

  it('normalizes membership and bundle fields', () => {
    const product = normalizeSamsClubItem({
      productId: '9801',
      name: 'Pokemon TCG Club Bundle',
      price: 39.98,
      description: '(10) Pokemon TCG Booster Packs',
      productUrl: '/p/pokemon-bundle/prod9801',
      fulfillmentText: 'Available for Shipping, Pickup or Delivery',
    });

    assert.equal(product.id, 'samsclub-9801');
    assert.equal(product.retailer, 'samsclub');
    assert.equal(product.sellerType, 'first_party');
    assert.equal(product.membershipRequired, true);
    assert.equal(product.quantity, 10);
    assert.equal(product.unitAcquisitionPrice, 4.00);
    assert.equal(product.fulfillment.shipping, 'in_stock');
    assert.equal(product.fulfillment.pickup, 'in_stock');
  });
});
