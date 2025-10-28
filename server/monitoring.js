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

function trackRequest(statusCode) {
  metrics.requests.total += 1;
  const code = Number(statusCode) || 0;
  const bucket = Math.floor(code / 100) * 100;
  metrics.requests.byStatus[bucket] = (metrics.requests.byStatus[bucket] || 0) + 1;
}

function trackError() {
  metrics.errors += 1;
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

module.exports = {
  trackRequest,
  trackError,
  recordLatency,
  snapshot,
};
