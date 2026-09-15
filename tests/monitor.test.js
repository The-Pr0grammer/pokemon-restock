const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

// Load all module references BEFORE requiring monitor, so we get the same cached objects
const targetScraper  = require('../scrapers/target');
const walmartScraper = require('../scrapers/walmart');
const bestbuyScraper = require('../scrapers/bestbuy');
const amazonScraper  = require('../scrapers/amazon');
const gamestopScraper = require('../scrapers/gamestop');
const bnScraper      = require('../scrapers/barnesandnoble');
const pcScraper      = require('../scrapers/pokemoncenter');
const redditMonitor  = require('../monitors/reddit');
const notifierMod    = require('../notifier');
const msrpMod        = require('../msrpChecker');
const stateMod       = require('../stateManager');

const { run, buildCanonicalObservations, marketStatusFromEstimates } = require('../monitor');

const MOCK_PRODUCT = {
  id:           'target-111',
  retailer:     'target',
  name:         'Pokemon TCG Elite Trainer Box',
  price:        '$49.99',
  priceNumeric: 49.99,
  url:          'https://target.com/p/A-111',
  inStock:      true,
  stockStatus:  'in_stock',
};

// Capture and suppress console output during tests
let origLog, origWarn, origError;

beforeEach(() => {
  origLog   = console.log;
  origWarn  = console.warn;
  origError = console.error;
  console.log   = () => {};
  console.warn  = () => {};
  console.error = () => {};

  // Default stubs — no-op / clean returns
  msrpMod.updateMsrpDatabase  = async () => ({ count: 0, lastUpdated: new Date().toISOString() });
  targetScraper.scrapeTarget   = async () => [];
  walmartScraper.scrapeWalmart = async () => [];
  bestbuyScraper.scrapeBestBuy = async () => [];
  amazonScraper.scrapeAmazon   = async () => [];
  gamestopScraper.scrapeGameStop = async () => [];
  bnScraper.scrapeBarnesAndNoble = async () => [];
  pcScraper.scrapePokemonCenter = async () => ({ queueEvent: null, isNewQueue: false, products: [] });
  redditMonitor.scrapeReddit    = async () => [];
  notifierMod.notify           = async () => ({});
  stateMod.loadState           = () => ({ version: 2, lastSaved: null });  // first run by default
  stateMod.saveState           = () => {};
  stateMod.initializeBaseline  = () => [{ retailer: 'target', count: 0 }];
  stateMod.compareAndUpdate    = () => ({ newProducts: [], restockedProducts: [] });
  stateMod.summarizeState      = () => [];
});

afterEach(() => {
  console.log   = origLog;
  console.warn  = origWarn;
  console.error = origError;
});

describe('monitor.run — init mode', () => {
  it('calls initializeBaseline on first run (lastSaved === null)', async () => {
    let initCalled = false;
    stateMod.initializeBaseline = (byRetailer) => { initCalled = true; return []; };

    await run({ isDryRun: false, forceInit: false });
    assert.ok(initCalled);
  });

  it('calls initializeBaseline when forceInit=true even if state exists', async () => {
    stateMod.loadState = () => ({ version: 2, lastSaved: '2026-01-01T00:00:00.000Z' });
    let initCalled = false;
    stateMod.initializeBaseline = () => { initCalled = true; return []; };

    await run({ isDryRun: false, forceInit: true });
    assert.ok(initCalled);
  });

  it('does NOT call notify during init mode', async () => {
    let notifyCalled = false;
    notifierMod.notify = async () => { notifyCalled = true; return {}; };

    await run({ isDryRun: false, forceInit: false });
    assert.equal(notifyCalled, false);
  });

  it('returns { initMode: true } on first run', async () => {
    const result = await run({ isDryRun: false, forceInit: false });
    assert.equal(result.initMode, true);
  });
});

describe('monitor.run — normal mode', () => {
  beforeEach(() => {
    stateMod.loadState = () => ({ version: 2, lastSaved: '2026-01-01T00:00:00.000Z' });
  });

  it('does NOT call initializeBaseline on subsequent runs', async () => {
    let initCalled = false;
    stateMod.initializeBaseline = () => { initCalled = true; return []; };
    await run({ isDryRun: false, forceInit: false });
    assert.equal(initCalled, false);
  });

  it('calls notify when products are found', async () => {
    // compareAndUpdate is called once per enabled retailer (3 total); return a
    // product on the first call only so notify receives exactly 1 product.
    let callCount = 0;
    stateMod.compareAndUpdate = () => {
      callCount++;
      return callCount === 1
        ? { newProducts: [MOCK_PRODUCT], restockedProducts: [] }
        : { newProducts: [], restockedProducts: [] };
    };
    let notifiedProducts = null;
    notifierMod.notify = async (products) => { notifiedProducts = products; return {}; };

    await run({ isDryRun: false, forceInit: false });
    assert.ok(notifiedProducts !== null);
    assert.equal(notifiedProducts.length, 1);
  });

  it('calls saveState when not in dry-run', async () => {
    let saveCalled = false;
    stateMod.saveState = () => { saveCalled = true; };
    await run({ isDryRun: false, forceInit: false });
    assert.ok(saveCalled);
  });

  it('returns { newProducts, restockedProducts } from comparison', async () => {
    // compareAndUpdate is called once per enabled retailer (3 total); return the
    // product on the first call only so the result contains exactly 1 new product.
    let callCount = 0;
    stateMod.compareAndUpdate = () => {
      callCount++;
      return callCount === 1
        ? { newProducts: [MOCK_PRODUCT], restockedProducts: [] }
        : { newProducts: [], restockedProducts: [] };
    };
    const result = await run({ isDryRun: false, forceInit: false });
    assert.equal(result.newProducts.length, 1);
    assert.equal(result.restockedProducts.length, 0);
  });
});

describe('monitor.run — dry-run mode', () => {
  beforeEach(() => {
    stateMod.loadState = () => ({ version: 2, lastSaved: '2026-01-01T00:00:00.000Z' });
    stateMod.compareAndUpdate = () => ({ newProducts: [MOCK_PRODUCT], restockedProducts: [] });
  });

  it('does NOT call notify in dry-run mode', async () => {
    let notifyCalled = false;
    notifierMod.notify = async () => { notifyCalled = true; return {}; };
    await run({ isDryRun: true, forceInit: false });
    assert.equal(notifyCalled, false);
  });

  it('does NOT call saveState in dry-run mode', async () => {
    let saveCalled = false;
    stateMod.saveState = () => { saveCalled = true; };
    await run({ isDryRun: true, forceInit: false });
    assert.equal(saveCalled, false);
  });
});

describe('monitor.run — scraper error resilience', () => {
  beforeEach(() => {
    stateMod.loadState = () => ({ version: 2, lastSaved: '2026-01-01T00:00:00.000Z' });
  });

  it('continues processing when one scraper fails', async () => {
    targetScraper.scrapeTarget   = async () => { throw new Error('Target down'); };
    walmartScraper.scrapeWalmart = async () => [MOCK_PRODUCT];
    bestbuyScraper.scrapeBestBuy = async () => [];

    let compareCallCount = 0;
    stateMod.compareAndUpdate = () => { compareCallCount++; return { newProducts: [], restockedProducts: [] }; };

    // Should not throw; should still process walmart, bestbuy, and B&N
    await assert.doesNotReject(() => run({ isDryRun: true, forceInit: false }));
    // Target failed, so compareAndUpdate only called for successful retailers.
    assert.equal(compareCallCount, 3);
  });

  it('returns empty results when all scrapers fail', async () => {
    targetScraper.scrapeTarget   = async () => { throw new Error('down'); };
    walmartScraper.scrapeWalmart = async () => { throw new Error('down'); };
    bestbuyScraper.scrapeBestBuy = async () => { throw new Error('down'); };
    bnScraper.scrapeBarnesAndNoble = async () => { throw new Error('down'); };

    const result = await run({ isDryRun: true, forceInit: false });
    assert.equal(result.newProducts.length, 0);
    assert.equal(result.restockedProducts.length, 0);
  });
});

describe('monitor observations artifact', () => {
  it('emits canonical observations for the selected successful source', () => {
    const observations = buildCanonicalObservations(
      [{
        key: 'barnesandnoble',
        status: 'success',
        products: [{
          id: 'bn-9781234567890',
          retailer: 'barnesandnoble',
          ean: '9781234567890',
          shopifyId: 'gid://shopify/Product/123',
          name: 'Pokemon TCG Elite Trainer Box',
          priceNumeric: 49.99,
          url: '/w/example/9781234567890',
          inStock: true,
          stockStatus: 'in_stock',
        }],
      }],
      [{ source: 'barnesandnoble', status: 'success' }],
      '2026-09-15T00:00:00.000Z',
    );

    assert.deepEqual(observations, [{
      source: 'barnesandnoble',
      source_type: 'retail_listing',
      source_listing_id: 'gid://shopify/Product/123',
      product_id: '9781234567890',
      name: 'Pokemon TCG Elite Trainer Box',
      price: 49.99,
      currency: 'USD',
      availability: 'in_stock',
      url: 'https://www.barnesandnoble.com/w/example/9781234567890',
      observed_at: '2026-09-15T00:00:00.000Z',
      confidence: 'verified',
      verification_state: 'direct_product_page',
      source_status: 'success',
      raw_status: 'in_stock',
    }]);
  });
});

describe('monitor market status aggregation', () => {
  it('reports blocked when all market estimates are blocked', () => {
    assert.equal(marketStatusFromEstimates([
      { market: { status: 'blocked' } },
      { market: { status: 'blocked' } },
    ]), 'blocked');
  });

  it('reports insufficient evidence without creating success', () => {
    assert.equal(marketStatusFromEstimates([
      { market: { status: 'insufficient_market_evidence' } },
    ]), 'insufficient_market_evidence');
  });
});
