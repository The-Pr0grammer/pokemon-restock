#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const inputPath = process.argv[2] || 'artifacts/restock-dry-run/observations.json';
const outputPath = process.argv[3] || 'artifacts/restock-dry-run/dashboard.html';
const candidatesPath = process.argv[4] || path.join(path.dirname(inputPath), 'opportunity-candidates.json');

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatPrice(obs) {
  if (typeof obs.price !== 'number') return 'N/A';
  return `${obs.currency || 'USD'} ${obs.price.toFixed(2)}`;
}

function readObservations(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
}

const observations = readObservations(inputPath);
const candidates = readObservations(candidatesPath);
const generatedAt = new Date().toISOString();

const candidateRows = candidates.map(candidate => `
        <tr>
          <td class="product"><a href="${escapeHtml(candidate.retail?.url)}">${escapeHtml(candidate.name || 'Unnamed product')}</a></td>
          <td>${escapeHtml(formatPrice({ price: candidate.retail?.price, currency: candidate.retail?.currency }))}</td>
          <td>${escapeHtml(formatPrice({ price: candidate.market?.estimate, currency: candidate.market?.currency }))}</td>
          <td>${escapeHtml(candidate.math?.discount_pct ?? 'N/A')}%</td>
          <td>${escapeHtml(candidate.market?.source || 'unknown')} (${escapeHtml(candidate.market?.evidence_count ?? 0)} sold)</td>
          <td>${escapeHtml(candidate.confidence || 'unknown')}</td>
        </tr>`).join('');

const rows = observations.map(obs => `
        <tr>
          <td class="product"><a href="${escapeHtml(obs.url)}">${escapeHtml(obs.name || 'Unnamed product')}</a></td>
          <td>${escapeHtml(formatPrice(obs))}</td>
          <td><span class="pill">${escapeHtml(obs.availability || 'unknown')}</span></td>
          <td>${escapeHtml(obs.source || 'unknown')}</td>
          <td>${escapeHtml(obs.confidence || 'unknown')}</td>
          <td>${escapeHtml(obs.source_status || 'unknown')}</td>
        </tr>`).join('');

const emptyState = observations.length ? '' : `
      <div class="empty">
        No canonical observations were produced in this dry run.
      </div>`;

const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Restock Dry Run Dashboard</title>
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
      width: min(1080px, calc(100% - 32px));
      margin: 32px auto;
    }
    header {
      margin-bottom: 20px;
    }
    h1 {
      margin: 0 0 6px;
      font-size: 28px;
      line-height: 1.2;
    }
    h2 {
      margin: 24px 0 10px;
      font-size: 18px;
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
    @media (max-width: 720px) {
      main { width: min(100% - 20px, 1080px); margin: 18px auto; }
      table { display: block; overflow-x: auto; }
      th, td { white-space: nowrap; }
      .product { min-width: 240px; white-space: normal; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>Restock Dry Run Dashboard</h1>
      <div class="meta">Generated ${escapeHtml(generatedAt)} from ${escapeHtml(path.basename(inputPath))}</div>
      <div class="summary"><strong>${observations.length}</strong> canonical observation${observations.length === 1 ? '' : 's'}</div>
      <div class="summary"><strong>${candidates.length}</strong> opportunity candidate${candidates.length === 1 ? '' : 's'}</div>
    </header>
    ${candidates.length ? `<h2>Opportunity Candidates</h2>
    <table>
      <thead>
        <tr>
          <th>Product</th>
          <th>Retail</th>
          <th>Market Estimate</th>
          <th>Discount</th>
          <th>Evidence</th>
          <th>Confidence</th>
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
</body>
</html>
`;

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, html);
console.log(`[Dashboard] Wrote ${outputPath} from ${observations.length} observation(s)`);
