const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  selectBestProduct,
  scoreProductMatch,
  parseTcgplayerMarketQuotes,
  inferKind,
} = require('../market/pokemontcgapi');

describe('pokemontcgapi market provider', () => {
  it('infers common sealed product kinds', () => {
    assert.equal(inferKind('Pokemon Scarlet & Violet Elite Trainer Box'), 'ETB');
    assert.equal(inferKind('Pokemon TCG: XY3 Sleeved Booster Pack'), 'SLEEVED_BOOSTER');
    assert.equal(inferKind('Pokemon 151 Booster Bundle'), 'BOOSTER_BUNDLE');
  });

  it('rejects otherwise similar products with the wrong product kind', () => {
    const obs = 'Pokemon Evolving Skies Booster Box';
    const correct = { name: 'Evolving Skies Booster Box', kind: 'BOOSTER_BOX' };
    const wrong = { name: 'Evolving Skies Booster Pack', kind: 'BOOSTER_PACK' };
    assert.ok(scoreProductMatch(obs, correct) > scoreProductMatch(obs, wrong));
  });

  it('selects a strong identity match and refuses weak matches', () => {
    const match = selectBestProduct('Pokemon TCG: XY3 Sleeved Booster Pack', [
      { id: 'xy3-starter', name: 'XY3 Starter Deck', kind: 'STARTER_DECK' },
      { id: 'xy3-sleeved', name: 'XY3 Sleeved Booster Pack', kind: 'SLEEVED_BOOSTER' },
    ]);
    assert.equal(match.product.id, 'xy3-sleeved');
    assert.equal(selectBestProduct('Pokemon Battle Academy Board Game', [
      { id: 'sv-etb', name: 'Scarlet & Violet Elite Trainer Box', kind: 'ETB' },
    ]), null);
  });

  it('accepts only TCGplayer USD MARKET quotes', () => {
    const quotes = parseTcgplayerMarketQuotes({ data: { quotes: [
      { source: 'TCGPLAYER', variant: 'MARKET', currency: 'USD', amount: 79.99 },
      { source: 'TCGPLAYER', variant: 'LOW', currency: 'USD', amount: 70.00 },
      { source: 'CARDMARKET', variant: 'MARKET', currency: 'EUR', amount: 65.00 },
    ] } });
    assert.deepEqual(quotes, [
      { source: 'TCGPLAYER', variant: 'MARKET', currency: 'USD', amount: 79.99 },
    ]);
  });
});
