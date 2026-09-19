const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { buildFlipAssessments, buildOpportunityCandidates } = require('../opportunities');

const OBS = {
  source: 'barnesandnoble',
  source_type: 'retail_listing',
  source_listing_id: 'bn-1',
  product_id: 'prod-1',
  name: 'Pokemon TCG Mega Evolution Chaos Rising Elite Trainer Box',
  price: 49.99,
  currency: 'USD',
  availability: 'in_stock',
  url: 'https://example.com/product',
  observed_at: '2026-09-15T00:00:00.000Z',
  confidence: 'verified',
  verification_state: 'direct_product_page',
  source_status: 'success',
  seller_name: 'Barnes & Noble',
};

function market(overrides = {}) {
  return {
    product_id: 'prod-1',
    source_listing_id: 'bn-1',
    market: {
      source: 'justtcg',
      status: 'success',
      estimate: 84,
      currency: 'USD',
      evidence_count: 3,
      identity_match_score: 0.95,
      matched_product_name: OBS.name,
      observed_at: '2026-09-15T00:01:00.000Z',
      url: 'https://example.com/market',
      ...overrides,
    },
  };
}

describe('flip assessments', () => {
  it('promotes exact, evidenced inventory using net profit and ROI', () => {
    const [candidate] = buildOpportunityCandidates([OBS], [market()]);

    assert.equal(candidate.candidate_type, 'flip_candidate');
    assert.equal(candidate.math.expected_resale, 84);
    assert.equal(candidate.math.acquisition_cost, 49.99);
    assert.equal(candidate.math.selling_fees, 12.9);
    assert.equal(candidate.math.outbound_shipping, 7);
    assert.equal(candidate.math.estimated_net_proceeds, 64.1);
    assert.equal(candidate.math.estimated_net_profit, 14.11);
    assert.equal(candidate.math.roi_pct, 28.23);
    assert.equal(candidate.confidence, 'strong');
  });

  it('ranks candidates by estimated net profit', () => {
    const second = { ...OBS, source_listing_id: 'bn-2', product_id: 'prod-2', name: 'Pokemon TCG Mega Evolution Pitch Black Elite Trainer Box', price: 30 };
    const secondMarket = { ...market({ estimate: 70, matched_product_name: second.name }), product_id: 'prod-2', source_listing_id: 'bn-2' };
    const result = buildFlipAssessments([OBS, second], [market(), secondMarket]);

    assert.deepEqual(result.flips.map(item => item.source_listing_id), ['bn-2', 'bn-1']);
    assert.ok(result.flips[0].math.estimated_net_profit > result.flips[1].math.estimated_net_profit);
  });

  it('investigates a promising spread with thin market evidence', () => {
    const result = buildFlipAssessments([OBS], [market({ evidence_count: 1 })]);

    assert.equal(result.flips.length, 0);
    assert.equal(result.investigations[0].candidate_type, 'investigate');
    assert.deepEqual(result.investigations[0].investigation_reasons, ['market_evidence_below_threshold']);
  });

  it('investigates a promising spread without a matched market identity', () => {
    const result = buildFlipAssessments([OBS], [market({ matched_product_name: null })]);

    assert.equal(result.investigations[0].investigation_reasons[0], 'market_identity_unconfirmed');
  });

  it('investigates mixed market printings instead of treating their median as a resale quote', () => {
    const result = buildFlipAssessments([OBS], [market({
      evidence: { variant_conditions: ['Near Mint'], variant_printings: ['Normal', 'Holofoil'] },
    })]);

    assert.equal(result.flips.length, 0);
    assert.deepEqual(result.investigations[0].investigation_reasons, ['market_variant_price_mixed']);
  });

  it('rejects a known variant mismatch', () => {
    const result = buildFlipAssessments([OBS], [market({ matched_product_name: 'Pokemon TCG Mega Evolution Chaos Rising Pokemon Center Elite Trainer Box' })]);

    assert.equal(result.flips.length, 0);
    assert.equal(result.investigations.length, 0);
    assert.equal(result.rejectedItems[0].reason, 'market_variant_mismatch');
  });

  it('rejects a gross spread that loses money after fees and shipping', () => {
    const result = buildFlipAssessments([{ ...OBS, price: 80 }], [market({ estimate: 90 })]);

    assert.equal(result.rejectedItems[0].reason, 'net_profit_below_threshold');
  });

  it('uses verified all-in acquisition cost when supplied', () => {
    const result = buildFlipAssessments([{ ...OBS, acquisition_cost: 59.99, acquisition_cost_basis: 'submitted_total' }], [market()]);

    assert.equal(result.rejectedItems[0].reason, 'net_profit_below_threshold');
  });

  it('honors configurable profit and ROI thresholds', () => {
    const result = buildFlipAssessments([OBS], [market()], undefined, { minNetProfit: 12, minRoiPct: 30 });

    assert.equal(result.rejectedItems[0].reason, 'roi_below_threshold');
  });

  it('rejects missing market evidence and unavailable retail inventory', () => {
    assert.equal(buildFlipAssessments([OBS], []).rejectedItems[0].reason, 'market_evidence_missing');
    assert.equal(buildFlipAssessments([{ ...OBS, availability: 'out_of_stock' }], [market()]).rejectedItems[0].reason, 'retail_not_in_stock');
  });
});
