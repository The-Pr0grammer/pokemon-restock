/**
 * stateManager.js — product state persistence and change detection.
 *
 * State file schema (products.json):
 *   {
 *     version: 2,
 *     lastSaved: "ISO timestamp",
 *     "<retailer>": {
 *       "<product.id>": {
 *         ...all product fields scraped from retailer,
 *         firstSeen:       "ISO timestamp",
 *         lastSeen:        "ISO timestamp",
 *         lastStockStatus: "in_stock" | "out_of_stock" | "pre_order",
 *       }
 *     }
 *   }
 *
 * Change detection rules:
 *   NEW       — product.id not previously seen for that retailer
 *   RESTOCK   — product was out_of_stock or pre_order, now in_stock
 *
 *   Both categories are filtered through:
 *     1. config.filterKeywords  (product name must match at least one keyword)
 *
 * Public API:
 *   loadState()                              — read products.json → state object
 *   saveState(state)                         — write state object → products.json
 *   compareAndUpdate(retailer, products, state)
 *                                            — diff current scrape vs stored state,
 *                                               mutate state in-place,
 *                                               return { newProducts, restockedProducts }
 *   initializeBaseline(allProductsByRetailer)— mark all products as known without notifying;
 *                                               writes products.json and returns baseline counts
 */

const fs   = require('fs');
const path = require('path');

const config      = require('./config');
const msrpChecker = require('./msrpChecker');  // kept as module ref so tests can stub findMsrp

// ── Constants ─────────────────────────────────────────────────────────────────

const STATE_FILE   = path.resolve(config.dataFile);
const STATE_DIR    = path.dirname(STATE_FILE);
const STATE_VERSION = 2;

// Stock statuses from which a transition to 'in_stock' counts as a restock.
const RESTOCK_FROM_STATUSES = new Set(['out_of_stock', 'pre_order']);

// ── State I/O ─────────────────────────────────────────────────────────────────

/**
 * Read products.json.
 * Returns an empty v2 state object when the file is absent, empty, or malformed.
 */
function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8').trim();
    if (!raw || raw === '{}') return emptyState();

    const parsed = JSON.parse(raw);

    // Migrate v1 state (flat retailer maps with no top-level version key).
    if (!parsed.version) {
      return migrateV1(parsed);
    }

    return parsed;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[StateManager] Could not read ${STATE_FILE}: ${err.message} — starting fresh`);
    }
    return emptyState();
  }
}

/**
 * Write state to products.json atomically (write to temp file then rename).
 */
function saveState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });

  state.lastSaved = new Date().toISOString();
  state.version   = STATE_VERSION;

  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

function emptyState() {
  return { version: STATE_VERSION, lastSaved: null };
}

/**
 * Migrate v1 format ({ target: {…}, walmart: {…} }) to v2.
 * V1 records lacked `lastStockStatus`; we derive it from the `inStock` boolean.
 */
function migrateV1(v1) {
  const state = emptyState();
  const knownRetailers = ['target', 'walmart', 'bestbuy'];

  for (const retailer of knownRetailers) {
    if (!v1[retailer] || typeof v1[retailer] !== 'object') continue;
    state[retailer] = {};
    for (const [id, rec] of Object.entries(v1[retailer])) {
      state[retailer][id] = {
        ...rec,
        lastStockStatus: rec.stockStatus ?? (rec.inStock ? 'in_stock' : 'out_of_stock'),
      };
    }
  }

  console.log('[StateManager] Migrated state file from v1 to v2 format');
  return state;
}

// ── Filtering ─────────────────────────────────────────────────────────────────

/**
 * Evaluate whether a product should trigger a notification.
 *
 * Returns { notify: boolean, msrp: object|null } where `msrp` is the lookup
 * result from the MSRP database (or null). The caller attaches `msrp` to the
 * notification payload; nothing is mutated here.
 *
 * Blocked (notify: false) when:
 *   - Name doesn't match any config.filterKeywords
 */
function evaluateForNotification(product) {
  // ── keyword filter ────────────────────────────────────────────────────────
  if (config.filterKeywords && config.filterKeywords.length > 0) {
    const name = (product.name ?? '').toLowerCase();
    if (!config.filterKeywords.some(kw => name.includes(kw))) {
      return { notify: false, msrp: null };
    }
  }

  const msrpData = msrpChecker.findMsrp(product.name);
  if (
    msrpData?.msrp != null &&
    Number.isFinite(product.priceNumeric) &&
    product.priceNumeric > msrpData.msrp * 1.2
  ) {
    return { notify: false, msrp: msrpData };
  }

  return { notify: true, msrp: msrpData ?? null };
}

// ── Core comparison ───────────────────────────────────────────────────────────

/**
 * Compare the current scrape results for one retailer against stored state.
 * Mutates `state` in-place (caller saves after processing all retailers).
 *
 * @param {string}   retailer        e.g. 'target', 'walmart', 'bestbuy'
 * @param {object[]} currentProducts Normalised product objects from a scraper
 * @param {object}   state           The full state object (mutated in-place)
 * @returns {{ newProducts: object[], restockedProducts: object[] }}
 */
function compareAndUpdate(retailer, currentProducts, state) {
  if (!state[retailer]) state[retailer] = {};

  const retailerState  = state[retailer];
  const now            = new Date().toISOString();
  const newProducts    = [];
  const restockedProducts = [];

  for (const product of currentProducts) {
    const { id } = product;
    if (!id) continue;

    const existing = retailerState[id];

    if (!existing) {
      // ── Branch: NEW product ───────────────────────────────────────────────
      retailerState[id] = buildRecord(product, now, now);

      if (product.inStock) {
        const { notify, msrp } = evaluateForNotification(product);
        if (notify) newProducts.push({ ...product, msrp, changeType: 'new' });
      }
      // OOS on first sight — stored silently; restock branch fires if it comes in later.

    } else {
      // ── Branch: KNOWN product ─────────────────────────────────────────────
      const prevStatus = existing.lastStockStatus ?? (existing.inStock ? 'in_stock' : 'out_of_stock');
      const currStatus = product.stockStatus ?? (product.inStock ? 'in_stock' : 'out_of_stock');

      // Update the stored record
      retailerState[id] = buildRecord(product, existing.firstSeen, now);

      // Restock: was unavailable/pre-order, now in_stock
      if (RESTOCK_FROM_STATUSES.has(prevStatus) && currStatus === 'in_stock') {
        const { notify, msrp } = evaluateForNotification(product);
        if (notify) {
          restockedProducts.push({ ...product, msrp, changeType: 'restock', previousStockStatus: prevStatus });
        }
      }

      // Log price changes for debugging (not a notification trigger by itself)
      if (
        existing.priceNumeric != null &&
        product.priceNumeric  != null &&
        existing.priceNumeric !== product.priceNumeric
      ) {
        console.log(
          `[StateManager] Price change for ${product.name}: ` +
          `${existing.price} → ${product.price}`,
        );
      }
    }
  }

  // Mark products not returned by the scraper as last-seen (don't remove them;
  // they may be temporarily absent from search results but still exist).
  const returnedIds = new Set(currentProducts.map(p => p.id));
  for (const id of Object.keys(retailerState)) {
    if (!returnedIds.has(id)) {
      retailerState[id].lastSeen = now;
    }
  }

  return { newProducts, restockedProducts };
}

// ── Baseline initialisation ───────────────────────────────────────────────────

/**
 * Mark every supplied product as known without queuing any notifications.
 * Intended for first-run setup so the next real run only alerts on genuinely
 * new or restocked items, not the entire existing catalog.
 *
 * @param {Object.<string, object[]>} allProductsByRetailer
 *   e.g. { target: [...], walmart: [...], bestbuy: [...] }
 * @returns {{ retailer: string, count: number }[]}  Per-retailer baseline counts.
 */
function initializeBaseline(allProductsByRetailer) {
  const state = loadState();
  const now   = new Date().toISOString();
  const summary = [];

  for (const [retailer, products] of Object.entries(allProductsByRetailer)) {
    if (!Array.isArray(products)) continue;
    if (!state[retailer]) state[retailer] = {};

    let count = 0;
    for (const product of products) {
      const { id } = product;
      if (!id) continue;

      // Don't overwrite an existing record — a prior run may have richer history.
      if (!state[retailer][id]) {
        state[retailer][id] = buildRecord(product, now, now);
        count++;
      }
    }

    summary.push({ retailer, count });
    console.log(`[StateManager] Baseline: ${count} new records written for ${retailer}`);
  }

  saveState(state);
  console.log(`[StateManager] Baseline saved to ${STATE_FILE}`);

  return summary;
}

// ── Record builders ───────────────────────────────────────────────────────────

/**
 * Build the object stored in products.json for a single product.
 * `lastStockStatus` is persisted so the next run can detect transitions.
 */
function buildRecord(product, firstSeen, lastSeen) {
  return {
    ...product,
    firstSeen,
    lastSeen,
    lastStockStatus: product.stockStatus ?? (product.inStock ? 'in_stock' : 'out_of_stock'),
  };
}

// ── Utility ───────────────────────────────────────────────────────────────────

/**
 * Summarise the full state file: total products per retailer, stock breakdown.
 * Useful for diagnostics / CLI.
 */
function summarizeState(state) {
  const retailers = Object.keys(state).filter(k => !['version', 'lastSaved'].includes(k));
  const rows = [];

  for (const retailer of retailers) {
    const records = Object.values(state[retailer] ?? {});
    const inStock    = records.filter(r => r.lastStockStatus === 'in_stock').length;
    const outOfStock = records.filter(r => r.lastStockStatus === 'out_of_stock').length;
    const preOrder   = records.filter(r => r.lastStockStatus === 'pre_order').length;
    rows.push({ retailer, total: records.length, inStock, outOfStock, preOrder });
  }

  return rows;
}

// ── CLI ───────────────────────────────────────────────────────────────────────
// node stateManager.js                  → show current state summary
// node stateManager.js --baseline       → run baseline init with mock scraper data
// node stateManager.js --reset          → wipe products.json and start fresh

if (require.main === module) {
  const args = process.argv.slice(2);

  if (args.includes('--reset')) {
    try {
      fs.writeFileSync(STATE_FILE, JSON.stringify(emptyState(), null, 2));
      console.log(`[StateManager] Reset: ${STATE_FILE} cleared.`);
    } catch (err) {
      console.error(`[StateManager] Reset failed: ${err.message}`);
      process.exit(1);
    }
    process.exit(0);
  }

  if (args.includes('--baseline')) {
    console.log('[StateManager] Baseline mode: scraping all enabled retailers…');
    const { scrapeTarget }          = require('./scrapers/target');
    const { scrapeWalmart }         = require('./scrapers/walmart');
    const { scrapeBestBuy }         = require('./scrapers/bestbuy');
    const { scrapeAmazon }          = require('./scrapers/amazon');
    const { scrapeGameStop }        = require('./scrapers/gamestop');
    const { scrapeBarnesAndNoble }  = require('./scrapers/barnesandnoble');

    const scrapers = [
      { key: 'target',         fn: scrapeTarget,         enabled: config.retailers.target.enabled         },
      { key: 'walmart',        fn: scrapeWalmart,        enabled: config.retailers.walmart.enabled        },
      { key: 'bestbuy',        fn: scrapeBestBuy,        enabled: config.retailers.bestbuy.enabled        },
      { key: 'amazon',         fn: scrapeAmazon,         enabled: config.retailers.amazon.enabled         },
      { key: 'gamestop',       fn: scrapeGameStop,       enabled: config.retailers.gamestop.enabled       },
      { key: 'barnesandnoble', fn: scrapeBarnesAndNoble, enabled: config.retailers.barnesandnoble.enabled },
    ];

    (async () => {
      const allProducts = {};
      for (const { key, fn, enabled } of scrapers) {
        if (!enabled) { console.log(`[StateManager] ${key} disabled — skipping.`); continue; }
        console.log(`[StateManager] Scraping ${key}…`);
        try {
          allProducts[key] = await fn();
          console.log(`[StateManager] ${key}: ${allProducts[key].length} products`);
        } catch (err) {
          console.error(`[StateManager] ${key} scraper error: ${err.message}`);
          allProducts[key] = [];
        }
      }

      const summary = initializeBaseline(allProducts);
      console.log('\nBaseline complete:');
      for (const { retailer, count } of summary) {
        console.log(`  ${retailer}: ${count} products marked as baseline`);
      }
    })().catch(err => {
      console.error('[StateManager] Fatal:', err.message);
      process.exit(1);
    });

    return;
  }

  // Default: show state summary
  const state = loadState();

  if (!state.lastSaved) {
    console.log('[StateManager] No state file found. Run with --baseline to initialise.');
    process.exit(0);
  }

  console.log(`\nState file: ${STATE_FILE}`);
  console.log(`Last saved: ${state.lastSaved}`);
  console.log(`Version:    ${state.version}\n`);

  const rows = summarizeState(state);
  if (rows.length === 0) {
    console.log('No retailer data recorded yet.');
  } else {
    const header = 'Retailer'.padEnd(10) + 'Total'.padStart(7) + 'In-stock'.padStart(10) + 'OOS'.padStart(6) + 'Pre-order'.padStart(11);
    console.log(header);
    console.log('─'.repeat(header.length));
    for (const r of rows) {
      console.log(
        r.retailer.padEnd(10) +
        String(r.total).padStart(7) +
        String(r.inStock).padStart(10) +
        String(r.outOfStock).padStart(6) +
        String(r.preOrder).padStart(11),
      );
    }
  }
  console.log('');
}

module.exports = {
  loadState,
  saveState,
  compareAndUpdate,
  initializeBaseline,
  summarizeState,
};
