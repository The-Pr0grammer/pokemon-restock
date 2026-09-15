const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const club = require('../../scrapers/clubstore');

describe('club-store helpers', () => {
  it('recognizes Pokemon TCG bundle language', () => {
    assert.equal(club.isTcgProduct('Pokemon 3-pack Paldea Partners Tins', '(15) Pokemon TCG Booster Packs'), true);
    assert.equal(club.isTcgProduct('Pokemon Crochet Kit', 'Mixed media craft kit'), false);
    assert.equal(club.isTcgProduct('Pokémon Classic Story Collection Box Set, Paperback'), false);
  });

  it('extracts booster-pack quantity and unit acquisition price', () => {
    const components = club.buildBundleComponents('Pokemon tins', '(15) Pokémon TCG Booster Packs');
    assert.deepEqual(components[0], { type: 'booster_pack', quantity: 15, description: '15 booster packs' });
    assert.equal(club.unitAcquisitionPrice(56.99, components), 3.80);
  });

  it('infers fulfillment without flattening store and shipping signals', () => {
    assert.deepEqual(club.inferFulfillment('Available for Shipping, Pickup or Delivery'), {
      shipping: 'in_stock',
      pickup: 'in_stock',
      same_day: null,
      in_store_only: false,
    });
  });
});
