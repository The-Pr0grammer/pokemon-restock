const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const { openApiSpec, publicBaseUrl } = require('../tools/run-monitor-service');

const OLD_PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL;
const OLD_RENDER_EXTERNAL_HOSTNAME = process.env.RENDER_EXTERNAL_HOSTNAME;

function makeReq(protocol = 'http', host = '127.0.0.1:8787') {
  return {
    protocol,
    get(name) {
      return name.toLowerCase() === 'host' ? host : undefined;
    },
  };
}

describe('run-monitor service OpenAPI server URL', () => {
  beforeEach(() => {
    delete process.env.PUBLIC_BASE_URL;
    delete process.env.RENDER_EXTERNAL_HOSTNAME;
  });

  afterEach(() => {
    if (OLD_PUBLIC_BASE_URL === undefined) delete process.env.PUBLIC_BASE_URL;
    else process.env.PUBLIC_BASE_URL = OLD_PUBLIC_BASE_URL;

    if (OLD_RENDER_EXTERNAL_HOSTNAME === undefined) delete process.env.RENDER_EXTERNAL_HOSTNAME;
    else process.env.RENDER_EXTERNAL_HOSTNAME = OLD_RENDER_EXTERNAL_HOSTNAME;
  });

  it('preserves localhost request origin for development', () => {
    assert.equal(publicBaseUrl(makeReq()), 'http://127.0.0.1:8787');
  });

  it('uses explicit PUBLIC_BASE_URL when configured', () => {
    process.env.PUBLIC_BASE_URL = 'https://pokemon-restock.onrender.com/';
    assert.equal(publicBaseUrl(makeReq()), 'https://pokemon-restock.onrender.com');
  });

  it('uses HTTPS for Render external hostnames', () => {
    process.env.RENDER_EXTERNAL_HOSTNAME = 'pokemon-restock.onrender.com';
    const spec = openApiSpec(makeReq('http', 'pokemon-restock.onrender.com'));
    assert.deepEqual(spec.servers, [{ url: 'https://pokemon-restock.onrender.com' }]);
  });

  it('advertises only run_monitor as a GPT action', () => {
    const spec = openApiSpec(makeReq());
    assert.deepEqual(Object.keys(spec.paths), ['/run_monitor']);
    assert.equal(spec.paths['/run_monitor'].post.operationId, 'run_monitor');
  });

  it('advertises visual_summary in the run_monitor payload', () => {
    const spec = openApiSpec(makeReq());
    const responseSchema = spec.components.schemas.RunMonitorResponse;
    assert.equal(spec.info.version, '0.2.0');
    assert.match(spec.info.description, /chart-ready visual_summary/);
    assert.match(spec.paths['/run_monitor'].post.summary, /chart-ready/);
    assert.match(spec.paths['/run_monitor'].post.description, /market opportunity graphs/);
    assert.ok(responseSchema.required.includes('visual_summary'));
    assert.deepEqual(responseSchema.properties.visual_summary, { $ref: '#/components/schemas/VisualSummary' });
    assert.equal(spec.components.schemas.VisualSummary.description.includes('Chart-ready summary'), true);
    assert.deepEqual(Object.keys(spec.components.schemas.VisualFunnel.properties), [
      'observed',
      'verified',
      'actionable',
      'enriched',
      'investigate',
      'opportunities',
    ]);
  });
});
