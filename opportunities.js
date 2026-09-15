const MIN_DISCOUNT_PCT = Number(process.env.OPPORTUNITY_MIN_DISCOUNT_PCT || '25');
const MIN_ABSOLUTE_SPREAD = Number(process.env.OPPORTUNITY_MIN_ABSOLUTE_SPREAD || '10');

function findMarketEstimate(observation, marketEstimates) {
  return marketEstimates.find(entry =>
    entry.product_id === observation.product_id ||
    entry.source_listing_id === observation.source_listing_id);
}

function reasonForNoCandidate(observation, market) {
  if (observation.confidence !== 'verified') return 'retail_observation_not_verified';
  if (observation.availability !== 'in_stock') return 'retail_not_in_stock';
  if (typeof observation.price !== 'number') return 'retail_price_missing';
  if (!market) return 'market_evidence_missing';
  if (market.status !== 'success') return market.status || 'market_evidence_unavailable';
  if (typeof market.estimate !== 'number') return 'market_price_missing';
  return null;
}

function buildOpportunityCandidates(observations, marketEstimates, observedAt = new Date().toISOString()) {
  const candidates = [];

  for (const observation of observations) {
    const marketEntry = findMarketEstimate(observation, marketEstimates);
    const market = marketEntry?.market ?? null;
    const blockedReason = reasonForNoCandidate(observation, market);
    if (blockedReason) continue;

    const retailPrice = observation.price;
    const marketPrice = market.estimate;
    const absoluteSpread = Number((marketPrice - retailPrice).toFixed(2));
    const discountPct = Number(((absoluteSpread / marketPrice) * 100).toFixed(2));

    if (absoluteSpread < MIN_ABSOLUTE_SPREAD || discountPct < MIN_DISCOUNT_PCT) continue;

    candidates.push({
      candidate_type: 'opportunity_candidate',
      status: 'candidate',
      confidence: 'candidate',
      product_id: observation.product_id,
      source_listing_id: observation.source_listing_id,
      name: observation.name,
      availability: observation.availability,
      retail: {
        source: observation.source,
        source_type: observation.source_type,
        price: retailPrice,
        currency: observation.currency,
        url: observation.url,
        observed_at: observation.observed_at,
        confidence: observation.confidence,
        source_status: observation.source_status,
      },
      market: {
        source: market.source,
        estimate: marketPrice,
        currency: market.currency,
        evidence_count: market.evidence_count,
        observed_at: market.observed_at,
        url: market.url,
        status: market.status,
      },
      math: {
        market_price: marketPrice,
        retail_price: retailPrice,
        absolute_spread: absoluteSpread,
        discount_pct: discountPct,
        trigger: `${retailPrice} <= ${marketPrice} * ${(1 - MIN_DISCOUNT_PCT / 100).toFixed(2)} and spread >= ${MIN_ABSOLUTE_SPREAD}`,
        min_discount_pct: MIN_DISCOUNT_PCT,
        min_absolute_spread: MIN_ABSOLUTE_SPREAD,
      },
      generated_at: observedAt,
    });
  }

  return candidates;
}

module.exports = { buildOpportunityCandidates, reasonForNoCandidate };
