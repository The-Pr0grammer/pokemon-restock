#!/usr/bin/env node

const crypto = require('crypto');
const express = require('express');
const { buildVisualSummary } = require('./generate-observations-dashboard');

process.env.NOTIFY_CHANNELS = '';
process.env.EMAIL_ENABLED = 'false';
for (const key of ['REDDIT_ENABLED','PC_ENABLED','TARGET_ENABLED','WALMART_ENABLED','BESTBUY_ENABLED','AMAZON_ENABLED','GAMESTOP_ENABLED','COSTCO_ENABLED','SAMSCLUB_ENABLED','MARKET_ENABLED']) process.env[key] = process.env[key] || 'true';
process.env.BN_ENABLED = 'true';
process.env.OBSERVATION_SOURCE = process.env.OBSERVATION_SOURCE || 'all';
process.env.MAX_PAGES = process.env.DRY_RUN_MAX_PAGES || '1';
process.env.BN_KEYWORD_LIMIT = process.env.BN_DRY_RUN_KEYWORD_LIMIT || '6';
process.env.SOURCE_TIMEOUT_MS = process.env.SOURCE_TIMEOUT_MS || '12000';
process.env.PC_QUEUE_SOURCE_TIMEOUT_MS = process.env.PC_QUEUE_SOURCE_TIMEOUT_MS || '8000';
process.env.MSRP_SOURCE_TIMEOUT_MS = process.env.MSRP_SOURCE_TIMEOUT_MS || '12000';
process.env.BESTBUY_SOURCE_TIMEOUT_MS = process.env.BESTBUY_SOURCE_TIMEOUT_MS || '9000';
process.env.BN_SOURCE_TIMEOUT_MS = process.env.BN_SOURCE_TIMEOUT_MS || '16000';
process.env.COSTCO_SOURCE_TIMEOUT_MS = process.env.COSTCO_SOURCE_TIMEOUT_MS || '12000';
process.env.SAMSCLUB_SOURCE_TIMEOUT_MS = process.env.SAMSCLUB_SOURCE_TIMEOUT_MS || '12000';
process.env.REDDIT_SOURCE_TIMEOUT_MS = process.env.REDDIT_SOURCE_TIMEOUT_MS || '8000';
process.env.MARKET_SOURCE_TIMEOUT_MS = process.env.MARKET_SOURCE_TIMEOUT_MS || '12000';
process.env.MARKET_PRICE_TIMEOUT_MS = process.env.MARKET_PRICE_TIMEOUT_MS || '3000';
process.env.MARKET_PRICE_MAX_OBSERVATIONS = process.env.MARKET_PRICE_MAX_OBSERVATIONS || '12';
process.env.BESTBUY_HTML_TIMEOUT_MS = process.env.BESTBUY_HTML_TIMEOUT_MS || '8000';
process.env.BESTBUY_HTML_MAX_ATTEMPTS = process.env.BESTBUY_HTML_MAX_ATTEMPTS || '1';

const { run } = require('../monitor');
const app = express();
const token = process.env.RUN_MONITOR_TOKEN || '';
let activeRun = null;
app.use(express.json({ limit: '1kb' }));

function isAuthorized(req) { return !token || req.get('authorization') === `Bearer ${token}`; }
function sourcesFrom(statuses) { return statuses.map(({ source, status, productCount, elapsedMs, message }) => ({ source, status, product_count: productCount, elapsed_ms: elapsedMs, message })); }
function publicBaseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  if (process.env.RENDER_EXTERNAL_HOSTNAME) return `https://${process.env.RENDER_EXTERNAL_HOSTNAME}`;
  return `${req.protocol}://${req.get('host')}`;
}

function historyPoint(point, fallbackDate) {
  if (!point || typeof point !== 'object') return null;
  const date = point.date || point.timestamp || point.observed_at || point.recorded_at || point.time || fallbackDate;
  const value = point.price ?? point.market_price ?? point.market ?? point.value ?? point.estimate ?? null;
  if (!date || typeof value !== 'number' || !Number.isFinite(value)) return null;
  return { date: String(date), market_price: value };
}

function buildNativeChartData(visualSummary) {
  const charts = [];
  for (const signal of visualSummary?.signals || []) {
    const history = Array.isArray(signal.price_history) ? signal.price_history : [];
    let points = history.map(p => historyPoint(p, visualSummary.generated_at)).filter(Boolean);
    if (!points.length && typeof signal.market_estimate === 'number') points = [{ date: visualSummary.generated_at, market_price: signal.market_estimate }];
    if (!points.length) continue;
    points.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    const rows = points.map(point => ({
      date: point.date,
      retail_price: typeof signal.retail_price === 'number' ? signal.retail_price : null,
      market_price: point.market_price,
      spread: typeof signal.retail_price === 'number' ? point.market_price - signal.retail_price : null,
      evidence_count: signal.evidence_count ?? 0,
      confidence: signal.confidence,
      tier: signal.tier,
      source: signal.source,
    }));
    charts.push({
      chart_type: 'line',
      title: `${signal.name} price history`,
      x_field: 'date',
      y_fields: ['retail_price', 'market_price'],
      x_label: 'Date',
      y_label: 'Price (USD)',
      interaction: 'hover',
      description: 'Render as an interactive line chart with hoverable points. Retail price is a benchmark line; market_price is the market history series. Do not collapse these rows into a two-bar retail-vs-market comparison.',
      product: signal.name,
      rows,
    });
  }
  return charts;
}

function openApiSpec(req) {
  return {
    openapi: '3.1.0',
    info: { title: 'Pokemon Restock Monitor', version: '0.2.0', description: 'Runs the safe Pokemon opportunity sweep and returns source statuses, canonical observations, market estimates, opportunity candidates, chart-ready visual_summary, and native_chart_data containing explicit time-series rows for interactive line charts.' },
    servers: [{ url: publicBaseUrl(req) }],
    paths: { '/run_monitor': { post: { operationId: 'run_monitor', summary: 'Run the safe Pokemon restock monitor dry-run and return chart-ready results', description: 'Runs a safe read-only retail sweep. For conversational price charts, use native_chart_data exactly as supplied: date is the x-axis and retail_price/market_price are y-series. Prefer interactive line charts with hover points; do not reduce time-series rows to two category bars.', security: [{ bearerAuth: [] }], responses: { 200: { description: 'Monitor completed with explicit chart-ready time-series data', content: { 'application/json': { schema: { $ref: '#/components/schemas/RunMonitorResponse' } } } }, 401: { description: 'Missing or invalid bearer token' }, 409: { description: 'A monitor run is already in progress' } } } } },
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } },
      schemas: {
        SourceStatus: { type: 'object', properties: { source:{type:'string'}, status:{type:'string'}, product_count:{type:'integer'}, elapsed_ms:{type:['integer','null']}, message:{type:['string','null']} } },
        Observation: { type: 'object', additionalProperties: true },
        NativeChartRow: { type:'object', properties:{ date:{type:'string'}, retail_price:{type:['number','null']}, market_price:{type:['number','null']}, spread:{type:['number','null']}, evidence_count:{type:'integer'}, confidence:{type:'string'}, tier:{type:'string'}, source:{type:'string'} }, required:['date','retail_price','market_price'] },
        NativeChart: { type:'object', description:'Explicit line-chart specification. Render rows as time series; date is x and y_fields are price series. Preserve hoverable points.', properties:{ chart_type:{type:'string',enum:['line']}, title:{type:'string'}, x_field:{type:'string',enum:['date']}, y_fields:{type:'array',items:{type:'string'}}, x_label:{type:'string'}, y_label:{type:'string'}, interaction:{type:'string',enum:['hover']}, description:{type:'string'}, product:{type:'string'}, rows:{type:'array',items:{$ref:'#/components/schemas/NativeChartRow'}} }, required:['chart_type','title','x_field','y_fields','rows'] },
        VisualSummary: { type:'object', description:'Chart-ready summary for source health, procurement funnel, and opportunity signals.', additionalProperties:true },
        RunMonitorResponse: { type:'object', properties:{ run_id:{type:'string'}, status:{type:'string'}, started_at:{type:'string'}, completed_at:{type:'string'}, duration_ms:{type:'integer'}, sources:{type:'array',items:{$ref:'#/components/schemas/SourceStatus'}}, observations:{type:'array',items:{$ref:'#/components/schemas/Observation'}}, market_estimates:{type:'array',items:{type:'object'}}, opportunity_candidates:{type:'array',items:{type:'object'}}, visual_summary:{$ref:'#/components/schemas/VisualSummary'}, native_chart_data:{type:'array',description:'Preferred input for native conversational price charts. Each item is an explicit date-based line-chart series.',items:{$ref:'#/components/schemas/NativeChart'}}, error:{type:'string'} }, required:['run_id','status','started_at','completed_at','duration_ms','sources','observations','market_estimates','opportunity_candidates','visual_summary','native_chart_data'] }
      }
    }
  };
}

async function executeRunMonitor() {
  const runId = crypto.randomUUID(); const startedAt = new Date().toISOString(); const t0 = Date.now();
  try {
    const result = await run({ isDryRun: true, forceInit: false });
    const completedAt = new Date().toISOString();
    const sources = sourcesFrom(result.sourceStatuses || []); const observations = result.observations || []; const marketEstimates = result.marketEstimates || []; const opportunityCandidates = result.opportunityCandidates || [];
    const visualSummary = buildVisualSummary({ observations, candidates: opportunityCandidates, sourceStatuses: { statuses: result.sourceStatuses || [] }, marketEstimates, generatedAt: completedAt });
    return { run_id:runId,status:'success',started_at:startedAt,completed_at:completedAt,duration_ms:Date.now()-t0,sources,observations,market_estimates:marketEstimates,opportunity_candidates:opportunityCandidates,visual_summary:visualSummary,native_chart_data:buildNativeChartData(visualSummary) };
  } catch (err) {
    const completedAt = new Date().toISOString(); const visualSummary = buildVisualSummary({ observations:[], candidates:[], sourceStatuses:{statuses:[]}, marketEstimates:[], generatedAt:completedAt });
    return { run_id:runId,status:'error',started_at:startedAt,completed_at:completedAt,duration_ms:Date.now()-t0,sources:[],observations:[],market_estimates:[],opportunity_candidates:[],visual_summary:visualSummary,native_chart_data:[],error:err.message };
  }
}

app.get('/health',(req,res)=>res.json({status:'ok',service:'pokemon-restock-run-monitor',auth_required:Boolean(token)}));
app.get('/openapi.json',(req,res)=>res.json(openApiSpec(req)));
app.post('/run_monitor',async(req,res)=>{ if(!isAuthorized(req)) return res.status(401).json({status:'unauthorized'}); if(activeRun) return res.status(409).json({status:'busy',message:'run_monitor is already in progress'}); activeRun=executeRunMonitor(); try{const response=await activeRun;res.status(response.status==='success'?200:500).json(response);}finally{activeRun=null;} });

if(require.main===module){const hasHostedPort=Boolean(process.env.PORT);const port=parseInt(process.env.RUN_MONITOR_PORT||process.env.PORT||'8787',10);const host=process.env.RUN_MONITOR_HOST||(hasHostedPort?'0.0.0.0':'127.0.0.1');app.listen(port,host,()=>{console.log(`[run_monitor] listening on http://${host}:${port}`);console.log(`[run_monitor] auth ${token?'enabled':'disabled'}${host==='127.0.0.1'?' (local bind)':''}`);});}
module.exports={app,executeRunMonitor,sourcesFrom,openApiSpec,publicBaseUrl,buildNativeChartData};
