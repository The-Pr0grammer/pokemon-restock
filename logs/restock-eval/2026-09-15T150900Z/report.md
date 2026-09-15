# Pokemon Restock Repo Evaluation

Date: 2026-09-15

## Scope

Evaluated `https://github.com/pranavtallapaka/pokemon-restock` as an experiment, not a production implementation. No Discord notification setup, no retailer logins, no purchases/orders, and no secrets were added.

## Repository

- Upstream: `https://github.com/pranavtallapaka/pokemon-restock`
- Local clone: `upstream-pokemon-restock`
- Local remotes: `origin` points to `https://github.com/The-Pr0grammer/pokemon-restock.git`; `upstream` points to `https://github.com/pranavtallapaka/pokemon-restock.git`.
- Branch: `main`
- Commit: `68c4219048645385aa426d3ea6763f6c0017a9fd`
- License: README says `MIT`; no separate `LICENSE` file is present and GitHub API reports `license: null`.
- Fork: `https://github.com/The-Pr0grammer/pokemon-restock`
- GitHub Actions run: none. The workflow file exists in the fork, but GitHub's Actions workflow listing/API did not yet show a registered runnable workflow after fork creation.

## Architecture

The repo is a Node.js CommonJS monitor. `monitor.js` orchestrates:

- Pokemon Center queue check
- MSRP database refresh from Pokemon Center
- parallel scraper runs for Target, Walmart, Best Buy, Amazon, GameStop, Barnes & Noble
- Reddit community-alert polling
- state comparison via `stateManager.js`
- notification routing via Discord/email notifiers
- state persistence to `data/products.json`

Scraper output is already partly normalized into common fields: `id`, `retailer`, product identifiers, `name`, `price`, `priceNumeric`, `url`, `inStock`, `stockStatus`, and optional retailer-specific fields. This is a useful starting point for a future source-gate pipeline.

## Credentials And Secrets

Expected credentials:

- `DISCORD_WEBHOOK_URL`, `DISCORD_COMMUNITY_WEBHOOK_URL` for Discord alerts
- `EMAIL_*`, `SMTP_*` for email alerts
- `BESTBUY_API_KEY` for reliable Best Buy API mode
- `AMAZON_ACCESS_KEY`, `AMAZON_SECRET_KEY`, `AMAZON_PARTNER_TAG` for Amazon PA API
- `PC_COOKIE` for Pokemon Center catalog scraping
- `LISTENER_SECRET` for the separate Discord listener service

No secrets were added. Amazon skipped safely because credentials were absent. Pokemon Center ran queue-only because `PC_COOKIE` was absent. Best Buy fell back to HTML mode because no `BESTBUY_API_KEY` was present.

## Verification

Dependency install:

- `npm ci --cache /private/tmp/npm-cache-pokemon-restock --no-audit --loglevel=warn`
- Result: passed after network approval.
- Earlier sandboxed attempts failed on DNS to `registry.npmjs.org` and npm's own "Exit handler never called" error.

Tests:

- Full `npm test` was stopped after two monitor subtests each took about 64s due external queue/network behavior.
- Narrowed non-monitor test run: 114 passed, 1 failed.
- Failing test: `tests/stateManager.test.js` expects products priced above 120% MSRP to be blocked.
- Current code does not implement that MSRP price gate; `evaluateForNotification()` only applies keyword filtering and attaches MSRP.

## Dry Run

Command:

```bash
/usr/bin/time -p node monitor.js --once --test
```

Result:

- Exit code: 0
- Wall time: 5m 8s (`real 308.83`)
- Total products checked: 16
- New products flagged: 2
- Notifications: skipped by `--test`
- Main state save: skipped by `--test`

Note: `--test` is not fully side-effect free. Pokemon Center queue history updated `data/pc-queue-history.json`, and Reddit wrote `data/reddit-seen.json`.

## Retailer Results

| Source | Result | Observations |
|---|---:|---|
| Pokemon Center queue | success | No active queue detected; 12 Queue-it probes returned 404. |
| Pokemon Center catalog/MSRP | failed | No MSRP products extracted; likely blocked or selectors stale. |
| Target | failed/empty | RedSky all-products pass failed with HTTP 435; returned 0 products. |
| Walmart | success | Monitor run returned 3 Walmart-sold products: 1 in stock, 2 OOS. Focused capture returned 2 products: 1 in stock, 1 OOS. Most search results were third-party and skipped. |
| Best Buy | failed/empty | No API key, HTML fallback timed out repeatedly; returned 0 products after about 294s. |
| Amazon | skipped | Missing PA API credentials; returned 0 products. |
| GameStop | disabled | Disabled by default due Cloudflare Enterprise blocking datacenter/GitHub Actions IPs. |
| Barnes & Noble | success/noisy | Returned 13 products: 12 in stock, 1 OOS. Two products were flagged as new. Several returned items are not TCG inventory, showing weak filtering. |
| Reddit | failed/empty | Public JSON fetches for `r/PokemonTCG` and `r/PokeInvesting` returned HTTP 403. |

## Product Data Captures

Raw logs and normalized records are preserved here:

- `monitor-once-test.log`
- `walmart-json.log`
- `barnesandnoble-json.log`
- `non-monitor-tests.log`
- `npm-test.log`

Notable captured Walmart products:

- `walmart-20895014480`: Pokemon Trading Card Game Quaquaval ex |Meowscarada ex Deluxe Battle Deck - Set of 2, `$39.97`, `in_stock`
- `walmart-188901265`: Pokemon Trading Card Game V-Union Special Collection Mewtwo/Greninja/Zacian - 4 Booster Packs, `$31.98`, `out_of_stock`

Notable Barnes & Noble products:

- `bn-9476135026929`: Pokemon TCG: XY3 Sleeved Booster Pack, `$3.95`, `in_stock`
- `bn-9476134371569`: Pokemon TCG: XY-Kalos Starter Set Deluxe Deck, `$14.95`, `in_stock`
- False-positive examples include books/model/toy-style products such as Pokemon Trainer Guess products, Pokemon model kit, and Pokemon investing/book titles.

## Reusable Pieces

Promising:

- Common normalized product shape across scrapers.
- Source-specific modules are already separated enough to wrap with source gates.
- State comparison has useful restock semantics: new product vs OOS/pre-order to in-stock.
- Retailer-specific evidence fields can be retained for provenance.
- Retry helper is reusable.

Needs work before production:

- Add explicit `source_type`, `source_listing_id`, `observed_at`, and `evidence` fields.
- Preserve unknown/unclassified observations rather than silently dropping them.
- Separate scraper collection from alert filtering.
- Make dry-run truly side-effect free, or clearly route dry-run artifacts to an eval output directory.
- Fix or remove the stale MSRP price-gate test/code mismatch.
- Use Best Buy API key for Best Buy; HTML fallback is too slow/brittle.
- Improve Barnes & Noble TCG filtering.
- Handle Target HTTP 435 and Reddit 403 explicitly as blocked/rate-limited states.
- Keep GitHub Actions schedule disabled until secrets/variables and dry-run safety are intentionally configured.
