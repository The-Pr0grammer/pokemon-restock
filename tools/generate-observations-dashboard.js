#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const inputPath = process.argv[2] || 'artifacts/restock-dry-run/observations.json';
const outputPath = process.argv[3] || 'artifacts/restock-dry-run/dashboard.html';
const candidatesPath = process.argv[4] || path.join(path.dirname(inputPath), 'opportunity-candidates.json');
const sourceStatusesPath = process.argv[5] || path.join(path.dirname(inputPath), 'source-statuses.json');
const marketEstimatesPath = process.argv[6] || path.join(path.dirname(inputPath), 'market-estimates.json');
const visualSummaryPath = path.join(path.dirname(outputPath), 'visual-summary.json');

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeScriptJson(value) {
  return JSON.stringify(value).replaceAll('</', '<\\/');
}

function formatPrice(obs) {
  if (typeof obs.price !== 'number') return 'N/A';
  return `${obs.currency || 'USD'} ${obs.price.toFixed(2)}`;
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

function readChartJs() {
  const candidates = [path.join(process.cwd(), 'node_modules/chart.js/dist/chart.umd.js')];
  try {
    candidates.unshift(require.resolve('chart.js/dist/chart.umd.js'));
  } catch {
    // Fall back to the local node_modules path if package resolution is unavailable.
  }
  for (const filePath of candidates) {
    try {
      return fs.readFileSync(filePath, 'utf8');
    } catch {
      // Try the next local package path.
    }
  }
  return '';
}

function healthValue(status) {
  if (status === 'success' || status === 'no_matches') return 1;
  if (status === 'parser_stale' || status === 'rate_limited') return 0.5;
  return 0;
}

function healthColor(status) {
  if (status === 'success' || status === 'no_matches') return '#0f766e';
  if (status === 'parser_stale' || status === 'rate_limited') return '#d97706';
  return '#be123c';
}

function buildVisualSummary({ observations, candidates, sourceStatuses, marketEstimates, generatedAt }) {
  const statuses = Array.isArray(sourceStatuses?.statuses) ? sourceStatuses.statuses : [];
  const sourceHealth = statuses
    .filter(entry => entry.source !== 'market' && entry.status !== 'disabled')
    .map(entry => ({
      source: entry.source,
      status: entry.status || 'unknown',
      observations: Number(entry.product_count || 0),
      elapsed_ms: entry.elapsed_ms ?? null,
      message: entry.message || null,
      render_value: healthValue(entry.status),
    }));

  const enriched = Array.isArray(marketEstimates)
    ? marketEstimates.filter(entry => entry.market?.status === 'success').length
    : 0;
  const signals = candidates.map(candidate => ({
    name: candidate.name || 'Unnamed product',
    tier: candidate.candidate_type || candidate.status || 'unknown',
    retail_price: candidate.retail?.price ?? null,
    market_estimate: candidate.market?.estimate ?? null,
    raw_spread: candidate.math?.absolute_spread ?? null,
    discount_pct: candidate.math?.discount_pct ?? null,
    source: candidate.retail?.source || 'unknown',
    confidence: candidate.confidence || 'unknown',
  }));

  return {
    generated_at: generatedAt,
    source_health: sourceHealth,
    funnel: {
      observed: observations.length,
      verified: observations.filter(obs => obs.confidence === 'verified').length,
      actionable: observations.filter(obs => obs.availability === 'in_stock').length,
      enriched,
      investigate: signals.filter(signal => signal.tier === 'investigate').length,
      opportunities: signals.filter(signal => signal.tier === 'opportunity_candidate').length,
    },
    signals,
  };
}

function renderRows(observations) {
  return observations.map(obs => `
        <tr>
          <td class="product"><a href="${escapeHtml(obs.url)}">${escapeHtml(obs.name || 'Unnamed product')}</a></td>
          <td>${escapeHtml(formatPrice(obs))}</td>
          <td><span class="pill">${escapeHtml(obs.availability || 'unknown')}</span></td>
          <td>${escapeHtml(obs.source || 'unknown')}</td>
          <td>${escapeHtml(obs.confidence || 'unknown')}</td>
          <td>${escapeHtml(obs.source_status || 'unknown')}</td>
        </tr>`).join('');
}

function renderCandidateRows(candidates) {
  return candidates.map(candidate => `
        <tr>
          <td class="product"><a href="${escapeHtml(candidate.retail?.url)}">${escapeHtml(candidate.name || 'Unnamed product')}</a></td>
          <td>${escapeHtml(formatPrice({ price: candidate.retail?.price, currency: candidate.retail?.currency }))}</td>
          <td>${escapeHtml(formatPrice({ price: candidate.market?.estimate, currency: candidate.market?.currency }))}</td>
          <td>${escapeHtml(candidate.math?.discount_pct ?? 'N/A')}%</td>
          <td>${escapeHtml(candidate.market?.source || 'unknown')} (${escapeHtml(candidate.market?.evidence_count ?? 0)} evidence)</td>
          <td>${escapeHtml(candidate.candidate_type || candidate.confidence || 'unknown')}</td>
        </tr>`).join('');
}

function renderDashboard({ observations, candidates, visualSummary, generatedAt, chartJs }) {
  const candidateRows = renderCandidateRows(candidates);
  const rows = renderRows(observations);
  const emptyState = observations.length ? '' : `
      <div class="empty">
        No canonical observations were produced in this dry run.
      </div>`;
  const spreadChart = visualSummary.signals.length ? `
      <section class="viz">
        <h2>Opportunity Spread</h2>
        <canvas id="spreadChart" height="160"></canvas>
      </section>` : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Observatory Procurement Sweep</title>
  <style>
    :root {
      color-scheme: light;
      --ink: #1e293b;
      --muted: #64748b;
      --line: #d6dee8;
      --bg: #f7f9fc;
      --panel: #ffffff;
      --accent: #0f766e;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--bg);
      color: var(--ink);
    }
    main {
      width: min(1120px, calc(100% - 32px));
      margin: 32px auto;
    }
    header { margin-bottom: 20px; }
    h1 {
      margin: 0 0 6px;
      font-size: 28px;
      line-height: 1.2;
      letter-spacing: 0;
    }
    h2 {
      margin: 24px 0 10px;
      font-size: 18px;
      letter-spacing: 0;
    }
    .meta {
      color: var(--muted);
      font-size: 14px;
    }
    .summary {
      display: inline-flex;
      gap: 10px;
      align-items: center;
      margin-top: 14px;
      margin-right: 8px;
      padding: 8px 11px;
      border: 1px solid var(--line);
      background: var(--panel);
      border-radius: 6px;
      font-size: 14px;
    }
    .summary strong {
      color: var(--accent);
      font-size: 16px;
    }
    .viz-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 14px;
      margin: 22px 0 10px;
    }
    .viz {
      border: 1px solid var(--line);
      background: var(--panel);
      border-radius: 6px;
      padding: 14px;
      min-height: 250px;
    }
    .viz canvas {
      width: 100%;
      max-height: 320px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 6px;
      overflow: hidden;
    }
    th, td {
      padding: 12px 14px;
      text-align: left;
      border-bottom: 1px solid var(--line);
      vertical-align: top;
      font-size: 14px;
    }
    th {
      background: #eef4f8;
      color: #334155;
      font-weight: 650;
    }
    tr:last-child td { border-bottom: 0; }
    a {
      color: #0f5f9f;
      text-decoration: none;
    }
    a:hover { text-decoration: underline; }
    .product {
      min-width: 280px;
      font-weight: 600;
    }
    .pill {
      display: inline-block;
      padding: 3px 7px;
      border-radius: 999px;
      background: #e6f6f2;
      color: #0f766e;
      font-size: 12px;
      font-weight: 700;
      white-space: nowrap;
    }
    .empty {
      padding: 18px;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 6px;
      color: var(--muted);
    }
    .chart-warning {
      color: #9f1239;
      font-size: 14px;
    }
    @media (max-width: 800px) {
      main { width: min(100% - 20px, 1120px); margin: 18px auto; }
      .viz-grid { grid-template-columns: 1fr; }
      table { display: block; overflow-x: auto; }
      th, td { white-space: nowrap; }
      .product { min-width: 240px; white-space: normal; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>Observatory Procurement Sweep</h1>
      <div class="meta">Generated ${escapeHtml(generatedAt)} from ${escapeHtml(path.basename(inputPath))}</div>
      <div class="summary"><strong>${observations.length}</strong> canonical observation${observations.length === 1 ? '' : 's'}</div>
      <div class="summary"><strong>${candidates.length}</strong> opportunity signal${candidates.length === 1 ? '' : 's'}</div>
    </header>
    <div class="viz-grid">
      <section class="viz">
        <h2>Source Health</h2>
        <canvas id="sourceHealthChart" height="220"></canvas>
      </section>
      <section class="viz">
        <h2>Procurement Funnel</h2>
        <canvas id="funnelChart" height="220"></canvas>
      </section>
    </div>
    ${spreadChart}
    ${candidates.length ? `<h2>Opportunity Candidates</h2>
    <table>
      <thead>
        <tr>
          <th>Product</th>
          <th>Retail</th>
          <th>Market Estimate</th>
          <th>Discount</th>
          <th>Evidence</th>
          <th>Signal</th>
        </tr>
      </thead>
      <tbody>${candidateRows}
      </tbody>
    </table>` : ''}
    <h2>Observations</h2>
    ${emptyState || `<table>
      <thead>
        <tr>
          <th>Product</th>
          <th>Price</th>
          <th>Availability</th>
          <th>Source</th>
          <th>Confidence</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>${rows}
      </tbody>
    </table>`}
  </main>
  <script>${chartJs}</script>
  <script>
    const visualSummary = ${escapeScriptJson(visualSummary)};
    const healthColor = status => {
      if (status === 'success' || status === 'no_matches') return '#0f766e';
      if (status === 'parser_stale' || status === 'rate_limited') return '#d97706';
      return '#be123c';
    };
    if (!window.Chart) {
      document.querySelectorAll('.viz').forEach(section => {
        section.insertAdjacentHTML('beforeend', '<p class="chart-warning">Chart.js was not available when this artifact was generated.</p>');
      });
    } else {
      Chart.defaults.font.family = 'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
      Chart.defaults.color = '#334155';

      new Chart(document.getElementById('sourceHealthChart'), {
        type: 'bar',
        data: {
          labels: visualSummary.source_health.map(entry => entry.source),
          datasets: [{
            label: 'render value only',
            data: visualSummary.source_health.map(entry => entry.render_value),
            backgroundColor: visualSummary.source_health.map(entry => healthColor(entry.status)),
          }],
        },
        options: {
          indexAxis: 'y',
          responsive: true,
          maintainAspectRatio: false,
          scales: { x: { min: 0, max: 1, ticks: { callback: value => value === 1 ? 'visible' : value === 0.5 ? 'degraded' : 'unavailable' } } },
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: { label: context => {
              const entry = visualSummary.source_health[context.dataIndex];
              return entry.status + ' · ' + entry.observations + ' observation(s)' + (entry.message ? ' · ' + entry.message : '');
            } } },
          },
        },
      });

      const funnel = visualSummary.funnel;
      new Chart(document.getElementById('funnelChart'), {
        type: 'bar',
        data: {
          labels: ['Observed', 'Verified', 'Actionable', 'Enriched', 'Investigate', 'Opportunity'],
          datasets: [{ label: 'count', data: [funnel.observed, funnel.verified, funnel.actionable, funnel.enriched, funnel.investigate, funnel.opportunities], backgroundColor: '#0f766e' }],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: { legend: { display: false }, tooltip: { callbacks: { label: context => context.parsed.y + ' item(s)' } } },
          scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
        },
      });

      const spreadEl = document.getElementById('spreadChart');
      if (spreadEl) {
        new Chart(spreadEl, {
          type: 'bar',
          data: {
            labels: visualSummary.signals.map(signal => signal.name),
            datasets: [{
              label: 'discount pct',
              data: visualSummary.signals.map(signal => signal.discount_pct ?? signal.raw_spread ?? 0),
              backgroundColor: visualSummary.signals.map(signal => signal.tier === 'opportunity_candidate' ? '#0f766e' : '#d97706'),
            }],
          },
          options: {
            indexAxis: 'y',
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
              legend: { display: false },
              tooltip: { callbacks: { label: context => {
                const signal = visualSummary.signals[context.dataIndex];
                return signal.tier + ' · retail ' + signal.retail_price + ' · market ' + signal.market_estimate + ' · spread ' + signal.raw_spread + ' · discount ' + signal.discount_pct + '%';
              } } },
            },
            scales: { x: { beginAtZero: true } },
          },
        });
      }
    }
  </script>
</body>
</html>
`;
}

if (require.main === module) {
  const observations = readJson(inputPath, []);
  const candidates = readJson(candidatesPath, []);
  const sourceStatuses = readJson(sourceStatusesPath, { statuses: [] });
  const marketEstimates = readJson(marketEstimatesPath, []);
  const generatedAt = new Date().toISOString();
  const visualSummary = buildVisualSummary({ observations, candidates, sourceStatuses, marketEstimates, generatedAt });
  const chartJs = readChartJs();
  const html = renderDashboard({ observations, candidates, visualSummary, generatedAt, chartJs });

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(visualSummaryPath, JSON.stringify(visualSummary, null, 2));
  fs.writeFileSync(outputPath, html);
  console.log(`[Dashboard] Wrote ${outputPath} from ${observations.length} observation(s)`);
  console.log(`[Dashboard] Wrote ${visualSummaryPath}`);
}

module.exports = {
  buildVisualSummary,
  healthValue,
  renderDashboard,
};
