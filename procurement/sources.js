const SOURCES = {
  target: {
    name: 'Target',
    tier: 1,
    role: 'primary_procurement',
    implemented: true,
    access: { mode: 'public_structured_surface', required_env: [] },
    first_party_required: true,
    preserve_local_inventory: true,
    notes: 'Priority source. Prefer exact SKU/TCIN identity and preserve pickup/shipping states separately.',
  },
  bestbuy: {
    name: 'Best Buy',
    tier: 1,
    role: 'primary_procurement',
    implemented: true,
    access: { mode: 'official_api', required_env: ['BESTBUY_API_KEY'] },
    first_party_required: true,
    preserve_local_inventory: true,
    notes: 'Priority source. Preserve in-store-only, preorder, high-demand and SKU signals.',
  },
  gamestop: {
    name: 'GameStop',
    tier: 1,
    role: 'primary_procurement',
    implemented: true,
    access: { mode: 'public_structured_surface', required_env: [] },
    first_party_required: true,
    preserve_local_inventory: true,
    notes: 'Priority source. Preserve new-condition and member-price signals separately.',
  },
  walmart: {
    name: 'Walmart',
    tier: 1,
    role: 'primary_procurement',
    implemented: true,
    access: { mode: 'public_structured_surface', required_env: [] },
    first_party_required: true,
    preserve_local_inventory: true,
    notes: 'Priority source. Marketplace contamination must never pass first-party procurement eligibility.',
  },
  pokemoncenter: {
    name: 'Pokemon Center',
    tier: 1,
    role: 'primary_procurement',
    implemented: true,
    access: { mode: 'public_with_optional_cookie', required_env: [], optional_env: ['PC_COOKIE', 'PC_WATCH_URLS'] },
    first_party_required: true,
    preserve_local_inventory: false,
    notes: 'Priority official source. Tag exclusives and never equate PC-exclusive variants with standard retail variants.',
  },
  barnesandnoble: {
    name: 'Barnes & Noble',
    tier: 2,
    role: 'supporting_procurement',
    implemented: true,
    access: { mode: 'public_catalog', required_env: [] },
    first_party_required: true,
    preserve_local_inventory: true,
    notes: 'Supporting source. Predictive-search availability is weaker evidence than a verified direct product page.',
  },
  amazon: {
    name: 'Amazon',
    tier: 2,
    role: 'supporting_procurement',
    implemented: true,
    access: { mode: 'official_api', required_env: ['AMAZON_ACCESS_KEY', 'AMAZON_SECRET_KEY', 'AMAZON_PARTNER_TAG'] },
    first_party_required: true,
    preserve_local_inventory: false,
    notes: 'Supporting source. Do not mix third-party marketplace sellers into first-party retail procurement signals.',
  },
  costco: {
    name: 'Costco',
    tier: 2,
    role: 'club_procurement',
    implemented: true,
    access: { mode: 'public_structured_surface', required_env: [] },
    first_party_required: true,
    preserve_local_inventory: true,
    notes: 'Club-store source. Bundle/unit economics and membership gating must be preserved.',
  },
  samsclub: {
    name: "Sam's Club",
    tier: 2,
    role: 'club_procurement',
    implemented: true,
    access: { mode: 'public_structured_surface', required_env: [] },
    first_party_required: true,
    preserve_local_inventory: true,
    notes: 'Club-store source. Bundle/unit economics and membership gating must be preserved.',
  },
};

function getProcurementSource(key) {
  return SOURCES[key] || null;
}

function implementedProcurementSources() {
  return Object.entries(SOURCES)
    .filter(([, source]) => source.implemented)
    .sort((a, b) => a[1].tier - b[1].tier)
    .map(([key, source]) => ({ key, ...source }));
}

module.exports = { SOURCES, getProcurementSource, implementedProcurementSources };
