const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { buildOpportunityCandidates } = require('../opportunities');

const OBS = {
  source: 'barnesandnoble',
  source_type: 'retail_listing',
  source_listing_id: 'bn-1',
  product_id: 'prod-1',
  name: 'Pokemon TCG: XY3 Sleeved Booster Pack',
  price: 3.95,
  currency: 'USD',
  availability: 'in_stock',
  url: 'https://example.com/product',
  observed_at: '2026-09-15T00:00:00.000Z',
  confidence: 'verified',
  verification_state: 'direct_product_page',
  source_status: 'success',
  raw_status: 'in_stock',
};

describe('opportunity candidates', () => {
  it('creates a candidate when retail is materially below strong market evidence', () => {
    const candidates = buildOpportunityCandidates([OBS], [{
      product_id: 'prod-1',
      market: {
        source: 'ebay_sold',
        status: 'success',
        estimate: 20,
        currency: 'USD',
        evidence_count: 5,
        observed_at: '2026-09-15T00:01:00.000Z',
        url: 'https://example.com/market',
      },
    }], '2026-09-15T00:02:00.000Z');

    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].candidate_type, 'opportunity_candidate');
    assert.equal(candidates[0].math.absolute_spread, 16.05);
    assert.equal(candidates[0].math.discount_pct, 80.25);
  });

  it('demotes a price dislocation with weak identity and thin evidence to investigate', () => {
    const candidates = buildOpportunityCandidates([OBS], [{
      product_id: 'prod-1',
      market: {
        source: 'justtcg',
        status: 'success',
        estimate: 65.20,
        currency: 'USD',
        evidence_count: 1,
        identity_match_score: 0.767,
        matched_product_name: 'Pokemon TCG: Battle Academy',
        observed_at: '2026-09-15T00:01:00.000Z',
      },
    }]);

    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].candidate_type, 'investigate');
    assert.equal(candidates[0].status, 'investigate');
    assert.deepEqual(candidates[0].investigation_reasons, [
      'market_identity_below_threshold',
      'market_evidence_below_threshold',
    ]);
    assert.equal(candidates[0].market.identity_match_score, 0.767);
  });

  it('does not create high-confidence candidates without market evidence', () => {
    const candidates = buildOpportunityCandidates([OBS], [{
      product_id: 'prod-1',
      market: {
        source: 'ebay_sold',
        status: 'insufficient_market_evidence',
        estimate: null,
        currency: 'USD',
        evidence_count: 1,
      },
    }]);

    assert.equal(candidates.length, 0);
  });

  it('does not create candidates for out-of-stock retail observations', () => {
    const candidates = buildOpportunityCandidates([{ ...OBS, availability: 'out_of_stock' }], [{
      product_id: 'prod-1',
      market: { source: 'ebay_sold', status: 'success', estimate: 20, currency: 'USD', evidence_count: 5 },
    }]);

    assert.equal(candidates.length, 0);
  });
});
