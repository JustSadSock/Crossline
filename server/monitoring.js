const client = require('prom-client');

const register = new client.Registry();
client.collectDefaultMetrics({
  register,
  prefix: 'crossline_',
});

const httpRequestsTotal = new client.Counter({
  name: 'crossline_http_requests_total',
  help: 'Total number of HTTP requests received',
  labelNames: ['method', 'status_bucket'],
});

const httpRequestDuration = new client.Histogram({
  name: 'crossline_http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'status_bucket'],
  buckets: [0.01, 0.05, 0.1, 0.3, 0.5, 1, 2, 5],
});

const serverErrorsTotal = new client.Counter({
  name: 'crossline_server_errors_total',
  help: 'Count of server side errors by origin',
  labelNames: ['origin'],
});

const websocketLatency = new client.Histogram({
  name: 'crossline_websocket_latency_seconds',
  help: 'Observed WebSocket round-trip latency in seconds',
  buckets: [0.01, 0.02, 0.05, 0.1, 0.25, 0.5, 1, 2],
});

register.registerMetric(httpRequestsTotal);
register.registerMetric(httpRequestDuration);
register.registerMetric(serverErrorsTotal);
register.registerMetric(websocketLatency);

const metrics = {
  requests: {
    total: 0,
    byStatus: {},
  },
  errors: 0,
  latency: {
    count: 0,
    total: 0,
    max: 0,
  },
  lastPingSamples: [],
};

const MAX_PING_SAMPLES = 50;

function normalizeMethod(value) {
  if (!value) {
    return 'UNKNOWN';
  }
  return String(value).toUpperCase();
}

function normalizeStatusBucket(statusCode) {
  const code = Number(statusCode) || 0;
  const bucket = Math.floor(code / 100) * 100;
  return bucket > 0 ? `${bucket}` : '0';
}

function trackRequest(method, statusCode, durationMs) {
  metrics.requests.total += 1;
  const bucket = normalizeStatusBucket(statusCode);
  metrics.requests.byStatus[bucket] = (metrics.requests.byStatus[bucket] || 0) + 1;
  const methodLabel = normalizeMethod(method);
  httpRequestsTotal.labels(methodLabel, bucket).inc();
  if (typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs >= 0) {
    httpRequestDuration.labels(methodLabel, bucket).observe(durationMs / 1000);
  }
}

function trackError(origin = 'general') {
  metrics.errors += 1;
  const label = origin && typeof origin === 'string' ? origin.toLowerCase() : 'general';
  let sanitized = label.replace(/[^a-z0-9_:-]/g, '_');
  if (!sanitized) {
    sanitized = 'general';
  }
  serverErrorsTotal.labels(sanitized).inc();
}

function recordLatency(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) {
    return;
  }
  metrics.latency.count += 1;
  metrics.latency.total += ms;
  if (ms > metrics.latency.max) {
    metrics.latency.max = ms;
  }
  metrics.lastPingSamples.push(ms);
  if (metrics.lastPingSamples.length > MAX_PING_SAMPLES) {
    metrics.lastPingSamples.shift();
  }
  websocketLatency.observe(ms / 1000);
}

function snapshot() {
  const average = metrics.latency.count ? metrics.latency.total / metrics.latency.count : 0;
  const recent = metrics.lastPingSamples.length
    ? metrics.lastPingSamples.reduce((sum, value) => sum + value, 0) / metrics.lastPingSamples.length
    : 0;
  return {
    requests: {
      total: metrics.requests.total,
      byStatus: { ...metrics.requests.byStatus },
    },
    errors: metrics.errors,
    latency: {
      average,
      peak: metrics.latency.max,
      recentAverage: recent,
      samples: metrics.lastPingSamples.slice(-10),
    },
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    pid: process.pid,
  };
}

async function collect() {
  return register.metrics();
}

module.exports = {
  trackRequest,
  trackError,
  recordLatency,
  snapshot,
  collect,
};
