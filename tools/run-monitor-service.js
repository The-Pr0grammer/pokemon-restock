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

function publicBaseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  return `${req.protocol}://${req.get('host')}`;
}

function openApiSpec(req) {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Pokemon Restock Monitor',
      version: '0.1.0',
      description: 'Runs the safe Pokemon restock monitor dry-run and returns source statuses plus canonical observations.',
    },
    servers: [{ url: publicBaseUrl(req) }],
    paths: {
      '/health': {
        get: {
          operationId: 'health',
          summary: 'Check service health without running the monitor',
          responses: {
            200: {
              description: 'Service health status',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/HealthResponse' },
                },
              },
            },
          },
        },
      },
      '/run_monitor': {
        post: {
          operationId: 'run_monitor',
          summary: 'Run the safe Pokemon restock monitor dry-run',
          description: 'Runs the Barnes & Noble observation slice with notifications disabled and no persistent state mutation.',
          security: [{ bearerAuth: [] }],
          responses: {
            200: {
              description: 'Monitor completed and returned structured observations',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/RunMonitorResponse' },
                },
              },
            },
            401: {
              description: 'Missing or invalid bearer token',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
            409: {
              description: 'A monitor run is already in progress',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' },
                },
              },
            },
          },
        },
      },
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
        },
      },
      schemas: {
        HealthResponse: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            service: { type: 'string' },
            auth_required: { type: 'boolean' },
          },
          required: ['status', 'service', 'auth_required'],
        },
        SourceStatus: {
          type: 'object',
          properties: {
            source: { type: 'string' },
            status: { type: 'string' },
            product_count: { type: 'integer' },
            elapsed_ms: { type: ['integer', 'null'] },
            message: { type: ['string', 'null'] },
          },
          required: ['source', 'status', 'product_count', 'elapsed_ms', 'message'],
        },
        Observation: {
          type: 'object',
          properties: {
            source: { type: 'string' },
            source_type: { type: 'string' },
            source_listing_id: { type: ['string', 'null'] },
            product_id: { type: ['string', 'null'] },
            name: { type: ['string', 'null'] },
            price: { type: ['number', 'null'] },
            currency: { type: ['string', 'null'] },
            availability: { type: 'string' },
            url: { type: ['string', 'null'] },
            observed_at: { type: 'string' },
            confidence: { type: 'string' },
            source_status: { type: 'string' },
            raw_status: { type: ['string', 'null'] },
          },
          required: ['source', 'source_type', 'source_listing_id', 'product_id', 'name', 'price', 'currency', 'availability', 'url', 'observed_at', 'confidence', 'source_status', 'raw_status'],
        },
        RunMonitorResponse: {
          type: 'object',
          properties: {
            run_id: { type: 'string' },
            status: { type: 'string' },
            started_at: { type: 'string' },
            completed_at: { type: 'string' },
            duration_ms: { type: 'integer' },
            sources: {
              type: 'array',
              items: { $ref: '#/components/schemas/SourceStatus' },
            },
            observations: {
              type: 'array',
              items: { $ref: '#/components/schemas/Observation' },
            },
            error: { type: 'string' },
          },
          required: ['run_id', 'status', 'started_at', 'completed_at', 'duration_ms', 'sources', 'observations'],
        },
        ErrorResponse: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            message: { type: 'string' },
          },
          required: ['status'],
        },
      },
    },
  };
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

app.get('/openapi.json', (req, res) => {
  res.json(openApiSpec(req));
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
  const hasHostedPort = Boolean(process.env.PORT);
  const port = parseInt(process.env.RUN_MONITOR_PORT || process.env.PORT || '8787', 10);
  const host = process.env.RUN_MONITOR_HOST || (hasHostedPort ? '0.0.0.0' : '127.0.0.1');
  app.listen(port, host, () => {
    console.log(`[run_monitor] listening on http://${host}:${port}`);
    console.log(`[run_monitor] auth ${token ? 'enabled' : 'disabled'}${host === '127.0.0.1' ? ' (local bind)' : ''}`);
  });
}

module.exports = { app, executeRunMonitor, sourcesFrom };
