const axios = require('axios');

const API_BASE = 'https://api.justtcg.com/v1';
const MARKET_SOURCE = 'justtcg';
const DEFAULT_TIMEOUT_MS = parseInt(process.env.MARKET_PRICE_TIMEOUT_MS || '3500', 10);
const SEARCH_LIMIT = parseInt(process.env.JUSTTCG_SEARCH_LIMIT || '10', 10);
const BATCH_SIZE = parseInt(process.env.JUSTTCG_BATCH_SIZE || '20', 10);
const PRICE_HISTORY_DURATION = process.env.JUSTTCG_PRICE_HISTORY_DURATION || '90d';
const MIN_MATCH_SCORE = Number(process.env.JUSTTCG_MIN_MATCH_SCORE || '0.72');

const STOP_WORDS = new Set([
  'pokemon', 'pokémon', 'tcg', 'trading', 'card', 'game', 'the', 'and', 'with',
  'edition', 'set', 'box', 'pack', 'product', 'sealed',
]);

function normalizeWords(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function identityTokens(value) {
  return normalizeWords(value).filter(token => !STOP_WORDS.has(token) && token.length > 1);
}

function inferKind(name) {
  const text = String(name || '').toLowerCase();
  if (/elite trainer|\betb\b/.test(text)) return 'ETB';
  if (/booster box/.test(text)) return 'BOOSTER_BOX';
  if (/booster bundle/.test(text)) return 'BOOSTER_BUNDLE';
  if (/sleeved booster/.test(text)) return 'SLEEVED_BOOSTER';
  if (/booster pack/.test(text)) return 'BOOSTER_PACK';
  if (/starter deck|deluxe deck|theme deck/.test(text)) return 'STARTER_DECK';
  if (/\btin\b/.test(text)) return 'TIN';
  if (/collection/.test(text)) return 'COLLECTION';
  return null;
}

function productText(product) {
  return [
    product?.name,
    product?.set_name,
    product?.set,
    product?.category,
    product?.type,
  ].filter(Boolean).join(' ');
}

function scoreProductMatch(observationName, product) {
  const wanted = identityTokens(observationName);
  const candidate = new Set(identityTokens(productText(product)));
  if (!wanted.length || !candidate.size) return 0;

  const matched = wanted.filter(token => candidate.has(token)).length;
  const recall = matched / wanted.length;
  const precision = matched / candidate.size;
  const tokenScore = (recall * 0.7) + (precision * 0.3);

  const expectedKind = inferKind(observationName);
  const candidateKind = inferKind(productText(product));
  if (expectedKind && candidateKind && expectedKind !== candidateKind) return tokenScore * 0.45;

  return tokenScore;
}

function selectBestProduct(observationName, products, minScore = MIN_MATCH_SCORE) {
  let best = null;
  let bestScore = 0;
  for (const product of products || []) {
    const score = scoreProductMatch(observationName, product);
    if (score > bestScore) {
      best = product;
      bestScore = score;
    }
  }
  return best && bestScore >= minScore ? { product: best, score: Number(bestScore.toFixed(3)) } : null;
}

function variantPrices(product) {
  return (product?.variants || [])
    .map(variant => ({
      price: Number(variant?.price),
      id: variant?.id || variant?.uuid || null,
      condition: variant?.condition || null,
      printing: variant?.printing || null,
      lastUpdated: variant?.lastUpdated || null,
      priceChange24hr: numberOrNull(variant?.priceChange24hr),
      priceChange7d: numberOrNull(variant?.priceChange7d),
      priceChange30d: numberOrNull(variant?.priceChange30d),
      priceHistory: Array.isArray(variant?.priceHistory) ? variant.priceHistory : [],
    }))
    .filter(variant => Number.isFinite(variant.price) && variant.price > 0);
}

function numberOrNull(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function cardIdentifier(product) {
  return product?.uuid || product?.id || null;
}

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function marketErrorStatus(err) {
  if (err?.code === 'ECONNABORTED' || err?.code === 'ETIMEDOUT' || err?.name === 'AbortError') return 'timeout';
  if (err?.response?.status === 401) return 'credentials_invalid';
  if (err?.response?.status === 403 || err?.response?.status === 429) return 'blocked';
  if (err?.response?.status === 404) return 'insufficient_market_evidence';
  return 'unavailable';
}

function insufficientMarketEvidence(observation, observedAt, message, extra = {}) {
  return {
    source: MARKET_SOURCE,
    status: 'insufficient_market_evidence',
    estimate: null,
    currency: 'USD',
    evidence_count: 0,
    observed_at: observedAt,
    query: observation?.name || '',
    url: null,
    message,
    ...extra,
  };
}

function credentialsMissing(observation, observedAt) {
  return {
    source: MARKET_SOURCE,
    status: 'credentials_missing',
    estimate: null,
    currency: 'USD',
    evidence_count: 0,
    observed_at: observedAt,
    query: observation?.name || '',
    url: null,
    message: 'JUSTTCG_API_KEY is not configured',
  };
}

function buildEstimateFromProduct(observation, product, match, observedAt) {
  const searchUrl = `${API_BASE}/cards`;
  const prices = variantPrices(product);
  const matchedId = cardIdentifier(product);

  if (!prices.length) {
    return insufficientMarketEvidence(observation, observedAt, 'Matched product has no positive USD variant prices', {
      url: matchedId ? `${searchUrl}?cardId=${encodeURIComponent(matchedId)}` : null,
      matched_product_id: matchedId,
      matched_product_name: product?.name || null,
      identity_match_score: match?.score ?? null,
    });
  }

  const historyPoints = prices.reduce((total, entry) => total + entry.priceHistory.length, 0);
  const change24hrValues = prices.map(entry => entry.priceChange24hr).filter(Number.isFinite);
  const change7dValues = prices.map(entry => entry.priceChange7d).filter(Number.isFinite);
  const change30dValues = prices.map(entry => entry.priceChange30d).filter(Number.isFinite);

  return {
    source: MARKET_SOURCE,
    status: 'success',
    estimate: Number(median(prices.map(entry => entry.price)).toFixed(2)),
    currency: 'USD',
    evidence_count: prices.length,
    observed_at: observedAt,
    market_as_of: prices.map(entry => entry.lastUpdated).filter(Boolean).sort().at(-1) || null,
    query: observation?.name || '',
    url: matchedId ? `${searchUrl}?cardId=${encodeURIComponent(matchedId)}` : null,
    matched_product_id: matchedId,
    matched_product_name: product?.name || null,
    identity_match_score: match?.score ?? null,
    provenance: 'JustTCG API batch variant prices',
    evidence: {
      variant_count: prices.length,
      price_history_points: historyPoints,
      price_history_duration: PRICE_HISTORY_DURATION,
      median_variant_price: Number(median(prices.map(entry => entry.price)).toFixed(2)),
      min_variant_price: Math.min(...prices.map(entry => entry.price)),
      max_variant_price: Math.max(...prices.map(entry => entry.price)),
      latest_variant_update: prices.map(entry => entry.lastUpdated).filter(Boolean).sort().at(-1) || null,
    },
    trend: {
      median_price_change_24hr: change24hrValues.length ? Number(median(change24hrValues).toFixed(2)) : null,
      median_price_change_7d: change7dValues.length ? Number(median(change7dValues).toFixed(2)) : null,
      median_price_change_30d: change30dValues.length ? Number(median(change30dValues).toFixed(2)) : null,
    },
  };
}

async function searchJustTcgProduct(observation, { client = axios, signal, timeoutMs = DEFAULT_TIMEOUT_MS, apiKey } = {}) {
  const query = observation?.name || '';
  const searchUrl = `${API_BASE}/cards`;
  const response = await client.get(searchUrl, {
    params: {
      game: 'pokemon',
      q: query,
      limit: SEARCH_LIMIT,
      priceHistoryDuration: PRICE_HISTORY_DURATION,
    },
    headers: {
      'x-api-key': apiKey,
      Accept: 'application/json',
    },
    timeout: timeoutMs,
    signal,
  });

  return selectBestProduct(query, response.data?.data || []);
}

async function hydrateMatchedProducts(matches, { client = axios, signal, timeoutMs = DEFAULT_TIMEOUT_MS, apiKey } = {}) {
  const hydrated = new Map();
  const searchUrl = `${API_BASE}/cards`;
  const unique = [];
  const seen = new Set();

  for (const match of matches) {
    const id = cardIdentifier(match.product);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    unique.push({ cardId: id, priceHistoryDuration: PRICE_HISTORY_DURATION });
  }

  for (let i = 0; i < unique.length; i += BATCH_SIZE) {
    const chunk = unique.slice(i, i + BATCH_SIZE);
    const response = await client.post(searchUrl, chunk, {
      headers: {
        'x-api-key': apiKey,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      timeout: timeoutMs,
      signal,
    });

    for (const product of response.data?.data || []) {
      const id = cardIdentifier(product);
      if (id) hydrated.set(id, product);
    }
  }

  return hydrated;
}

async function fetchJustTcgEstimates(observations, { client = axios, signal, timeoutMs = DEFAULT_TIMEOUT_MS, apiKey = process.env.JUSTTCG_API_KEY } = {}) {
  const observedAt = new Date().toISOString();

  if (!apiKey) {
    return observations.map(observation => credentialsMissing(observation, observedAt));
  }

  const results = new Array(observations.length);
  const matches = [];

  for (let index = 0; index < observations.length; index += 1) {
    const observation = observations[index];
    const query = observation?.name || '';
    const match = await searchJustTcgProduct(observation, { client, signal, timeoutMs, apiKey });
    if (!match) {
      results[index] = insufficientMarketEvidence(observation, observedAt, 'No sufficiently strong JustTCG identity match', {
        url: `${API_BASE}/cards?game=pokemon&q=${encodeURIComponent(query)}`,
      });
    } else {
      matches.push({ index, observation, ...match });
    }
  }

  const hydrated = await hydrateMatchedProducts(matches, { client, signal, timeoutMs, apiKey });

  for (const match of matches) {
    const matchedId = cardIdentifier(match.product);
    const product = hydrated.get(matchedId) || match.product;
    results[match.index] = buildEstimateFromProduct(match.observation, product, match, observedAt);
  }

  return results;
}

async function fetchJustTcgEstimate(observation, options = {}) {
  const [estimate] = await fetchJustTcgEstimates([observation], options);
  return estimate;
}

module.exports = {
  fetchJustTcgEstimate,
  fetchJustTcgEstimates,
  selectBestProduct,
  scoreProductMatch,
  variantPrices,
  inferKind,
  marketErrorStatus,
  buildEstimateFromProduct,
  hydrateMatchedProducts,
};
