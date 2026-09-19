const GENERIC_WORDS = new Set(['pokemon', 'tcg', 'trading', 'card', 'cards', 'game', 'the', 'and', 'with', 'new', 'sealed', 'factory']);
const FORM_WORDS = new Set(['elite', 'trainer', 'box', 'booster', 'bundle', 'pack', 'sleeved', 'collection', 'tin', 'deck', 'premium', 'special', 'blister', 'board', 'set', 'of', 'scarlet', 'violet', 'sword', 'shield']);

function words(value) {
  return String(value || '').normalize('NFKD').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(Boolean);
}

function inferKind(name) {
  const text = String(name || '').toLowerCase();
  if (/elite trainer|\betb\b/.test(text)) return 'ETB';
  if (/booster box/.test(text)) return 'BOOSTER_BOX';
  if (/booster bundle/.test(text)) return 'BOOSTER_BUNDLE';
  if (/sleeved booster/.test(text)) return 'SLEEVED_BOOSTER';
  if (/booster pack/.test(text)) return 'BOOSTER_PACK';
  if (/starter deck|deluxe deck|theme deck|battle deck/.test(text)) return 'STARTER_DECK';
  if (/\btin\b/.test(text)) return 'TIN';
  if (/collection/.test(text)) return 'COLLECTION';
  if (/battle academy|board game/.test(text)) return 'BOARD_GAME';
  return null;
}

function identityTokens(name) {
  return words(name).filter(word => !GENERIC_WORDS.has(word));
}

function retailIdentityStatus(name) {
  if (!words(name).includes('pokemon')) return { confirmed: false, reason: 'retail_identity_unconfirmed' };
  if (/styles? may vary|assorted|random|mystery|surprise|lot of/i.test(name)) {
    return { confirmed: false, reason: 'retail_variant_unconfirmed' };
  }
  const specific = identityTokens(name).filter(word => !FORM_WORDS.has(word));
  if (!specific.length) return { confirmed: false, reason: 'retail_variant_unconfirmed' };
  return { confirmed: true, reason: null, product_kind: inferKind(name) };
}

function exactProductMatch(retailName, marketName) {
  if (!retailName || !marketName) return false;
  const retailKind = inferKind(retailName);
  const marketKind = inferKind(marketName);
  if (retailKind && marketKind && retailKind !== marketKind) return false;
  const retailTokens = identityTokens(retailName).sort();
  const marketTokens = identityTokens(marketName).sort();
  return retailTokens.length > 0 && retailTokens.length === marketTokens.length &&
    retailTokens.every((word, index) => word === marketTokens[index]);
}

module.exports = { words, inferKind, identityTokens, retailIdentityStatus, exactProductMatch };
