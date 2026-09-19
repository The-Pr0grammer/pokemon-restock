const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { extractSoldPrices, fetchEbaySoldEstimate, isRelevantSoldTitle, parsePrice } = require('../market/ebay-sold');

describe('eBay sold market evidence parser', () => {
  it('parses dollar prices', () => {
    assert.equal(parsePrice('$24.99'), 24.99);
    assert.equal(parsePrice('$1,024.50'), 1024.50);
    assert.equal(parsePrice('not a price'), null);
  });

  it('requires relevant Pokemon title overlap', () => {
    const name = 'Pokemon TCG: XY3 Sleeved Booster Pack';
    assert.equal(isRelevantSoldTitle(name, 'Pokemon TCG XY3 Sleeved Booster Pack sealed'), true);
    assert.equal(isRelevantSoldTitle(name, 'Pokemon Adventures Manga Book'), false);
  });

  it('extracts only relevant sold prices from search HTML', () => {
    const html = `
      <div class="s-item">
        <div class="s-item__title">Pokemon TCG XY3 Sleeved Booster Pack sealed</div>
        <span class="s-item__price">$19.99</span>
      </div>
      <div class="s-item">
        <div class="s-item__title">Pokemon Adventures Manga Book</div>
        <span class="s-item__price">$7.99</span>
      </div>
    `;

    assert.deepEqual(extractSoldPrices(html, 'Pokemon TCG: XY3 Sleeved Booster Pack'), [19.99]);
  });

  it('uses only exact-product sold comps for a market estimate', async () => {
    const html = `
      <div class="s-item"><div class="s-item__title">Pokemon TCG XY3 Sleeved Booster Pack sealed</div><span class="s-item__price">$80.00</span></div>
      <div class="s-item"><div class="s-item__title">Pokemon TCG XY3 Sleeved Booster Pack new</div><span class="s-item__price">$84.00</span></div>
      <div class="s-item"><div class="s-item__title">Pokemon TCG XY3 Sleeved Booster Pack</div><span class="s-item__price">$88.00</span></div>
      <div class="s-item"><div class="s-item__title">Pokemon TCG XY3 Pokemon Center Sleeved Booster Pack</div><span class="s-item__price">$300.00</span></div>
    `;
    const client = { get: async () => ({ data: html }) };
    const result = await fetchEbaySoldEstimate({ name: 'Pokemon TCG XY3 Sleeved Booster Pack' }, { client });

    assert.equal(result.status, 'success');
    assert.equal(result.estimate, 84);
    assert.equal(result.evidence_count, 3);
    assert.equal(result.identity_match_score, 1);
    assert.equal(result.evidence.length, 3);
  });
});
