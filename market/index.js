const ebay = require('./ebay-sold');
const ptcg = require('./pokemontcgapi');

const MAX_OBSERVATIONS = parseInt(process.env.MARKET_PRICE_MAX_OBSERVATIONS || '8', 10);

function attachAttempts(result, attempts) {
  return { ...result, attempts };
}

function preferredFailure(attempts) {
  const priority = [
    'timeout',
    'blocked',
    'credentials_invalid',
    'credentials_missing',
    'insufficient_market_evidence',
    'unavailable',
  ];
  for (const status of priority) {
    const match = attempts.find(attempt => attempt.status === status);
    if (match) return attachAttempts(match, attempts);
  }
  return attachAttempts({
    source: 'market_provider_chain',
    status: 'unavailable',
    estimate: null,
    currency: 'USD',
    evidence_count: 0,
    observed_at: new Date().toISOString(),
  }, attempts);
}

async function estimateOne(observation, { signal } = {}) {
  const attempts = [];

  try {
    const structured = await ptcg.fetchPtcgApiEstimate(observation, { signal });
    attempts.push(structured);
    if (structured.status === 'success') return attachAttempts(structured, attempts);
  } catch (err) {
    attempts.push({
      source: 'pokemontcgapi_tcgplayer',
      status: ptcg.marketErrorStatus(err),
      estimate: null,
      currency: 'USD',
      evidence_count: 0,
      observed_at: new Date().toISOString(),
      query: observation.name,
      url: null,
      message: err.message,
    });
  }

  try {
    const sold = await ebay.fetchEbaySoldEstimate(observation, { signal });
    attempts.push(sold);
    if (sold.status === 'success') return attachAttempts(sold, attempts);
  } catch (err) {
    attempts.push({
      source: 'ebay_sold',
      status: ebay.marketErrorStatus ? ebay.marketErrorStatus(err) : 'unavailable',
      estimate: null,
      currency: 'USD',
      evidence_count: 0,
      observed_at: new Date().toISOString(),
      query: observation.name,
      url: null,
      message: err.message,
    });
  }

  return preferredFailure(attempts);
}

async function estimateMarketPrices(observations, { signal } = {}) {
  const eligible = observations
    .filter(obs => obs.confidence === 'verified' && obs.name && typeof obs.price === 'number')
    .slice(0, MAX_OBSERVATIONS);

  const estimates = [];
  for (const observation of eligible) {
    estimates.push({
      product_id: observation.product_id,
      source_listing_id: observation.source_listing_id,
      market: await estimateOne(observation, { signal }),
    });
  }
  return estimates;
}

module.exports = { estimateMarketPrices, estimateOne, preferredFailure };
