/**
 * Reddit community alert monitor.
 *
 * Polls r/PokemonTCG and r/PokeInvesting for posts signalling restocks or
 * in-stock sightings. Uses Reddit's public JSON API — no credentials required.
 *
 * How it works:
 *   1. Fetches the 50 newest posts from each configured subreddit
 *   2. Checks title + body against restock signal keywords
 *   3. Skips posts already seen (tracked in data/reddit-seen.json)
 *   4. Returns matched posts as notification-ready objects
 *
 * Deduplication:
 *   Seen post IDs are persisted to data/reddit-seen.json between runs.
 *   The list is capped at MAX_SEEN_IDS to prevent unbounded growth.
 *
 * Rate limiting:
 *   Reddit's public JSON API allows ~1 request/second without OAuth.
 *   DELAY_MS (1 200 ms) keeps well within that limit.
 *
 * CLI:
 *   node monitors/reddit.js          → run and show matched posts
 *   node monitors/reddit.js --all    → show all fetched posts (pre-filter)
 *   node monitors/reddit.js --reset  → clear seen IDs and exit
 */

const fs    = require('fs');
const path  = require('path');
const axios = require('axios');
const { sleep, throwIfAborted } = require('../utils/retry');

// ── Constants ─────────────────────────────────────────────────────────────────

const SEEN_FILE    = path.resolve(__dirname, '../data/reddit-seen.json');
const MAX_SEEN_IDS = 1000;   // cap to prevent unbounded growth
const DELAY_MS     = 1200;   // polite gap between subreddit requests
const POST_LIMIT   = 50;     // posts per subreddit per run

const SUBREDDITS = [
  'PokemonTCG',
  'PokeInvesting',
];

// Post title/body must contain at least one of these to be considered a restock signal.
const RESTOCK_SIGNALS = [
  'restock', 'restocked', 'back in stock', 'in stock', 'available now',
  'just restocked', 'spotted', 'found at', 'just found', 'available at',
  'dropped', 'just dropped', 'live now', 'just went live', 'releasing',
  'just released', 'now available', 'picked up', 'just grabbed',
];

// Posts containing any of these in the title are skipped — they are requests,
// price discussions, or sold-out reports rather than stock-available alerts.
const NEGATIVE_SIGNALS = [
  'looking for', 'wtb', 'want to buy', 'iso ', 'sold out', 'out of stock',
  'oos', "can't find", 'cant find', 'where to find', 'anyone know',
  'price check', 'how much', 'worth it', 'sell for', 'selling for',
  'should i', 'is this fake',
];

// Known retailer names to extract from post text.
const RETAILER_PATTERNS = [
  { pattern: /\btarget\b/i,                       name: 'Target'           },
  { pattern: /\bwalmart\b/i,                       name: 'Walmart'          },
  { pattern: /\bbest\s?buy\b/i,                    name: 'Best Buy'         },
  { pattern: /\bamazon\b/i,                        name: 'Amazon'           },
  { pattern: /\bgamestop\b/i,                      name: 'GameStop'         },
  { pattern: /\bbarnes\s*(&|and)\s*noble\b|b&n\b/i, name: 'Barnes & Noble' },
  { pattern: /\bpokemon\s*center\b/i,              name: 'Pokemon Center'   },
  { pattern: /\bcostco\b/i,                        name: 'Costco'           },
  { pattern: /\bsam'?s\s*club\b/i,                 name: "Sam's Club"       },
  { pattern: /\bwalgreens\b/i,                     name: 'Walgreens'        },
  { pattern: /\bcvs\b/i,                           name: 'CVS'              },
  { pattern: /\bkroger\b/i,                        name: 'Kroger'           },
];

// ── HTTP ──────────────────────────────────────────────────────────────────────

const BASE_HEADERS = {
  'User-Agent': 'PokemonTCGRestockMonitor/1.0 (automated restock alert bot)',
  'Accept':     'application/json',
};

async function fetchNewPosts(subreddit, limit = POST_LIMIT, signal) {
  const url = `https://www.reddit.com/r/${subreddit}/new.json`;
  const res = await axios.get(url, {
    params:  { limit },
    headers: BASE_HEADERS,
    timeout: 20000,
    signal,
  });
  return res.data?.data?.children?.map(c => c.data) ?? [];
}

// ── Signal detection ──────────────────────────────────────────────────────────

function hasRestockSignal(post) {
  const text = `${post.title} ${post.selftext ?? ''}`.toLowerCase();

  // Reject if any negative signal is present
  if (NEGATIVE_SIGNALS.some(neg => text.includes(neg))) return false;

  // Accept if any positive signal is present
  return RESTOCK_SIGNALS.some(sig => text.includes(sig));
}

function extractRetailers(post) {
  const text = `${post.title} ${post.selftext ?? ''}`;
  return RETAILER_PATTERNS
    .filter(r => r.pattern.test(text))
    .map(r => r.name);
}

function extractExternalUrl(post) {
  // Reddit posts to an external site have url !== permalink
  if (post.url && !post.url.includes('reddit.com') && !post.url.startsWith('/r/')) {
    return post.url;
  }
  return null;
}

// ── Seen ID persistence ───────────────────────────────────────────────────────

function loadSeenIds() {
  try {
    const raw = fs.readFileSync(SEEN_FILE, 'utf8');
    return new Set(JSON.parse(raw).seenIds ?? []);
  } catch {
    return new Set();
  }
}

function saveSeenIds(seenSet, { persist = true } = {}) {
  if (!persist) return;
  const arr = [...seenSet].slice(-MAX_SEEN_IDS);
  fs.mkdirSync(path.dirname(SEEN_FILE), { recursive: true });
  fs.writeFileSync(SEEN_FILE, JSON.stringify({ seenIds: arr, lastUpdated: new Date().toISOString() }, null, 2));
}

// ── Normalise post → notification object ──────────────────────────────────────

function normalizePost(post) {
  const retailers  = extractRetailers(post);
  const externalUrl = extractExternalUrl(post);
  const redditUrl  = `https://www.reddit.com${post.permalink}`;

  return {
    id:           `reddit-${post.id}`,
    retailer:     'reddit',
    name:         post.title,
    brand:        null,
    price:        null,
    priceNumeric: null,
    regularPrice: null,
    url:          externalUrl ?? redditUrl,
    redditUrl,
    inStock:      true,
    stockStatus:  'in_stock',
    changeType:   'community_alert',
    subreddit:    post.subreddit,
    retailers,                          // detected retailer mentions in post
    score:        post.score ?? 0,
    releaseDate:  null,
  };
}

// ── Main scraper ──────────────────────────────────────────────────────────────

async function scrapeReddit({ signal, dryRun = false } = {}) {
  const enabled = process.env.REDDIT_ENABLED !== 'false';
  if (!enabled) {
    console.log('[Reddit] Disabled (REDDIT_ENABLED=false)');
    return [];
  }

  const subreddits = (process.env.REDDIT_SUBREDDITS || SUBREDDITS.join(','))
    .split(',').map(s => s.trim()).filter(Boolean);

  console.log(`[Reddit] Polling: ${subreddits.map(s => 'r/' + s).join(', ')}`);

  const seenIds  = loadSeenIds();
  const matched  = [];
  let   fetched  = 0;
  let   skipped  = 0;
  let   filtered = 0;
  let   blocked  = false;
  let   lastError = null;

  for (let i = 0; i < subreddits.length; i++) {
    throwIfAborted(signal);
    const sub = subreddits[i];

    let posts;
    try {
      posts = await fetchNewPosts(sub, POST_LIMIT, signal);
    } catch (err) {
      if (err.response?.status === 403 || err.response?.status === 429) err.sourceStatus = 'blocked';
      console.error(`[Reddit] Failed to fetch r/${sub}: ${err.message}`);
      blocked = blocked || err.sourceStatus === 'blocked';
      lastError = err;
      continue;
    }

    fetched += posts.length;

    for (const post of posts) {
      if (seenIds.has(post.id)) { skipped++; continue; }
      seenIds.add(post.id);

      if (!hasRestockSignal(post)) { filtered++; continue; }

      matched.push(normalizePost(post));
    }

    console.log(`[Reddit] r/${sub}: ${posts.length} posts fetched, ${matched.length} matched so far`);

    if (i < subreddits.length - 1) await sleep(DELAY_MS, signal);
  }

  saveSeenIds(seenIds, { persist: !dryRun });

  console.log(
    `[Reddit] Done: ${fetched} fetched, ${skipped} already seen, ` +
    `${filtered} filtered out, ${matched.length} new restock signals`,
  );

  if (blocked && fetched === 0) {
    lastError.sourceStatus = 'blocked';
    throw lastError;
  }

  return matched;
}

// ── CLI ───────────────────────────────────────────────────────────────────────

if (require.main === module) {
  require('dotenv').config();
  const args    = process.argv.slice(2);
  const showAll = args.includes('--all');

  if (args.includes('--reset')) {
    try { fs.unlinkSync(SEEN_FILE); } catch {}
    console.log('[Reddit] Seen IDs cleared.');
    process.exit(0);
  }

  scrapeReddit()
    .then(posts => {
      console.log(`\n${'─'.repeat(68)}`);
      console.log(`Reddit Restock Alerts — ${posts.length} new signal(s)`);
      console.log('─'.repeat(68));

      if (!posts.length) {
        console.log('\nNo new restock signals found.');
        return;
      }

      const display = showAll ? posts : posts.slice(0, 10);
      display.forEach((p, i) => {
        const retailers = p.retailers.length ? ` [${p.retailers.join(', ')}]` : '';
        console.log(`\n[${i + 1}] r/${p.subreddit}${retailers}`);
        console.log(`    ${p.name}`);
        console.log(`    Score: ${p.score}`);
        console.log(`    Reddit: ${p.redditUrl}`);
        if (p.url !== p.redditUrl) console.log(`    Link:   ${p.url}`);
      });

      console.log(`\n${'─'.repeat(68)}`);
    })
    .catch(err => {
      console.error('[Reddit] Fatal:', err.message);
      process.exit(1);
    });
}

module.exports = { scrapeReddit, hasRestockSignal, extractRetailers };
