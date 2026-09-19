const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const marketMod = require('../market');
const { analyzeExternalObservations } = require('../procurement/analyze-observations');

const originalEstimateMarketPrices = marketMod.estimateMarketPrices;

function validListing(overrides = {}) {
  return {
    source: 'walmart',
    product_name: 'Pokemon TCG Mega Evolution Chaos Rising Elite Trainer Box',
    url: 'https://www.walmart.com/ip/pokemon-etb/123',
    price: 49.99,
    seller: 'Walmart.com',
    seller_type: 'first_party',
    availability_text: 'In stock',
    observed_at: '2026-09-17T00:00:00.000Z',
    verification_state: 'direct_product_page',
    confidence: 'verified',
    identifiers: { upc: '0820650856952', item_id: '123' },
    ...overrides,
  };
}

beforeEach(() => {
  marketMod.estimateMarketPrices = async observations => observations.map(observation => ({
    product_id: observation.product_id,
    source_listing_id: observation.source_listing_id,
    market: {
      source: 'test_market',
      status: 'success',
      estimate: 90,
      currency: 'USD',
      evidence_count: 3,
      identity_match_score: 0.92,
      matched_product_name: observation.name,
      observed_at: '2026-09-17T00:01:00.000Z',
      url: 'https://example.com/market',
    },
  }));
});

afterEach(() => {
  marketMod.estimateMarketPrices = originalEstimateMarketPrices;
});

describe('analyzeExternalObservations', () => {
  it('rejects third-party Walmart observations before market enrichment', async () => {
    let marketCallCount = 0;
    marketMod.estimateMarketPrices = async observations => {
      marketCallCount += 1;
      assert.equal(observations.length, 0);
      return [];
    };

    const result = await analyzeExternalObservations({
      observations: [validListing({ seller: 'ToyMart', seller_type: 'marketplace' })],
    });

    assert.equal(result.eligible_observations.length, 0);
    assert.equal(result.rejected_items.length, 1);
    assert.equal(result.rejected_items[0].reason, 'third_party_seller');
    assert.equal(result.market_estimates.length, 0);
    assert.equal(marketCallCount, 0);
  });

  it('deduplicates repeated observations', async () => {
    const duplicate = validListing();
    const result = await analyzeExternalObservations({ observations: [duplicate, { ...duplicate }] });

    assert.equal(result.observations.length, 1);
    assert.equal(result.eligible_observations.length, 1);
    assert.equal(result.rejected_items.length, 1);
    assert.equal(result.rejected_items[0].reason, 'duplicate_observation');
    assert.equal(result.rejected_items[0].duplicate_of, 0);
  });

  it('keeps missing availability evidence out of enrichment', async () => {
    const result = await analyzeExternalObservations({
      observations: [validListing({ availability_text: undefined })],
    });

    assert.equal(result.observations.length, 1);
    assert.equal(result.observations[0].availability, 'unknown');
    assert.equal(result.eligible_observations.length, 0);
    assert.equal(result.rejected_items[0].reason, 'availability_evidence_missing');
    assert.equal(result.market_estimates.length, 0);
    assert.equal(result.opportunity_candidates.length, 0);
  });

  it('does not treat a disabled add-to-cart control as stock evidence', async () => {
    const result = await analyzeExternalObservations({
      observations: [validListing({ availability_text: 'Add to Cart disabled' })],
    });

    assert.equal(result.observations[0].availability, 'unknown');
    assert.equal(result.eligible_observations.length, 0);
    assert.equal(result.rejected_items[0].reason, 'availability_evidence_missing');
  });

  it('enriches valid first-party retail observations', async () => {
    const result = await analyzeExternalObservations({ observations: [validListing()] });

    assert.equal(result.rejected_items.length, 0);
    assert.equal(result.eligible_observations.length, 1);
    assert.equal(result.observations[0].procurement_eligible, true);
    assert.equal(result.market_estimates.length, 1);
    assert.equal(result.opportunity_candidates.length, 1);
    assert.equal(result.flip_candidates.length, 1);
    assert.equal(result.opportunity_candidates[0].candidate_type, 'flip_candidate');
    assert.equal(result.flip_candidates[0].math.estimated_net_profit, 19.21);
    assert.equal(result.flip_summary.outcome, 'flips_found');
  });

  it('returns none found when market evidence is unavailable', async () => {
    marketMod.estimateMarketPrices = async () => [];
    const result = await analyzeExternalObservations({ observations: [validListing()] });

    assert.equal(result.flip_summary.outcome, 'none_found');
    assert.deepEqual(result.flip_candidates, []);
    assert.deepEqual(result.investigations, []);
    assert.equal(result.rejected_items[0].reason, 'market_evidence_missing');
  });

  it('rejects a generic product identity before market enrichment', async () => {
    let called = false;
    marketMod.estimateMarketPrices = async () => { called = true; return []; };
    const result = await analyzeExternalObservations({
      observations: [validListing({ product_name: 'Pokemon TCG Elite Trainer Box' })],
    });

    assert.equal(called, false);
    assert.equal(result.rejected_items[0].reason, 'retail_variant_unconfirmed');
  });

  it('handles a mixed batch from multiple retailers', async () => {
    const result = await analyzeExternalObservations({
      observations: [
        validListing({ source: 'Target', seller: 'Target', url: 'https://www.target.com/p/pokemon-etb/-/A-111', identifiers: { tcin: '111' } }),
        validListing({ source: 'Walmart', seller: 'ToyMart', seller_type: 'marketplace', url: 'https://www.walmart.com/ip/pokemon-etb/222', identifiers: { item_id: '222' } }),
        validListing({ source: 'Barnes & Noble', seller: 'Barnes & Noble', url: 'https://www.barnesandnoble.com/s/pokemon%20etb', verification_state: 'search_result', identifiers: { ean: '333' } }),
        validListing({ source: 'GameStop', seller: 'GameStop', url: 'https://www.gamestop.com/toys-games/trading-cards/products/pokemon-etb/444.html', identifiers: { sku: '444' } }),
      ],
    });

    assert.equal(result.observations.length, 4);
    assert.equal(result.eligible_observations.length, 2);
    assert.equal(result.market_estimates.length, 2);
    assert.deepEqual(result.rejected_items.map(item => item.reason), [
      'third_party_seller',
      'retail_observation_not_verified',
    ]);
    assert.deepEqual(result.eligible_observations.map(obs => obs.source), ['target', 'gamestop']);
  });
});
