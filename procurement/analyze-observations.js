const marketMod = require('../market');
const opportunityMod = require('../opportunities');
const { normalizeExternalObservations } = require('./observations');

function inputObservations(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.observations)) return payload.observations;
  if (Array.isArray(payload?.listings)) return payload.listings;
  return [];
}

function sourceStatusesFor(observations, rejectedItems) {
  const bySource = new Map();
  for (const observation of observations) {
    const entry = bySource.get(observation.source) || { total: 0, rejected: 0 };
    entry.total += 1;
    if (!observation.procurement_eligible) entry.rejected += 1;
    bySource.set(observation.source, entry);
  }

  for (const rejected of rejectedItems) {
    const source = rejected.observation?.source || 'external_web';
    if (bySource.has(source)) continue;
    bySource.set(source, { total: 0, rejected: 1 });
  }

  return Array.from(bySource.entries()).map(([source, counts]) => ({
    source,
    status: counts.total > counts.rejected ? 'success' : 'rejected',
    product_count: counts.total,
    elapsed_ms: null,
    message: counts.rejected ? `${counts.rejected} rejected before market enrichment` : null,
  }));
}

async function analyzeExternalObservations(payload, options = {}) {
  const observedAt = options.observedAt || new Date().toISOString();
  const { observations, eligibleObservations, rejectedItems } = normalizeExternalObservations(inputObservations(payload), { observedAt });
  const marketEnabled = options.marketEnabled ?? process.env.MARKET_ENABLED !== 'false';
  const marketEstimates = marketEnabled && eligibleObservations.length
    ? await marketMod.estimateMarketPrices(eligibleObservations, options.marketOptions || {})
    : [];
  const assessed = opportunityMod.buildFlipAssessments(eligibleObservations, marketEstimates, observedAt, options.flipOptions || {});
  const opportunityCandidates = [...assessed.flips, ...assessed.investigations];
  const allRejected = [
    ...rejectedItems.map(item => ({ ...item, classification: 'rejected' })),
    ...assessed.rejectedItems,
  ].sort((a, b) => a.index - b.index);
  const rejectedReasons = Object.fromEntries(
    Array.from(allRejected.reduce((counts, item) => {
      counts.set(item.reason, (counts.get(item.reason) || 0) + 1);
      return counts;
    }, new Map()).entries())
  );

  return {
    status: 'success',
    observed_at: observedAt,
    sources: sourceStatusesFor(observations, rejectedItems),
    observations,
    normalized_observations: observations,
    eligible_observations: eligibleObservations,
    rejected_items: allRejected,
    market_estimates: marketEstimates,
    market_matches: marketEstimates,
    flip_candidates: assessed.flips,
    investigations: assessed.investigations,
    flip_summary: {
      outcome: assessed.flips.length ? 'flips_found' : 'none_found',
      flip_candidates: assessed.flips.length,
      investigate: assessed.investigations.length,
      rejected: allRejected.length,
      rejected_reasons: rejectedReasons,
      economics_assumptions: assessed.settings,
    },
    opportunity_candidates: opportunityCandidates,
    eligibility_summary: {
      submitted: inputObservations(payload).length,
      normalized: observations.length,
      eligible_for_market: eligibleObservations.length,
      rejected: allRejected.length,
    },
  };
}

module.exports = {
  analyzeExternalObservations,
  inputObservations,
  sourceStatusesFor,
};
