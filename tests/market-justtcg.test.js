const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  selectBestProduct,
  scoreProductMatch,
  variantPrices,
  inferKind,
  fetchJustTcgEstimates,
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
        { id: 'normal', price: 19.99, condition: 'Near Mint', printing: 'Normal', priceHistory: [{ p: 19.99, t: 1 }] },
        { id: 'zero', price: 0 },
        { id: 'missing' },
      ],
    }), [
      {
        price: 19.99,
        id: 'normal',
        condition: 'Near Mint',
        printing: 'Normal',
        lastUpdated: null,
        priceChange24hr: null,
        priceChange7d: null,
        priceChange30d: null,
        priceHistory: [{ p: 19.99, t: 1 }],
      },
    ]);
  });

  it('hydrates matched identities through the batch endpoint with history provenance', async () => {
    const calls = { get: [], post: [] };
    const client = {
      async get(url, options) {
        calls.get.push({ url, options });
        return {
          data: {
            data: [{
              id: 'pokemon-151-booster-bundle',
              uuid: 'card-151-bundle',
              name: 'Pokemon 151 Booster Bundle',
              set_name: 'Scarlet & Violet 151',
              variants: [{ id: 'stale', price: 35 }],
            }],
          },
        };
      },
      async post(url, body, options) {
        calls.post.push({ url, body, options });
        return {
          data: {
            data: [{
              uuid: 'card-151-bundle',
              name: 'Pokemon 151 Booster Bundle',
              variants: [
                { id: 'normal', price: 42, condition: 'Near Mint', printing: 'Normal', priceChange24hr: 1.5, priceChange7d: 3, lastUpdated: 1780936262, priceHistory: [{ p: 41, t: 1780358400 }, { p: 42, t: 1780444800 }] },
                { id: 'foil', price: 48, condition: 'Near Mint', printing: 'Holofoil', priceChange24hr: 2.5, priceChange7d: 4, lastUpdated: 1780936263, priceHistory: [{ p: 47, t: 1780358400 }] },
              ],
            }],
          },
        };
      },
    };

    const [estimate] = await fetchJustTcgEstimates([{
      name: 'Pokemon 151 Booster Bundle',
    }], { client, apiKey: 'tcg_test' });

    assert.equal(calls.get.length, 1);
    assert.equal(calls.post.length, 1);
    assert.deepEqual(calls.post[0].body, [{ cardId: 'card-151-bundle', priceHistoryDuration: '90d' }]);
    assert.equal(estimate.status, 'success');
    assert.equal(estimate.estimate, 45);
    assert.equal(estimate.evidence.variant_count, 2);
    assert.deepEqual(estimate.evidence.variant_printings, ['Normal', 'Holofoil']);
    assert.equal(estimate.evidence.price_history_points, 3);
    assert.equal(estimate.trend.median_price_change_24hr, 2);
    assert.equal(estimate.provenance, 'JustTCG API batch variant prices');
  });
});
