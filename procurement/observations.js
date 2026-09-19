const crypto = require('crypto');
const { SOURCES, getProcurementSource } = require('./sources');
const { retailIdentityStatus } = require('./product-identity');

const SOURCE_ALIASES = Object.fromEntries(
  Object.entries(SOURCES).flatMap(([key, source]) => [
    [key, key],
    [source.name.toLowerCase(), key],
    [source.name.toLowerCase().replace(/[^a-z0-9]+/g, ''), key],
  ]),
);

function sourceStatus(source, status, details = {}) {
  return {
    source,
    status,
    productCount: details.productCount ?? 0,
    elapsedMs: details.elapsedMs ?? null,
    message: details.message ?? null,
  };
}

function availabilityFromProduct(product) {
  if (product.stockStatus === 'pre_order') return 'pre_order';
  if (product.stockStatus === 'out_of_stock') return 'out_of_stock';
  if (product.inStock === true || product.stockStatus === 'in_stock') return 'in_stock';
  return 'unknown';
}

function canonicalUrl(product) {
  if (!product.url) return null;
  if (/^https?:\/\//i.test(product.url)) return product.url;
  if (product.retailer === 'barnesandnoble' && product.url.startsWith('/')) {
    return `https://www.barnesandnoble.com${product.url}`;
  }
  return product.url;
}

function canonicalObservation(product, sourceStatusEntry, observedAt) {
  const source = product.retailer || sourceStatusEntry?.source || process.env.OBSERVATION_SOURCE || 'all';
  const sourceListingId = product.shopifyId || product.tcin || product.sku || product.asin || product.ean || product.id || null;
  const productId = product.ean || product.tcin || product.sku || product.asin || product.id || sourceListingId;
  const url = canonicalUrl(product);
  const verificationState = sourceStatusEntry?.status !== 'success'
    ? 'unverified'
    : (!url ? 'inferred' : /\/search(?:\?|$)|[?&]q=/i.test(url) ? 'search_result' : 'direct_product_page');

  const observation = {
    source,
    source_type: 'retail_listing',
    source_listing_id: sourceListingId != null ? String(sourceListingId) : null,
    product_id: productId != null ? String(productId) : null,
    name: product.name || null,
    price: Number.isFinite(product.priceNumeric) ? product.priceNumeric : null,
    currency: product.priceNumeric != null ? 'USD' : null,
    availability: availabilityFromProduct(product),
    url,
    observed_at: observedAt,
    confidence: verificationState === 'direct_product_page' ? 'verified' : 'unverified',
    verification_state: verificationState,
    source_status: sourceStatusEntry?.status || 'unknown',
    raw_status: product.stockStatus || null,
  };

  const optionalFields = [
    'sellerName',
    'sellerType',
    'membershipRequired',
    'productKind',
    'bundleComponents',
    'quantity',
    'unitAcquisitionPrice',
    'fulfillment',
    'pickupStatus',
    'memberPrice',
    'publicPrice',
  ];

  for (const field of optionalFields) {
    if (product[field] !== undefined) {
      const canonicalField = field.replace(/[A-Z]/g, char => `_${char.toLowerCase()}`);
      observation[canonicalField] = product[field];
    }
  }

  return observation;
}

function buildCanonicalObservations(scraperResults, sourceStatuses, observedAt = new Date().toISOString(), options = {}) {
  const selectedSource = options.selectedSource || process.env.OBSERVATION_SOURCE || 'all';
  const selected = selectedSource === 'all'
    ? scraperResults.filter(result => result.status === 'success')
    : scraperResults.filter(result => result.key === selectedSource && result.status === 'success');

  return selected.flatMap(result => {
    const status = sourceStatuses.find(entry => entry.source === result.key);
    return (result.products || []).map(product => canonicalObservation(product, status, observedAt));
  });
}

function normalizeSourceKey(value) {
  const raw = String(value || '').trim();
  if (!raw) return 'external_web';
  const compact = raw.toLowerCase().replace(/[^a-z0-9]+/g, '');
  return SOURCE_ALIASES[raw.toLowerCase()] || SOURCE_ALIASES[compact] || raw.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

function parsePrice(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const numeric = Number(value.replace(/[^0-9.]+/g, ''));
  return Number.isFinite(numeric) ? numeric : null;
}

function directProductPageState(url, requestedState) {
  const state = String(requestedState || '').toLowerCase();
  if (state === 'direct_product_page' || state === 'verified_direct_product_page') return 'direct_product_page';
  if (state === 'search_result' || /\/search(?:\?|$)|[?&](q|query|keyword)=/i.test(url || '')) return 'search_result';
  if (!url) return 'unverified';
  return /\/search(?:\?|$)|[?&](q|query|keyword)=/i.test(url) ? 'search_result' : 'direct_product_page';
}

function normalizeAvailability(value) {
  const raw = String(value || '').trim();
  if (!raw) return { availability: 'unknown', hasEvidence: false, raw_status: null };
  const text = raw.toLowerCase();
  if (/\b(?:add to cart|buy now)\s+(?:is\s+)?disabled\b/.test(text)) {
    return { availability: 'unknown', hasEvidence: false, raw_status: raw };
  }
  if (/\b(pre[-\s]?order|preorder|coming soon)\b/.test(text)) return { availability: 'pre_order', hasEvidence: true, raw_status: raw };
  if (/\b(out of stock|sold out|unavailable|not available|currently unavailable)\b/.test(text)) {
    return { availability: 'out_of_stock', hasEvidence: true, raw_status: raw };
  }
  if (/\b(in stock|available|add to cart|ship(?:s|ping)?|pickup|pick up|available online)\b/.test(text)) {
    return { availability: 'in_stock', hasEvidence: true, raw_status: raw };
  }
  return { availability: 'unknown', hasEvidence: false, raw_status: raw };
}

function pickIdentifier(input, keys) {
  for (const key of keys) {
    if (input[key] != null && input[key] !== '') return String(input[key]);
  }
  const ids = input.identifiers && typeof input.identifiers === 'object' ? input.identifiers : {};
  for (const key of keys) {
    if (ids[key] != null && ids[key] !== '') return String(ids[key]);
  }
  return null;
}

function stableListingId(input, source, url) {
  const explicit = pickIdentifier(input, ['source_listing_id', 'listing_id', 'item_id', 'itemId', 'sku', 'tcin', 'asin', 'id']);
  if (explicit) return explicit;
  if (!url) return null;
  return `${source}:${crypto.createHash('sha1').update(url).digest('hex').slice(0, 12)}`;
}

function sellerEvidence(input) {
  return {
    seller_name: input.seller_name ?? input.sellerName ?? input.seller ?? input.merchant ?? null,
    seller_type: input.seller_type ?? input.sellerType ?? null,
  };
}

function matchesOfficialSeller(sourceKey, sellerName) {
  const source = getProcurementSource(sourceKey);
  const accepted = source?.official_seller_names || [];
  if (!sellerName || !accepted.length) return false;
  const normalized = sellerName.toLowerCase().replace(/[^a-z0-9]+/g, '');
  return accepted.some(name => name.toLowerCase().replace(/[^a-z0-9]+/g, '') === normalized);
}

function firstPartyStatus(sourceKey, observation) {
  const source = getProcurementSource(sourceKey);
  const sellerType = String(observation.seller_type || '').toLowerCase();
  const sellerName = observation.seller_name || '';
  if (sellerType === 'marketplace' || sellerType === 'third_party' || sellerType === '3p') {
    return { ok: false, reason: 'third_party_seller' };
  }
  if (!source) {
    return sellerType === 'first_party' && sellerName
      ? { ok: true, reason: null }
      : { ok: false, reason: 'seller_evidence_missing' };
  }
  if (!source.first_party_required) return { ok: true, reason: null };
  if (sellerName && matchesOfficialSeller(sourceKey, sellerName)) return { ok: true, reason: null };
  if (sellerName) return { ok: false, reason: 'third_party_seller' };
  return { ok: false, reason: 'seller_evidence_missing' };
}

function normalizeExternalObservation(input, index, defaultObservedAt = new Date().toISOString()) {
  const source = normalizeSourceKey(input.source ?? input.retailer ?? input.retailer_name);
  const name = input.name ?? input.product_name ?? input.title ?? null;
  const url = input.url ?? input.product_url ?? null;
  const price = parsePrice(input.price ?? input.current_price ?? input.sale_price ?? input.acquisition_cost);
  const acquisitionCost = parsePrice(input.acquisition_cost ?? price);
  const identity = retailIdentityStatus(name);
  const availabilityEvidence = normalizeAvailability(input.availability_text ?? input.availability ?? input.raw_status ?? input.stock_status);
  const verificationState = directProductPageState(url, input.verification_state ?? input.verification?.state);
  const confidenceRequested = String(input.confidence ?? input.verification?.confidence ?? '').toLowerCase();
  const confidence = confidenceRequested === 'verified' && verificationState === 'direct_product_page'
    ? 'verified'
    : (verificationState === 'direct_product_page' && availabilityEvidence.hasEvidence ? 'verified' : 'unverified');
  const sourceListingId = stableListingId(input, source, url);
  const productId = pickIdentifier(input, ['ean', 'upc', 'gtin', 'tcin', 'sku', 'asin', 'product_id', 'productId']) || sourceListingId;
  const seller = sellerEvidence(input);

  const observation = {
    source,
    source_type: 'external_web_observation',
    source_listing_id: sourceListingId,
    product_id: productId,
    name,
    price,
    acquisition_cost: acquisitionCost,
    acquisition_cost_basis: input.acquisition_cost != null ? 'submitted_total' : 'listed_price',
    currency: input.currency || (price != null ? 'USD' : null),
    availability: availabilityEvidence.availability,
    url,
    observed_at: input.observed_at || input.observedAt || defaultObservedAt,
    confidence,
    verification_state: verificationState,
    source_status: 'success',
    raw_status: availabilityEvidence.raw_status,
    seller_name: seller.seller_name,
    seller_type: seller.seller_type,
    product_kind: identity.product_kind || null,
    fulfillment: input.fulfillment ?? null,
    provenance: {
      input_index: index,
      retrieval: input.provenance ?? input.retrieval ?? null,
      verification: input.verification ?? null,
    },
  };

  const rejectReasons = [];
  if (!name) rejectReasons.push('product_name_missing');
  else if (!identity.confirmed) rejectReasons.push(identity.reason);
  if (!url) rejectReasons.push('url_missing');
  if (price == null || price <= 0 || acquisitionCost == null || acquisitionCost <= 0) rejectReasons.push('retail_price_missing');
  if (observation.currency !== 'USD') rejectReasons.push('currency_mismatch');
  if (!availabilityEvidence.hasEvidence) rejectReasons.push('availability_evidence_missing');
  if (verificationState !== 'direct_product_page' || confidence !== 'verified') rejectReasons.push('retail_observation_not_verified');
  if (availabilityEvidence.availability !== 'in_stock') rejectReasons.push('retail_not_in_stock');

  const firstParty = firstPartyStatus(source, observation);
  if (!firstParty.ok) rejectReasons.push(firstParty.reason);

  observation.procurement_eligible = rejectReasons.length === 0;
  observation.procurement_reject_reason = rejectReasons[0] || null;

  return { observation, rejectReasons };
}

function dedupeKey(observation) {
  return [
    observation.source || '',
    observation.product_id || '',
    observation.source_listing_id || '',
    observation.url || '',
  ].join('|').toLowerCase();
}

function normalizeExternalObservations(inputs, options = {}) {
  const observedAt = options.observedAt || new Date().toISOString();
  const observations = [];
  const eligibleObservations = [];
  const rejectedItems = [];
  const seen = new Map();

  (inputs || []).forEach((input, index) => {
    const { observation, rejectReasons } = normalizeExternalObservation(input || {}, index, observedAt);
    const key = dedupeKey(observation);
    if (seen.has(key)) {
      rejectedItems.push({ index, reason: 'duplicate_observation', reasons: ['duplicate_observation'], duplicate_of: seen.get(key), observation });
      return;
    }
    seen.set(key, index);
    observations.push(observation);

    if (observation.procurement_eligible) {
      eligibleObservations.push(observation);
    } else {
      rejectedItems.push({ index, reason: rejectReasons[0], reasons: rejectReasons, observation });
    }
  });

  return { observations, eligibleObservations, rejectedItems };
}

module.exports = {
  sourceStatus,
  availabilityFromProduct,
  canonicalUrl,
  canonicalObservation,
  buildCanonicalObservations,
  normalizeExternalObservation,
  normalizeExternalObservations,
  normalizeAvailability,
  normalizeSourceKey,
  firstPartyStatus,
};
