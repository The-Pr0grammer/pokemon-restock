const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { isTcgProduct } = require('../../scrapers/barnesandnoble');

function makeRaw(title, categories = []) {
  return { product: { title, categories } };
}

describe('Barnes & Noble scraper — isTcgProduct', () => {
  it('keeps physical TCG products', () => {
    assert.equal(isTcgProduct(makeRaw('Pokemon TCG: XY3 Sleeved Booster Pack')), true);
    assert.equal(isTcgProduct(makeRaw('Pokemon Battle Academy Board Game')), true);
  });

  it('filters Pokemon books and social-media commentary listings', () => {
    assert.equal(isTcgProduct(makeRaw('Pokemon Adventures Manga Box Set')), false);
    assert.equal(isTcgProduct(makeRaw('Why The Opening Pokemon Trading Card Game Booster Card Packs Video Genre Has Become Popular')), false);
  });
});
