# CE Handoff — Lightweight Visual Summary

## Objective

Turn each monitor run into a clean, glanceable Observatory summary. Numbers remain the engine; charts are the dashboard.

Chart.js is now declared as the lightweight rendering dependency. Use it in the existing generated `dashboard.html`; do not add React, a frontend build system, a database, or a separate web application.

## Required first-pass charts

Keep this deliberately small. Add these charts above the existing tables:

1. **Source health — horizontal bar**
   - One row per enabled procurement source.
   - Encode health numerically only for rendering: success/no_matches = 1, degraded/parser_stale/rate_limited = 0.5, blocked/timeout/credentials_missing/unavailable = 0.
   - The visible label/tooltip MUST show the actual source status. The numeric rendering value is not a quality score and must never be persisted as one.
   - Purpose: instantly show how much of the procurement surface was actually visible this run.

2. **Procurement funnel — bar chart**
   - Raw/canonical observations
   - verified
   - actionable/in-stock
   - market enriched
   - investigate
   - opportunity candidates
   - Counts only. Never infer a missing stage as zero unless the run output actually establishes that count.

3. **Opportunity spread — horizontal bar**
   - Render investigation + opportunity candidates when present.
   - Product name as category; `discount_pct` or raw spread as the measure.
   - Visually/semantically distinguish `investigate` from `opportunity_candidate` in label/tooltip rather than pretending they have equal confidence.
   - If no signals exist, omit the chart instead of rendering an empty frame.

## Data contract

Do not make charts scrape HTML or recompute market logic. Build a small `visual_summary` object from canonical run outputs, then render from it. Suggested shape:

```json
{
  "generated_at": "ISO timestamp",
  "source_health": [{"source":"target","status":"blocked","observations":0}],
  "funnel": {
    "observed": 0,
    "verified": 0,
    "actionable": 0,
    "enriched": 0,
    "investigate": 0,
    "opportunities": 0
  },
  "signals": [{
    "name":"...",
    "tier":"investigate",
    "retail_price":24.99,
    "market_estimate":65.20,
    "raw_spread":40.21,
    "discount_pct":61.67,
    "source":"barnesandnoble"
  }]
}
```

Prefer deriving this object in the dashboard generator from existing JSON artifacts. If source statuses are not currently available to the generator, extend its CLI with an optional source-status path; missing optional files should degrade gracefully.

## Presentation

- Preserve the existing static single-file `dashboard.html` artifact.
- Responsive, dark-mode-safe, readable on phone and desktop.
- Use Chart.js defaults and restrained styling; no decorative animation dependency.
- Charts should render without network access. Bundle Chart.js into the generated artifact or otherwise ensure the Actions artifact is self-contained; do NOT depend on a CDN at view time.
- Existing tables remain below charts as the auditable detail layer.
- Tooltips should expose exact counts/prices/statuses.
- Never convert `investigate` into `opportunity` for visual simplicity.
- Never label JustTCG `evidence_count` as sold comps; it currently represents market evidence/variant-price observations.

## Implementation boundaries

- No purchasing, carts, checkout, logins, or notifications.
- No new external market calls for visualization.
- No chart should affect candidate scoring or procurement eligibility.
- Visualization failure must not fail the monitor run; dashboard generation may report a warning and preserve the JSON artifacts.

## Tests / acceptance

1. Existing dashboard still generates from an observations-only fixture.
2. Source health chart handles success, blocked, timeout, parser_stale, credentials_missing.
3. Funnel counts match fixture JSON exactly.
4. Investigation signal remains labeled investigate.
5. Opportunity signal remains labeled opportunity_candidate.
6. No-signal fixture omits the spread chart.
7. Product names/HTML are safely escaped in labels/fallback tables.
8. Generated HTML is self-contained and contains no CDN/network dependency.
9. Existing observation and candidate tables remain present.

Do this as a presentation layer only. Keep the scanner's canonical JSON outputs authoritative.
