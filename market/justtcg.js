const axios = require('axios');

const API_BASE = 'https://api.justtcg.com/v1';
const MARKET_SOURCE = 'justtcg';
const DEFAULT_TIMEOUT_MS = parseInt(process.env.MARKET_PRICE_TIMEOUT_MS || '3500', 10);
const SEARCH_LIMIT = parseInt(process.env.JUSTTCG_SEARCH_LIMIT || '10', 10);
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
    }))
    .filter(variant => Number.isFinite(variant.price) && variant.price > 0);
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

async function fetchJustTcgEstimate(observation, { signal, timeoutMs = DEFAULT_TIMEOUT_MS, apiKey = process.env.JUSTTCG_API_KEY || process.env.PTCG_API_KEY } = {}) {
  const observedAt = new Date().toISOString();
  const query = observation?.name || '';

  if (!apiKey) {
    return {
      source: MARKET_SOURCE,
      status: 'credentials_missing',
      estimate: null,
      currency: 'USD',
      evidence_count: 0,
      observed_at: observedAt,
      query,
      url: null,
      message: 'JUSTTCG_API_KEY is not configured',
    };
  }

  const searchUrl = `${API_BASE}/cards`;
  const response = await axios.get(searchUrl, {
    params: {
      game: 'pokemon',
      q: query,
      limit: SEARCH_LIMIT,
    },
    headers: {
      'x-api-key': apiKey,
      Accept: 'application/json',
    },
    timeout: timeoutMs,
    signal,
  });

  const match = selectBestProduct(query, response.data?.data || []);
  if (!match) {
    return {
      source: MARKET_SOURCE,
      status: 'insufficient_market_evidence',
      estimate: null,
      currency: 'USD',
      evidence_count: 0,
      observed_at: observedAt,
      query,
      url: `${searchUrl}?game=pokemon&q=${encodeURIComponent(query)}`,
      message: 'No sufficiently strong JustTCG identity match',
    };
  }

  const prices = variantPrices(match.product);
  if (!prices.length) {
    return {
      source: MARKET_SOURCE,
      status: 'insufficient_market_evidence',
      estimate: null,
      currency: 'USD',
      evidence_count: 0,
      observed_at: observedAt,
      query,
      url: `${searchUrl}?cardId=${encodeURIComponent(match.product.id)}`,
      matched_product_id: match.product.id,
      matched_product_name: match.product.name,
      identity_match_score: match.score,
      message: 'Matched product has no positive USD variant prices',
    };
  }

  return {
    source: MARKET_SOURCE,
    status: 'success',
    estimate: Number(median(prices.map(entry => entry.price)).toFixed(2)),
    currency: 'USD',
    evidence_count: prices.length,
    observed_at: observedAt,
    market_as_of: prices.map(entry => entry.lastUpdated).filter(Boolean).sort().at(-1) || null,
    query,
    url: `${searchUrl}?cardId=${encodeURIComponent(match.product.id)}`,
    matched_product_id: match.product.id,
    matched_product_name: match.product.name,
    identity_match_score: match.score,
    provenance: 'JustTCG API variant prices',
  };
}

module.exports = {
  fetchJustTcgEstimate,
  selectBestProduct,
  scoreProductMatch,
  variantPrices,
  inferKind,
  marketErrorStatus,
};
