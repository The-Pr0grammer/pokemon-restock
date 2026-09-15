const axios = require('axios');
const cheerio = require('cheerio');

const EBAY_SEARCH = 'https://www.ebay.com/sch/i.html';
const MARKET_SOURCE = 'ebay_sold';
const DEFAULT_TIMEOUT_MS = parseInt(process.env.MARKET_PRICE_TIMEOUT_MS || '3500', 10);
const MIN_EVIDENCE = parseInt(process.env.MARKET_PRICE_MIN_EVIDENCE || '3', 10);
const MAX_OBSERVATIONS = parseInt(process.env.MARKET_PRICE_MAX_OBSERVATIONS || '8', 10);

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

function normalizeWords(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function identityTokens(name) {
  const stop = new Set(['pokemon', 'pokémon', 'tcg', 'trading', 'card', 'game', 'the', 'and', 'with']);
  return normalizeWords(name).filter(w => !stop.has(w) && w.length > 2);
}

function parsePrice(value) {
  const match = String(value || '').replace(/,/g, '').match(/\$([0-9]+(?:\.[0-9]{1,2})?)/);
  return match ? Number(match[1]) : null;
}

function median(values) {
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function isRelevantSoldTitle(observationName, soldTitle) {
  const required = identityTokens(observationName);
  const sold = new Set(normalizeWords(soldTitle));
  if (!sold.has('pokemon') && !sold.has('pokémon')) return false;
  if (!required.length) return false;

  const matched = required.filter(token => sold.has(token)).length;
  return matched >= Math.min(2, required.length);
}

function extractSoldPrices(html, observationName) {
  const $ = cheerio.load(html);
  const prices = [];

  $('.s-item').each((_, el) => {
    const title = $(el).find('.s-item__title').text().trim();
    if (!isRelevantSoldTitle(observationName, title)) return;

    const price = parsePrice($(el).find('.s-item__price').first().text());
    if (price == null || price <= 0) return;
    prices.push(price);
  });

  return prices;
}

async function fetchEbaySoldEstimate(observation, { signal, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const observedAt = new Date().toISOString();
  const query = observation.name;
  const url = `${EBAY_SEARCH}?${new URLSearchParams({
    _nkw: query,
    _sacat: '0',
    LH_Sold: '1',
    LH_Complete: '1',
  })}`;

  const response = await axios.get(EBAY_SEARCH, {
    params: {
      _nkw: query,
      _sacat: '0',
      LH_Sold: '1',
      LH_Complete: '1',
    },
    headers: HEADERS,
    timeout: timeoutMs,
    signal,
  });

  const prices = extractSoldPrices(response.data, observation.name);
  const sample = prices.slice(0, 12);

  if (sample.length < MIN_EVIDENCE) {
    return {
      source: MARKET_SOURCE,
      status: 'insufficient_market_evidence',
      estimate: null,
      currency: 'USD',
      evidence_count: sample.length,
      observed_at: observedAt,
      query,
      url,
    };
  }

  return {
    source: MARKET_SOURCE,
    status: 'success',
    estimate: Number(median(sample).toFixed(2)),
    currency: 'USD',
    evidence_count: sample.length,
    observed_at: observedAt,
    query,
    url,
  };
}

function marketErrorStatus(err) {
  if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT' || err.name === 'AbortError') return 'timeout';
  if (err.response?.status === 401 || err.response?.status === 403 || err.response?.status === 429) return 'blocked';
  return 'unavailable';
}

async function estimateMarketPrices(observations, { signal } = {}) {
  const eligible = observations
    .filter(obs => obs.confidence === 'verified' && obs.name && typeof obs.price === 'number')
    .slice(0, MAX_OBSERVATIONS);

  const estimates = [];
  for (const observation of eligible) {
    try {
      estimates.push({
        product_id: observation.product_id,
        source_listing_id: observation.source_listing_id,
        market: await fetchEbaySoldEstimate(observation, { signal }),
      });
    } catch (err) {
      estimates.push({
        product_id: observation.product_id,
        source_listing_id: observation.source_listing_id,
        market: {
          source: MARKET_SOURCE,
          status: marketErrorStatus(err),
          estimate: null,
          currency: 'USD',
          evidence_count: 0,
          observed_at: new Date().toISOString(),
          query: observation.name,
          url: null,
          message: err.message,
        },
      });
    }
  }

  return estimates;
}

module.exports = {
  estimateMarketPrices,
  fetchEbaySoldEstimate,
  extractSoldPrices,
  isRelevantSoldTitle,
  parsePrice,
  marketErrorStatus,
};
