# Procurement Access Checklist

This repo treats retailer access as an explicit source-health concern. A source that cannot be reached or authenticated must return a status such as `credentials_missing`, `blocked`, `parser_stale`, or `disabled`; it must not masquerade as `success` with zero products.

## Current access state

| Source | Production path | Last step to unlock | Expected status before unlock |
| --- | --- | --- | --- |
| Best Buy | Official Products API | Add `BESTBUY_API_KEY` | `credentials_missing` |
| Amazon | Product Advertising API | Add `AMAZON_ACCESS_KEY`, `AMAZON_SECRET_KEY`, and `AMAZON_PARTNER_TAG` | `credentials_missing` |
| JustTCG market data | JustTCG `/cards` search + batch API | Add `JUSTTCG_API_KEY` | `credentials_missing` or market evidence unavailable |
| Pokemon Center inventory | Browser session-backed product pages | Add `PC_COOKIE` and `PC_WATCH_URLS` if product-page scraping is needed | queue probe can succeed; inventory parser may be `parser_stale` |
| Target | Public structured frontend/API surface | Rediscover current browser-visible data route and update scraper fixtures | `blocked` or `parser_stale` |
| Walmart | Walmart I/O Product Catalog Snapshot API | Add `WALMART_CONSUMER_ID` and `WALMART_CLIENT_SECRET`, then set `WALMART_API_ENABLED=true` | `credentials_missing` |
| Costco | Public structured catalog surface | Identify browser-visible catalog/product data that is not blocked from hosted runs | `blocked` |
| Sam's Club | Public structured catalog surface | Capture fixture-backed healthy product structure before allowing `no_matches` | `parser_stale` |
| GameStop | Public structured frontend/API surface, if one exists | Revisit only if a clean structured route appears; hosted HTML currently blocks | `blocked` |
| Barnes & Noble | Public catalog/search data | No credential needed; use as control source | `success` when public catalog responds |

## Environment variables

Set production secrets in Render and GitHub Actions secrets/variables. Do not commit real credentials.

### Secrets

```text
BESTBUY_API_KEY=
JUSTTCG_API_KEY=
WALMART_CONSUMER_ID=
WALMART_CLIENT_SECRET=
AMAZON_ACCESS_KEY=
AMAZON_SECRET_KEY=
AMAZON_PARTNER_TAG=
PC_COOKIE=
RUN_MONITOR_TOKEN=
```

### Safe source toggles

```text
TARGET_ENABLED=true
WALMART_ENABLED=true
WALMART_API_ENABLED=false
WALMART_CATEGORY_ID=
WALMART_FEED_TYPE=
WALMART_MAX_FEED_PARTS=2
BESTBUY_ENABLED=true
GAMESTOP_ENABLED=true
BN_ENABLED=true
AMAZON_ENABLED=true
PC_ENABLED=true
COSTCO_ENABLED=true
SAMSCLUB_ENABLED=true
MARKET_ENABLED=true
JUSTTCG_BATCH_SIZE=20
JUSTTCG_PRICE_HISTORY_DURATION=90d
```

Keep `JUSTTCG_BATCH_SIZE=20` on the free tier. Raise it only after the account plan supports larger `/cards` POST batches.

Set `WALMART_API_ENABLED=true` only after Walmart I/O credentials are configured. Leaving `WALMART_FEED_TYPE` empty requests Walmart offers only; setting `WALMART_FEED_TYPE=catalog` includes marketplace offers too, which the adapter still filters out before procurement enrichment.

### Maintenance-only knobs

```text
BESTBUY_HTML_FALLBACK_ENABLED=false
```

Keep `BESTBUY_HTML_FALLBACK_ENABLED=false` in hosted production. Set it to `true` only for local parser maintenance when intentionally inspecting Best Buy HTML behavior without an API key.

## Activation order

1. Add `BESTBUY_API_KEY`, redeploy, and confirm Best Buy moves from `credentials_missing` to `success`, `no_matches`, `blocked`, or `credentials_invalid`.
2. Add `JUSTTCG_API_KEY`, redeploy, and confirm `market-estimates.json` includes JustTCG identity search attempts plus batched variant/history evidence for eligible retail observations.
3. Add Amazon PA API credentials only after the Associates account and Product Advertising API access are approved.
4. Add `PC_COOKIE` only if product-page inventory scraping is needed; queue probing remains separate.
5. Add Walmart I/O affiliate/catalog access, set `WALMART_CONSUMER_ID`, `WALMART_CLIENT_SECRET`, and `WALMART_API_ENABLED=true`, then confirm Walmart moves from `credentials_missing` to `success`, `no_matches`, `credentials_invalid`, or `blocked`.
6. For Target, Costco, Sam's Club, and GameStop, update collectors only after a browser-visible structured source is identified and fixture-backed tests prove the parser is healthy.

## Health-state meanings

| Status | Meaning |
| --- | --- |
| `success` | Source executed and parser was healthy. Product count may be zero only when the parser is known-good. |
| `no_matches` | Source was reachable and parser was healthy, but no eligible Pokemon TCG listings were present. |
| `blocked` | Retailer or network blocked the request, commonly 403/435/bot-check/challenge page. |
| `rate_limited` | Source returned an explicit throttling response. |
| `timeout` | Source exceeded its hard time budget. |
| `credentials_missing` | A required key/token/cookie was not configured. |
| `credentials_invalid` | Configured credentials were rejected by the provider. |
| `parser_stale` | Source was reachable enough to inspect, but the parser could not find the expected structured product data. |
| `unavailable` | Provider/network failed in a way that is not clearly auth, block, rate limit, timeout, or parser drift. |
| `disabled` | Source is intentionally off via env/config. |
