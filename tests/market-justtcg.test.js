const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  selectBestProduct,
  scoreProductMatch,
  variantPrices,
  inferKind,
} = require('../market/justtcg');

describe('JustTCG market provider', () => {
  it('infers common sealed product kinds', () => {
    assert.equal(inferKind('Pokemon Scarlet & Violet Elite Trainer Box'), 'ETB');
    assert.equal(inferKind('Pokemon TCG: XY3 Sleeved Booster Pack'), 'SLEEVED_BOOSTER');
    assert.equal(inferKind('Pokemon 151 Booster Bundle'), 'BOOSTER_BUNDLE');
  });

  it('selects a strong identity match and refuses weak matches', () => {
    const match = selectBestProduct('Pokemon TCG: XY3 Sleeved Booster Pack', [
      { id: 'xy3-starter', name: 'XY3 Starter Deck' },
      { id: 'xy3-sleeved', name: 'XY3 Sleeved Booster Pack' },
    ]);

    assert.equal(match.product.id, 'xy3-sleeved');
    assert.equal(selectBestProduct('Pokemon Battle Academy Board Game', [
      { id: 'sv-etb', name: 'Scarlet & Violet Elite Trainer Box' },
    ]), null);
  });

  it('penalizes otherwise similar products with the wrong product kind', () => {
    const obs = 'Pokemon Evolving Skies Booster Box';
    const correct = { name: 'Evolving Skies Booster Box' };
    const wrong = { name: 'Evolving Skies Booster Pack' };
    assert.ok(scoreProductMatch(obs, correct) > scoreProductMatch(obs, wrong));
  });

  it('extracts positive variant prices as evidence', () => {
    assert.deepEqual(variantPrices({
      variants: [
        { id: 'normal', price: 19.99, condition: 'Near Mint', printing: 'Normal' },
        { id: 'zero', price: 0 },
        { id: 'missing' },
      ],
    }), [
      { price: 19.99, id: 'normal', condition: 'Near Mint', printing: 'Normal', lastUpdated: null },
    ]);
  });
});
