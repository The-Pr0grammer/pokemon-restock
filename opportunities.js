const MIN_DISCOUNT_PCT = Number(process.env.OPPORTUNITY_MIN_DISCOUNT_PCT || '25');
const MIN_ABSOLUTE_SPREAD = Number(process.env.OPPORTUNITY_MIN_ABSOLUTE_SPREAD || '10');
const MIN_IDENTITY_SCORE = Number(process.env.OPPORTUNITY_MIN_IDENTITY_SCORE || '0.85');
const MIN_MARKET_EVIDENCE = Number(process.env.OPPORTUNITY_MIN_MARKET_EVIDENCE || '2');

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

function marketEvidenceQuality(market) {
  const reasons = [];
  if (typeof market.identity_match_score === 'number' && market.identity_match_score < MIN_IDENTITY_SCORE) {
    reasons.push('market_identity_below_threshold');
  }
  if (!Number.isFinite(market.evidence_count) || market.evidence_count < MIN_MARKET_EVIDENCE) {
    reasons.push('market_evidence_below_threshold');
  }
  return {
    strong: reasons.length === 0,
    reasons,
  };
}

function buildSignal(observation, market, observedAt, signalType) {
  const retailPrice = observation.price;
  const marketPrice = market.estimate;
  const absoluteSpread = Number((marketPrice - retailPrice).toFixed(2));
  const discountPct = Number(((absoluteSpread / marketPrice) * 100).toFixed(2));
  const isInvestigation = signalType === 'investigate';

  return {
    candidate_type: isInvestigation ? 'investigate' : 'opportunity_candidate',
    status: isInvestigation ? 'investigate' : 'candidate',
    confidence: isInvestigation ? 'needs_confirmation' : 'candidate',
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
      verification_state: observation.verification_state || null,
      source_status: observation.source_status,
    },
    market: {
      source: market.source,
      estimate: marketPrice,
      currency: market.currency,
      evidence_count: market.evidence_count,
      identity_match_score: market.identity_match_score ?? null,
      matched_product_id: market.matched_product_id ?? null,
      matched_product_name: market.matched_product_name ?? null,
      provenance: market.provenance ?? null,
      observed_at: market.observed_at,
      market_as_of: market.market_as_of ?? null,
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
  };
}

function buildOpportunityCandidates(observations, marketEstimates, observedAt = new Date().toISOString()) {
  const signals = [];

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

    const quality = marketEvidenceQuality(market);
    const signal = buildSignal(observation, market, observedAt, quality.strong ? 'opportunity' : 'investigate');
    if (!quality.strong) signal.investigation_reasons = quality.reasons;
    signals.push(signal);
  }

  return signals;
}

module.exports = {
  buildOpportunityCandidates,
  reasonForNoCandidate,
  marketEvidenceQuality,
};
