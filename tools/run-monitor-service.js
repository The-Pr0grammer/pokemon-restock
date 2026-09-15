#!/usr/bin/env node

const crypto = require('crypto');
const express = require('express');

process.env.NOTIFY_CHANNELS = '';
process.env.EMAIL_ENABLED = 'false';
process.env.REDDIT_ENABLED = process.env.REDDIT_ENABLED || 'true';
process.env.PC_ENABLED = process.env.PC_ENABLED || 'true';
process.env.TARGET_ENABLED = process.env.TARGET_ENABLED || 'true';
process.env.WALMART_ENABLED = process.env.WALMART_ENABLED || 'true';
process.env.BESTBUY_ENABLED = process.env.BESTBUY_ENABLED || 'true';
process.env.AMAZON_ENABLED = process.env.AMAZON_ENABLED || 'true';
process.env.GAMESTOP_ENABLED = 'false';
process.env.BN_ENABLED = 'true';
process.env.OBSERVATION_SOURCE = 'barnesandnoble';
process.env.MAX_PAGES = process.env.DRY_RUN_MAX_PAGES || '1';
process.env.BN_KEYWORD_LIMIT = process.env.BN_DRY_RUN_KEYWORD_LIMIT || '6';
process.env.SOURCE_TIMEOUT_MS = process.env.SOURCE_TIMEOUT_MS || '12000';
process.env.PC_QUEUE_SOURCE_TIMEOUT_MS = process.env.PC_QUEUE_SOURCE_TIMEOUT_MS || '8000';
process.env.MSRP_SOURCE_TIMEOUT_MS = process.env.MSRP_SOURCE_TIMEOUT_MS || '12000';
process.env.BESTBUY_SOURCE_TIMEOUT_MS = process.env.BESTBUY_SOURCE_TIMEOUT_MS || '9000';
process.env.BN_SOURCE_TIMEOUT_MS = process.env.BN_SOURCE_TIMEOUT_MS || '16000';
process.env.REDDIT_SOURCE_TIMEOUT_MS = process.env.REDDIT_SOURCE_TIMEOUT_MS || '8000';
process.env.BESTBUY_HTML_TIMEOUT_MS = process.env.BESTBUY_HTML_TIMEOUT_MS || '8000';
process.env.BESTBUY_HTML_MAX_ATTEMPTS = process.env.BESTBUY_HTML_MAX_ATTEMPTS || '1';

const { run } = require('../monitor');

const app = express();
const token = process.env.RUN_MONITOR_TOKEN || '';
let activeRun = null;

app.use(express.json({ limit: '1kb' }));

function isAuthorized(req) {
  if (!token) return true;
  return req.get('authorization') === `Bearer ${token}`;
}

function sourcesFrom(statuses) {
  return statuses.map(({ source, status, productCount, elapsedMs, message }) => ({
    source,
    status,
    product_count: productCount,
    elapsed_ms: elapsedMs,
    message,
  }));
}

async function executeRunMonitor() {
  const runId = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  try {
    const result = await run({ isDryRun: true, forceInit: false });
    return {
      run_id: runId,
      status: 'success',
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      duration_ms: Date.now() - t0,
      sources: sourcesFrom(result.sourceStatuses || []),
      observations: result.observations || [],
    };
  } catch (err) {
    return {
      run_id: runId,
      status: 'error',
      started_at: startedAt,
      completed_at: new Date().toISOString(),
      duration_ms: Date.now() - t0,
      sources: [],
      observations: [],
      error: err.message,
    };
  }
}

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'pokemon-restock-run-monitor',
    auth_required: Boolean(token),
  });
});

app.post('/run_monitor', async (req, res) => {
  if (!isAuthorized(req)) {
    res.status(401).json({ status: 'unauthorized' });
    return;
  }

  if (activeRun) {
    res.status(409).json({ status: 'busy', message: 'run_monitor is already in progress' });
    return;
  }

  activeRun = executeRunMonitor();
  try {
    const response = await activeRun;
    res.status(response.status === 'success' ? 200 : 500).json(response);
  } finally {
    activeRun = null;
  }
});

if (require.main === module) {
  const port = parseInt(process.env.RUN_MONITOR_PORT || process.env.PORT || '8787', 10);
  const host = process.env.RUN_MONITOR_HOST || '127.0.0.1';
  app.listen(port, host, () => {
    console.log(`[run_monitor] listening on http://${host}:${port}`);
    console.log(`[run_monitor] auth ${token ? 'enabled' : 'disabled'}${host === '127.0.0.1' ? ' (local bind)' : ''}`);
  });
}

module.exports = { app, executeRunMonitor, sourcesFrom };
