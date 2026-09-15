const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// Pure helper copied through a dependency-light require target in production.
const { preferredFailure } = require('../market/index');

describe('market provider chain', () => {
  it('preserves all attempts and prefers blocked over missing credentials', () => {
    const attempts = [
      { source: 'pokemontcgapi_tcgplayer', status: 'credentials_missing' },
      { source: 'ebay_sold', status: 'blocked' },
    ];
    const result = preferredFailure(attempts);
    assert.equal(result.status, 'blocked');
    assert.equal(result.source, 'ebay_sold');
    assert.deepEqual(result.attempts, attempts);
  });

  it('prefers insufficient evidence over generic unavailable', () => {
    const attempts = [
      { source: 'pokemontcgapi_tcgplayer', status: 'insufficient_market_evidence' },
      { source: 'ebay_sold', status: 'unavailable' },
    ];
    assert.equal(preferredFailure(attempts).status, 'insufficient_market_evidence');
  });
});
