const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildVisualSummary,
  healthValue,
  renderDashboard,
} = require('../tools/generate-observations-dashboard');

const observations = [
  {
    name: 'Pokemon TCG: Safe Box',
    price: 24.99,
    currency: 'USD',
    availability: 'in_stock',
    source: 'barnesandnoble',
    confidence: 'verified',
    source_status: 'success',
    url: 'https://example.com/safe',
  },
  {
    name: '<script>alert("x")</script>',
    price: 19.99,
    currency: 'USD',
    availability: 'out_of_stock',
    source: 'barnesandnoble',
    confidence: 'search_result',
    source_status: 'success',
    url: 'https://example.com/unsafe',
  },
];

const candidates = [
  {
    candidate_type: 'investigate',
    name: 'Pokemon TCG: Safe Box',
    retail: { source: 'barnesandnoble', price: 24.99, currency: 'USD', url: 'https://example.com/safe' },
    market: { source: 'justtcg', estimate: 60, currency: 'USD', evidence_count: 1 },
    math: { absolute_spread: 35.01, discount_pct: 58.35 },
    confidence: 'needs_confirmation',
  },
  {
    candidate_type: 'opportunity_candidate',
    name: 'Pokemon TCG: Cleaner Box',
    retail: { source: 'bestbuy', price: 39.99, currency: 'USD', url: 'https://example.com/clean' },
    market: { source: 'justtcg', estimate: 80, currency: 'USD', evidence_count: 3 },
    math: { absolute_spread: 40.01, discount_pct: 50.01 },
    confidence: 'candidate',
  },
];

describe('observations dashboard visual summary', () => {
  it('maps source health statuses to render-only values', () => {
    assert.equal(healthValue('success'), 1);
    assert.equal(healthValue('no_matches'), 1);
    assert.equal(healthValue('parser_stale'), 0.5);
    assert.equal(healthValue('rate_limited'), 0.5);
    assert.equal(healthValue('blocked'), 0);
    assert.equal(healthValue('timeout'), 0);
    assert.equal(healthValue('credentials_missing'), 0);
  });

  it('builds source health and funnel counts from run artifacts', () => {
    const summary = buildVisualSummary({
      observations,
      candidates,
      generatedAt: '2026-09-15T20:00:00.000Z',
      sourceStatuses: {
        statuses: [
          { source: 'bestbuy', status: 'credentials_missing', product_count: 0 },
          { source: 'barnesandnoble', status: 'success', product_count: 2 },
          { source: 'target', status: 'blocked', product_count: 0 },
          { source: 'samsclub', status: 'parser_stale', product_count: 0 },
          { source: 'market', status: 'success', product_count: 1 },
        ],
      },
      marketEstimates: [
        { market: { status: 'success' } },
        { market: { status: 'blocked' } },
      ],
    });

    assert.deepEqual(summary.funnel, {
      observed: 2,
      verified: 1,
      actionable: 1,
      enriched: 1,
      investigate: 1,
      opportunities: 1,
    });
    assert.deepEqual(summary.source_health.map(entry => [entry.source, entry.status, entry.render_value]), [
      ['bestbuy', 'credentials_missing', 0],
      ['barnesandnoble', 'success', 1],
      ['target', 'blocked', 0],
      ['samsclub', 'parser_stale', 0.5],
    ]);
  });

  it('renders self-contained charts, escaped labels, and detail tables', () => {
    const visualSummary = buildVisualSummary({
      observations,
      candidates,
      generatedAt: '2026-09-15T20:00:00.000Z',
      sourceStatuses: { statuses: [{ source: 'bestbuy', status: 'credentials_missing', product_count: 0 }] },
      marketEstimates: [],
    });
    const html = renderDashboard({
      observations,
      candidates,
      visualSummary,
      generatedAt: visualSummary.generated_at,
      chartJs: '/*! Chart.js fixture */ window.Chart = function Chart() {};',
    });

    assert.match(html, /Source Health/);
    assert.match(html, /Procurement Funnel/);
    assert.match(html, /Market Opportunity/);
    assert.match(html, /Opportunity Candidates/);
    assert.match(html, /Observations/);
    assert.match(html, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt;/);
    assert.doesNotMatch(html, /cdn\.jsdelivr|unpkg\.com|https:\/\/cdn/i);
    assert.match(html, /investigate/);
    assert.match(html, /opportunity_candidate/);
  });

  it('omits the opportunity spread chart when no signals exist', () => {
    const visualSummary = buildVisualSummary({
      observations,
      candidates: [],
      generatedAt: '2026-09-15T20:00:00.000Z',
      sourceStatuses: { statuses: [] },
      marketEstimates: [],
    });
    const html = renderDashboard({
      observations,
      candidates: [],
      visualSummary,
      generatedAt: visualSummary.generated_at,
      chartJs: 'window.Chart = function Chart() {};',
    });

    assert.doesNotMatch(html, /Opportunity Spread/);
    assert.doesNotMatch(html, /id="spreadChart"/);
  });
});
