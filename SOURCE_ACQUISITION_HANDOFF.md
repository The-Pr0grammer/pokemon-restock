# CE Handoff — Retail Source Acquisition Logic

## Objective

The Observatory is a procurement engine first. The source layer must maximize trustworthy, actionable retail inventory observations while avoiding an endless anti-bot arms race.

The job is **not** "make HTML scraping work at any cost." The job is:

> Find the cheapest, most stable, retailer-native data surface that exposes product identity, acquisition price, and actionable availability; normalize it; report source health honestly when that surface is unavailable.

The upstream repo already points in this direction: Best Buy used an official API, Target used frontend JSON, Walmart relied on structured page data, Amazon used PA API, B&N used predictive-search JSON, and GameStop was explicitly treated as hostile to cloud IPs.

## Non-negotiable acquisition ladder

For every retailer, attempt strategies in this order. Do not skip downward unless the higher strategy is unavailable.

### Strategy A — Official API / documented retailer feed

Preferred whenever available.

Requirements:
- use official credentials only
- secrets only through environment variables
- preserve retailer-native product IDs/SKUs
- preserve retailer-native availability states
- do not fall back to HTML merely because credentials are absent during the same production run; report `credentials_missing` if the official path is the configured production strategy

Examples:
- Best Buy Products API
- Amazon Product Advertising API

### Strategy B — Public structured endpoint used by the retailer frontend

Use JSON/XHR/GraphQL/search endpoints that the public web frontend itself consumes when they are accessible without defeating access controls.

Requirements:
- discover the currently used request shape from the live public site/browser network behavior, not from stale assumptions
- keep endpoint/key/version details configurable where practical
- do not hard-code a stale frontend token without a health check
- capture the minimum fields needed for procurement
- preserve response provenance and strategy name
- if the endpoint starts returning challenge/deny responses, classify it as `blocked`; do not disguise that as parser failure or zero products

Examples historically used in this repo:
- Target RedSky
- B&N predictive-search JSON
- Walmart structured search/page data

### Strategy C — Server-rendered structured data

Use JSON-LD, embedded application state, or stable SSR product records when present in normal public HTML.

Requirements:
- parser must fail closed
- missing expected structured data after an otherwise valid page response => `parser_stale`
- obvious bot/challenge page => `blocked`, not `parser_stale`
- preserve fixtures from representative responses for parser tests

### Strategy D — Plain HTML parsing

Last-resort production strategy.

Requirements:
- only use selectors backed by fixtures/tests
- no silent inference of stock from missing buttons/text
- missing expected selectors => `parser_stale`
- hard time budget; do not let HTML fallback dominate run time

### Strategy E — Local/browser-assisted observation

Use only when a retailer is useful but consistently hostile to cloud collectors.

This is **not** a production anti-bot bypass. Do not add CAPTCHA solving, proxy rotation, fingerprint spoofing, or automated login circumvention.

Acceptable forms:
- local development collector run from the operator's normal browser/network
- browser-captured response fixtures used to update parsers
- manually supplied ordinary session material where the repo already supports it and the retailer permits normal public browsing

Cloud `run_monitor` must remain read-only and must report the source unavailable/blocked if no compliant cloud strategy exists.

## Source health contract

Every collector must return one of these semantic states. Never collapse them into `0 products`.

- `success` — collector reached its intended source and parsed it successfully
- `no_matches` — source parsed successfully but contained no relevant Pokemon TCG products
- `blocked` — access-control/bot/challenge/403/explicit deny surface
- `rate_limited` — 429 or equivalent
- `timeout` — source exceeded its hard time budget
- `credentials_missing` — configured official API requires credentials that are absent
- `credentials_invalid` — configured credentials were rejected
- `parser_stale` — source response is accessible, but expected schema/structure no longer matches
- `unavailable` — transport/service failure that does not fit the above
- `disabled` — source intentionally disabled

A healthy source returning zero products is different from a blocked or stale source. Preserve that distinction all the way through `run_monitor`.

## Required source telemetry

Add these optional source-status fields where practical:

```js
strategy_used       // official_api | frontend_json | ssr_structured | html | local_only
http_status         // last meaningful HTTP status, if any
content_type        // response content type, if meaningful
endpoint_family     // stable label, not necessarily full URL
challenge_detected  // boolean
parser_version      // simple local version string/number
attempt_count
```

Do not expose secrets or raw auth material.

## Retailer-specific instructions

### 1. Best Buy — make official API the production path

Current state: implementation exists; public HTML fallback times out in cloud runs without API access.

Instructions:
1. Treat the official Products API as the preferred production strategy.
2. If `BESTBUY_API_KEY` exists, use API mode only for the production sweep.
3. Preserve SKU, regular/current price, online availability, in-store availability, preorder state, and any high-demand/limited flag exposed by the API.
4. `in_store_only` remains procurement-actionable.
5. If the key is missing, report `credentials_missing`; do not burn most of the source budget on a slow HTML fallback in hosted `run_monitor`.
6. Keep HTML fallback only for local/dev diagnostics behind an explicit env flag such as `BESTBUY_ALLOW_HTML_FALLBACK=true`.
7. Add tests proving that missing credentials does not become timeout and that in-store-only products survive normalization.

Acceptance:
- hosted run with key: structured observations or honest API error
- hosted run without key: fast `credentials_missing`

### 2. Target — re-discover the current structured frontend surface

Current state: RedSky implementation exists but Target is returning an anti-bot/deny response from hosted infrastructure.

Instructions:
1. Do not spend time stacking browser headers onto the stale RedSky request.
2. Inspect the current public Target search/category flow in a normal browser and identify the structured request currently supplying product search, price, and availability.
3. Determine whether RedSky is still the live frontend source, whether its request shape/key/version changed, or whether Target moved to another endpoint family.
4. Parameterize volatile values (frontend key/version/store/location) instead of freezing them into code when feasible.
5. Build a response classifier before the parser:
   - legitimate structured payload => parse
   - access denied/challenge => `blocked`
   - legitimate payload but schema mismatch => `parser_stale`
6. Preserve TCIN and separate shipping/pickup/store availability.
7. Do not add CAPTCHA solving, proxy rotation, or fingerprint evasion.
8. If no compliant hosted structured path works, leave Target as `blocked` in cloud and maintain fixture/local-development support so the adapter can be repaired quickly later.

Acceptance:
- no false `success: 0 products` on challenge pages
- no repeated retries against a known block in the same run
- exact TCIN identity preserved whenever data is available

### 3. Walmart — stop treating `__NEXT_DATA__` as the contract

Current state: implementation establishes homepage cookies then expects search-page `__NEXT_DATA__`; current hosted runs likely receive a bot-check page or a newer page architecture.

Instructions:
1. Retain the existing cookie/bootstrap strategy only if it still produces the real public page.
2. Inspect current Walmart search behavior in a normal browser for the structured request that actually populates search results now. Prefer current XHR/GraphQL/JSON over embedded `__NEXT_DATA__` if that is where the frontend moved.
3. Separate detection from parsing:
   - challenge/robot page => `blocked`
   - real page with no legacy `__NEXT_DATA__` => attempt current structured strategy; if no parser matches, `parser_stale`
4. Keep the first-party procurement gate mandatory. `sellerName === "Walmart.com"` or an independently verified Walmart seller identifier must be present before `procurement_eligible=true`.
5. Marketplace offers may be retained as observations for diagnostics but must never enter the retail acquisition/enrichment funnel as first-party procurement.
6. Preserve item ID, seller identity, shipping, pickup, preorder, and current price.
7. Do not create a cloud anti-bot bypass.

Acceptance:
- bot page classified `blocked`
- changed site architecture classified `parser_stale`, not out-of-stock
- marketplace listings cannot reach JustTCG enrichment

### 4. Costco — structured-data discovery before scraper tuning

Current state: collector exists; hosted request receives HTTP 403.

Instructions:
1. Treat 403 as `blocked`; do not retry with increasingly browser-like headers.
2. In a normal browser, inspect category/search/product traffic for a retailer-native JSON/XHR endpoint or SSR structured payload.
3. If a public structured endpoint is available without defeating controls, implement that as the production strategy.
4. If cloud access remains blocked, keep the collector implemented but source health `blocked`; do not mark it stale or empty.
5. Preserve membership requirement, bundle title, bundle quantity/components when exposed, item number, price, and fulfillment.
6. Do not match a Costco multi-product bundle directly to a single JustTCG sealed product unless bundle identity is explicitly equivalent.

Acceptance:
- 403 => fast blocked result
- bundle/unit economics preserved before market enrichment

### 5. Sam's Club — prove the data surface before changing selectors

Current state: public page is reachable but the parser yields no trustworthy Pokemon TCG listings and correctly reports `parser_stale`.

Instructions:
1. Keep `parser_stale` until a trustworthy source structure is identified.
2. Inspect the live browser network and page source for structured search/catalog data.
3. Prefer frontend JSON/XHR or embedded structured data over CSS selector expansion.
4. Create captured fixtures containing at least one known TCG result before changing the parser.
5. Tests must assert exact item identity, price, availability, membership/bundle signals, and rejection of unrelated Pokemon merchandise.
6. If the site genuinely parses successfully with no TCG results, only then return `no_matches`.

Acceptance:
- `no_matches` is only emitted after parser health is proven
- Pokemon toys/accessories cannot masquerade as TCG inventory

### 6. GameStop — do not fight the known cloud block

The upstream repo already treated GameStop as cloud-hostile.

Instructions:
1. Keep hosted source state honest (`blocked`/`disabled`) unless a normal public structured endpoint becomes available.
2. Local/browser-assisted mode may be used for parser maintenance and fixtures.
3. Do not add residential proxy rotation or challenge-solving infrastructure to the Observatory.
4. Preserve new-condition/public/member price and local fulfillment when a compliant source is available.

### 7. B&N — keep as the healthy reference adapter

Use B&N as a control source for the collector contract, not as the procurement universe.

Instructions:
- retain predictive-search collection
- search/catalog presence remains weaker than direct product verification
- direct product page verification should remain distinct
- use B&N fixtures/tests as examples of healthy structured-source behavior

## Runtime decision logic

Each source run should conceptually follow:

```text
select configured strategy
        |
        v
official API available? ------ yes ---> call official API
        | no
        v
public structured endpoint configured? ---> call + classify response
        | no / unhealthy
        v
SSR structured parser available? --------> fetch + classify + parse
        | no
        v
HTML fallback explicitly allowed? --------> fetch under hard time budget
        | no
        v
return honest source-health state
```

Do not automatically cascade through every possible strategy during hosted production runs if that creates long latency. Strategy selection should be explicit/configured once a retailer's best production path is known.

## Procurement normalization must remain downstream

Collectors acquire source-native facts. They should not decide market opportunity.

Required separation:

```text
retailer transport
    -> response classification
    -> source-native parse
    -> canonical observation
    -> procurement eligibility / seller / bundle rules
    -> dedupe
    -> market enrichment
    -> investigate/opportunity tier
```

This prevents a retailer parser from silently promoting weak data into a buy signal.

## Implementation order

Work in this order unless a newly discovered endpoint changes the economics:

1. **Best Buy API path** — highest confidence and easiest production win.
2. **Walmart current structured search surface** — huge inventory value; first-party filter already understood.
3. **Target current structured search surface** — huge inventory value; re-discover rather than header-tune.
4. **Sam's Club structured source discovery** — parser reachable; needs trustworthy schema.
5. **Costco structured source discovery** — useful, but current cloud 403 may make it non-viable hosted.
6. **GameStop** — leave blocked/local unless a compliant structured path appears.

B&N remains healthy reference/support throughout.

## Testing requirements

For every new/repaired strategy, add fixture-driven unit tests for:

- one valid in-stock Pokemon TCG product
- one out-of-stock/preorder product when source exposes it
- one irrelevant Pokemon/non-TCG product rejected
- one malformed/schema-changed payload -> `parser_stale`
- one access-denied/challenge payload -> `blocked`
- marketplace/third-party rejection where applicable
- canonical IDs and price preserved exactly

Network integration tests may be informative, but the test suite must not depend on live retailer availability to pass.

## Definition of done for this acquisition pass

The pass is successful when:

1. Best Buy no longer wastes hosted runtime on HTML when API credentials are absent.
2. Target and Walmart have current-source discovery documented in code/tests, and challenge pages are classified correctly.
3. Costco 403 is a fast, explicit `blocked`, not a retry storm.
4. Sam's Club has a fixture-backed parser for a current structured source or remains explicitly `parser_stale` with no fabricated observations.
5. Every source exposes the strategy it used in source health/diagnostics.
6. No source bypasses the procurement gate or sends ambiguous observations to JustTCG.
7. `run_monitor` remains read-only: no carting, checkout, purchases, account login automation, CAPTCHA solving, proxy rotation, or persistent retail-side mutation.

## Principle to preserve

**The Observatory should win by choosing better data surfaces, not by becoming better at impersonating a shopper.**
