# CE Handoff — Procurement Rule Set

The scanner's objective is procurement: discover buyable Pokemon TCG inventory across multiple retail fronts, normalize it safely, and only spend market-enrichment quota on observations that survive free eligibility checks.

## Source priority

Tier 1: Target, Best Buy, GameStop, Walmart, Pokemon Center.

Tier 2: Barnes & Noble, Amazon, Costco, Sam's Club.

`procurement/sources.js` is the source catalog. Costco and Sam's Club are intentionally scaffolded but marked `implemented: false` until collectors exist.

## Required retailer rules

### Target
- Preserve TCIN/SKU identity.
- Keep shipping, pickup, and local-store availability distinct when available.
- Only treat direct Target inventory as procurement-grade; reject marketplace/seller ambiguity.
- Keep preorder/new-release state rather than collapsing it into generic in-stock.

### Best Buy
- Prefer the official Products API when configured; HTML remains fallback.
- Preserve SKU, online availability, in-store availability, preorder, and high-demand/limited signals where exposed.
- `in_store_only` is still actionable procurement and must not be discarded.

### GameStop
- Only new-condition product should enter procurement eligibility.
- Preserve member/Pro pricing separately from public acquisition price when exposed.
- Preserve ship, pickup, same-day, and preorder states independently where possible.
- Cloudflare/anti-bot failure must remain a source-health state, never `0 products`.

### Walmart
- First-party seller gate is mandatory before procurement eligibility.
- `sellerName === "Walmart.com"` is preferred evidence; current scraper also has a known seller-ID fallback.
- Marketplace offers must not be compared to first-party retail acquisition prices.
- Preserve shipping and store fulfillment separately where available.

### Pokemon Center
- Tag Pokemon Center exclusives explicitly.
- Never normalize a Pokemon Center ETB or exclusive bundle onto the standard retail SKU merely because the set/product family matches.
- Queue health and product inventory are separate signals.

### Barnes & Noble
- Supporting source only.
- Predictive-search/catalog presence is not sufficient stock verification by itself.
- Search-result observations remain unverified until a direct product page confirms identity and availability.

### Amazon
- Default procurement-grade evidence should be sold directly by Amazon.com.
- Third-party/FBA offers must be separately identified and must not silently enter first-party retail comparisons.

### Costco / Sam's Club
- Add collectors after the Tier 1 sources are productive.
- Preserve membership requirement, bundle composition, quantity, and unit economics.
- A club bundle must not be matched to a single sealed product without decomposing contents or explicitly labeling the bundle identity.

## Canonical procurement fields

Extend canonical observations without breaking existing fields. Desired optional fields:

```js
seller_name
seller_type              // first_party | marketplace | unknown
fulfillment              // { shipping, pickup, same_day, in_store_only }
member_price
public_price
product_kind
variant_label
is_exclusive
exclusive_type
bundle_components
quantity
unit_acquisition_price
procurement_tier
procurement_eligible
procurement_reject_reason
```

The existing `confidence`, `verification_state`, `source_status`, price, URL, IDs and timestamps stay intact.

## Eligibility gate before JustTCG

Market enrichment is expensive relative to retail collection. The backend, not only the GPT prompt, must enforce this sequence:

1. successful collector
2. Pokemon-relevant product
3. deduplicate equivalent observations
4. direct/verified identity
5. in stock or otherwise explicitly actionable fulfillment state
6. usable acquisition price
7. first-party seller where the retailer has a marketplace
8. reject obvious accessory/non-TCG/bundle-vs-single ambiguity
9. only then request JustTCG enrichment

Do not retry blocked, ambiguous, duplicate, or low-confidence observations in the same run.

## Opportunity semantics

`opportunity_candidate` is reserved for strong identity and sufficient market evidence.

Large price dislocation with weak identity/evidence belongs in `investigate`.

Current default candidate guardrails after the latest sweep:
- identity score >= 0.85 when a score is present
- evidence count >= 2
- configured price-spread thresholds still apply

Missing market evidence means `not established`, not `no opportunity`.

## Acceptance criteria for this pass

1. Target, Best Buy, GameStop and Walmart each produce canonical observations independently when their source is healthy.
2. A blocked source reports `blocked`/`timeout`/other explicit health state, not an empty-success result.
3. Walmart marketplace listings cannot reach market enrichment.
4. Best Buy in-store-only items remain observable/actionable.
5. GameStop public price and member price are not conflated.
6. Pokemon Center exclusives cannot match standard retail variants without an explicit variant-safe identity path.
7. B&N search-only observations remain unverified.
8. JustTCG calls occur only after free procurement filters and dedupe.
9. Source-level tests cover each retailer-specific rule above.
10. Costco/Sam's remain disabled scaffolds until collectors and bundle-unit tests exist.

Keep `run_monitor` read-only: no carts, purchases, logins, checkout, notifications, or persistent state mutation from the GPT action.
