const axios = require('axios');

const API_BASE = 'https://api.pokemontcgapi.com';
const MARKET_SOURCE = 'pokemontcgapi_tcgplayer';
const DEFAULT_TIMEOUT_MS = parseInt(process.env.MARKET_PRICE_TIMEOUT_MS || '3500', 10);
const SEARCH_LIMIT = parseInt(process.env.PTCG_API_SEARCH_LIMIT || '5', 10);
const MIN_MATCH_SCORE = Number(process.env.PTCG_API_MIN_MATCH_SCORE || '0.72');

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

function scoreProductMatch(observationName, product) {
  const wanted = identityTokens(observationName);
  const candidate = new Set(identityTokens(product?.name));
  if (!wanted.length || !candidate.size) return 0;

  const matched = wanted.filter(token => candidate.has(token)).length;
  const recall = matched / wanted.length;
  const precision = matched / candidate.size;
  const tokenScore = (recall * 0.7) + (precision * 0.3);

  const expectedKind = inferKind(observationName);
  if (expectedKind && product?.kind && expectedKind !== product.kind) return tokenScore * 0.45;

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

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function parseTcgplayerMarketQuotes(payload) {
  const quotes = payload?.data?.quotes || [];
  return quotes.filter(quote =>
    quote?.source === 'TCGPLAYER' &&
    quote?.variant === 'MARKET' &&
    quote?.currency === 'USD' &&
    Number.isFinite(Number(quote?.amount)) &&
    Number(quote.amount) > 0
  );
}

function marketErrorStatus(err) {
  if (err?.code === 'ECONNABORTED' || err?.code === 'ETIMEDOUT' || err?.name === 'AbortError') return 'timeout';
  if (err?.response?.status === 401) return 'credentials_invalid';
  if (err?.response?.status === 403 || err?.response?.status === 429) return 'blocked';
  if (err?.response?.status === 404) return 'insufficient_market_evidence';
  return 'unavailable';
}

async function fetchPtcgApiEstimate(observation, { signal, timeoutMs = DEFAULT_TIMEOUT_MS, apiKey = process.env.PTCG_API_KEY } = {}) {
  const observedAt = new Date().toISOString();
  if (!apiKey) {
    return {
      source: MARKET_SOURCE,
      status: 'credentials_missing',
      estimate: null,
      currency: 'USD',
      evidence_count: 0,
      observed_at: observedAt,
      query: observation?.name || null,
      url: null,
      message: 'PTCG_API_KEY is not configured',
    };
  }

  const headers = { 'X-Api-Key': apiKey, Accept: 'application/json' };
  const search = await axios.get(`${API_BASE}/v1/sealed`, {
    params: { q: observation.name, limit: SEARCH_LIMIT },
    headers,
    timeout: timeoutMs,
    signal,
  });

  const match = selectBestProduct(observation.name, search.data?.data || []);
  if (!match) {
    return {
      source: MARKET_SOURCE,
      status: 'insufficient_market_evidence',
      estimate: null,
      currency: 'USD',
      evidence_count: 0,
      observed_at: observedAt,
      query: observation.name,
      url: `${API_BASE}/v1/sealed?q=${encodeURIComponent(observation.name)}`,
      message: 'No sufficiently strong sealed-product identity match',
    };
  }

  const product = match.product;
  const priceUrl = `${API_BASE}/v1/sealed/${encodeURIComponent(product.id)}/prices`;
  const prices = await axios.get(priceUrl, {
    params: { source: 'TCGPLAYER', variant: 'MARKET' },
    headers,
    timeout: timeoutMs,
    signal,
  });

  const quotes = parseTcgplayerMarketQuotes(prices.data);
  if (!quotes.length) {
    return {
      source: MARKET_SOURCE,
      status: 'insufficient_market_evidence',
      estimate: null,
      currency: 'USD',
      evidence_count: 0,
      observed_at: observedAt,
      query: observation.name,
      url: priceUrl,
      matched_product_id: product.id,
      matched_product_name: product.name,
      identity_match_score: match.score,
      message: 'Matched product has no TCGplayer MARKET quote in USD',
    };
  }

  const amounts = quotes.map(quote => Number(quote.amount));
  const estimate = Number(median(amounts).toFixed(2));
  const latestAsOf = quotes.map(q => q.as_of).filter(Boolean).sort().at(-1) || null;

  return {
    source: MARKET_SOURCE,
    status: 'success',
    estimate,
    currency: 'USD',
    evidence_count: quotes.length,
    observed_at: observedAt,
    market_as_of: latestAsOf,
    query: observation.name,
    url: priceUrl,
    matched_product_id: product.id,
    matched_product_name: product.name,
    identity_match_score: match.score,
    basis: quotes[0]?.basis || null,
    provenance: 'TCGplayer via pokemontcgapi.com',
  };
}

module.exports = {
  fetchPtcgApiEstimate,
  selectBestProduct,
  scoreProductMatch,
  parseTcgplayerMarketQuotes,
  inferKind,
  marketErrorStatus,
};
