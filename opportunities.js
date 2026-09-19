const { firstPartyStatus } = require('./procurement/observations');
const { exactProductMatch, retailIdentityStatus } = require('./procurement/product-identity');

const MIN_IDENTITY_SCORE = Number(process.env.OPPORTUNITY_MIN_IDENTITY_SCORE || '0.85');
const MIN_MARKET_EVIDENCE = Number(process.env.OPPORTUNITY_MIN_MARKET_EVIDENCE || '2');

function setting(value, fallback, max = Infinity) {
  const number = Number(value ?? fallback);
  if (!Number.isFinite(number) || number < 0 || number > max) throw new RangeError('Invalid flip economics setting');
  return number;
}

function flipSettings(overrides = {}) {
  return {
    selling_fee_rate: setting(overrides.sellingFeeRate ?? process.env.FLIP_SELLING_FEE_RATE, 0.15, 1),
    selling_fee_fixed: setting(overrides.sellingFeeFixed ?? process.env.FLIP_SELLING_FEE_FIXED, 0.30),
    outbound_shipping: setting(overrides.outboundShipping ?? process.env.FLIP_OUTBOUND_SHIPPING, 7),
    min_net_profit: setting(overrides.minNetProfit ?? process.env.FLIP_MIN_NET_PROFIT, 10),
    min_roi_pct: setting(overrides.minRoiPct ?? process.env.FLIP_MIN_ROI_PCT, 20),
  };
}

function money(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function findMarketEstimate(observation, marketEstimates) {
  return marketEstimates.find(entry => entry.source_listing_id && entry.source_listing_id === observation.source_listing_id) ||
    marketEstimates.find(entry => entry.product_id && entry.product_id === observation.product_id);
}

function reasonForNoCandidate(observation, market) {
  if (observation.procurement_eligible === false) return observation.procurement_reject_reason || 'retail_observation_rejected';
  const identity = retailIdentityStatus(observation.name);
  if (!identity.confirmed) return identity.reason;
  const seller = firstPartyStatus(observation.source, observation);
  if (!seller.ok) return seller.reason;
  if (observation.confidence !== 'verified' || observation.verification_state !== 'direct_product_page') return 'retail_observation_not_verified';
  if (observation.availability !== 'in_stock') return 'retail_not_in_stock';
  if (!Number.isFinite(observation.acquisition_cost ?? observation.price) || (observation.acquisition_cost ?? observation.price) <= 0) return 'retail_price_missing';
  if (observation.currency !== 'USD') return 'currency_mismatch';
  if (!market) return 'market_evidence_missing';
  if (market.status !== 'success') return market.status || 'market_evidence_unavailable';
  if (!Number.isFinite(market.estimate) || market.estimate <= 0) return 'market_price_missing';
  if (market.currency !== 'USD') return 'currency_mismatch';
  return null;
}

function marketEvidenceQuality(observation, market) {
  const reasons = [];
  if (!market.matched_product_name) reasons.push('market_identity_unconfirmed');
  else if (!exactProductMatch(observation.name, market.matched_product_name)) reasons.push('market_variant_mismatch');
  if (typeof market.identity_match_score === 'number' && market.identity_match_score < MIN_IDENTITY_SCORE) {
    reasons.push('market_identity_below_threshold');
  }
  if (!Number.isFinite(market.evidence_count) || market.evidence_count < MIN_MARKET_EVIDENCE) {
    reasons.push('market_evidence_below_threshold');
  }
  if (market.source === 'justtcg' && (
    (market.evidence?.variant_conditions?.length || 0) > 1 ||
    (market.evidence?.variant_printings?.length || 0) > 1
  )) reasons.push('market_variant_price_mixed');
  return { strong: reasons.length === 0, reasons };
}

function estimateEconomics(observation, market, settings = flipSettings()) {
  const expectedResale = money(market.estimate);
  const acquisitionCost = money(observation.acquisition_cost ?? observation.price);
  const sellingFees = money(expectedResale * settings.selling_fee_rate + settings.selling_fee_fixed);
  const outboundShipping = money(settings.outbound_shipping);
  const estimatedNetProceeds = money(expectedResale - sellingFees - outboundShipping);
  const estimatedNetProfit = money(estimatedNetProceeds - acquisitionCost);
  return {
    expected_resale: expectedResale,
    acquisition_cost: acquisitionCost,
    selling_fees: sellingFees,
    outbound_shipping: outboundShipping,
    estimated_net_proceeds: estimatedNetProceeds,
    estimated_net_profit: estimatedNetProfit,
    roi_pct: money(estimatedNetProfit / acquisitionCost * 100),
    acquisition_cost_basis: observation.acquisition_cost_basis || 'listed_price',
    fee_rate: settings.selling_fee_rate,
    fixed_fee: settings.selling_fee_fixed,
  };
}

function buildSignal(observation, market, math, observedAt, classification, reasons = []) {
  return {
    candidate_type: classification,
    status: classification,
    confidence: classification === 'flip_candidate' ? 'strong' : 'needs_confirmation',
    product_id: observation.product_id,
    source_listing_id: observation.source_listing_id,
    name: observation.name,
    availability: observation.availability,
    retail: {
      source: observation.source,
      source_type: observation.source_type,
      seller: observation.seller_name || null,
      price: observation.price,
      acquisition_cost: math.acquisition_cost,
      currency: observation.currency,
      url: observation.url,
      observed_at: observation.observed_at,
      confidence: observation.confidence,
      verification_state: observation.verification_state,
      fulfillment: observation.fulfillment || null,
    },
    market: {
      source: market.source,
      estimate: market.estimate,
      currency: market.currency,
      evidence_count: market.evidence_count,
      identity_match_score: market.identity_match_score ?? null,
      matched_product_id: market.matched_product_id ?? null,
      matched_product_name: market.matched_product_name ?? null,
      provenance: market.provenance ?? null,
      evidence: market.evidence ?? null,
      observed_at: market.observed_at,
      market_as_of: market.market_as_of ?? null,
      url: market.url,
      status: market.status,
    },
    math,
    ...(reasons.length ? { investigation_reasons: reasons } : {}),
    generated_at: observedAt,
  };
}

function assessOpportunity(observation, marketEntry, observedAt, settings) {
  const market = marketEntry?.market ?? null;
  const blockedReason = reasonForNoCandidate(observation, market);
  if (blockedReason) return { classification: 'rejected', reason: blockedReason };

  const quality = marketEvidenceQuality(observation, market);
  if (quality.reasons.includes('market_variant_mismatch')) {
    return { classification: 'rejected', reason: 'market_variant_mismatch' };
  }

  const math = estimateEconomics(observation, market, settings);
  if (math.estimated_net_profit < settings.min_net_profit) {
    return { classification: 'rejected', reason: 'net_profit_below_threshold' };
  }
  if (math.roi_pct < settings.min_roi_pct) {
    return { classification: 'rejected', reason: 'roi_below_threshold' };
  }

  const classification = quality.strong ? 'flip_candidate' : 'investigate';
  return { classification, signal: buildSignal(observation, market, math, observedAt, classification, quality.reasons) };
}

function buildFlipAssessments(observations, marketEstimates, observedAt = new Date().toISOString(), options = {}) {
  const settings = flipSettings(options);
  const flips = [];
  const investigations = [];
  const rejectedItems = [];

  for (const [index, observation] of observations.entries()) {
    const marketEntry = findMarketEstimate(observation, marketEstimates);
    const assessment = assessOpportunity(observation, marketEntry, observedAt, settings);
    if (assessment.classification === 'flip_candidate') flips.push(assessment.signal);
    else if (assessment.classification === 'investigate') investigations.push(assessment.signal);
    else rejectedItems.push({
      index: observation.provenance?.input_index ?? index,
      classification: 'rejected',
      reason: assessment.reason,
      reasons: [assessment.reason],
      observation,
    });
  }

  const rank = (a, b) => b.math.estimated_net_profit - a.math.estimated_net_profit || b.math.roi_pct - a.math.roi_pct;
  flips.sort(rank);
  investigations.sort(rank);
  return { flips, investigations, rejectedItems, settings };
}

function buildOpportunityCandidates(observations, marketEstimates, observedAt = new Date().toISOString(), options = {}) {
  const { flips, investigations } = buildFlipAssessments(observations, marketEstimates, observedAt, options);
  return [...flips, ...investigations];
}

module.exports = {
  buildOpportunityCandidates,
  buildFlipAssessments,
  reasonForNoCandidate,
  marketEvidenceQuality,
  estimateEconomics,
  flipSettings,
};
