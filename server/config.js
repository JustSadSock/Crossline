const os = require('os');

const DEFAULT_MAX_BODY_BYTES = 64 * 1024;

function getCpuCount() {
  const cpus = os.cpus();
  if (Array.isArray(cpus) && cpus.length > 0) {
    return cpus.length;
  }
  return 1;
}

function parseBoolean(value) {
  if (typeof value === 'undefined' || value === null) {
    return null;
  }
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return null;
}

function parseWorkerTarget(value, cpuCount) {
  if (typeof value === 'undefined' || value === null) {
    return 0;
  }
  const trimmed = String(value).trim();
  if (!trimmed) {
    return 0;
  }
  if (trimmed.endsWith('%')) {
    const percentage = Number.parseFloat(trimmed.slice(0, -1));
    if (Number.isFinite(percentage) && percentage > 0) {
      const computed = Math.max(1, Math.floor((percentage / 100) * cpuCount));
      return Math.min(cpuCount, computed);
    }
    return 0;
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }
  return 0;
}

function resolveWorkerCount(cpuCount) {
  const overrides = [process.env.CROSSLINE_CLUSTER_WORKERS, process.env.WEB_CONCURRENCY];
  for (const candidate of overrides) {
    const parsed = parseWorkerTarget(candidate, cpuCount);
    if (parsed > 0) {
      return parsed;
    }
  }
  return cpuCount;
}

function resolveClusterEnabled(workerCount) {
  const flag = parseBoolean(process.env.CROSSLINE_CLUSTER);
  if (flag === false) {
    return false;
  }
  if (flag === true) {
    return workerCount > 1;
  }
  return workerCount > 1;
}

function parseOriginList(value) {
  if (!value) {
    return {
      allowAny: false,
      origins: [],
    };
  }

  let allowAny = false;
  const origins = [];

  for (const entry of String(value).split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) {
      continue;
    }

    if (trimmed === '*') {
      allowAny = true;
      continue;
    }

    origins.push(trimmed.replace(/\/+$/, ''));
  }

  return {
    allowAny,
    origins,
  };
}

function parseBodyLimit(value) {
  if (!value) {
    return DEFAULT_MAX_BODY_BYTES;
  }

  const numeric = Number.parseInt(String(value).trim(), 10);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return DEFAULT_MAX_BODY_BYTES;
  }

  return Math.min(numeric, 10 * 1024 * 1024);
}

const cpuCount = getCpuCount();
const workerCount = resolveWorkerCount(cpuCount);
const clusterEnabled = resolveClusterEnabled(workerCount);
const corsOriginsConfig = parseOriginList(process.env.CROSSLINE_CORS_ORIGIN);
const allowedCorsOrigins = new Set(corsOriginsConfig.origins.map((origin) => origin.toLowerCase()));
const maxBodyBytes = parseBodyLimit(process.env.CROSSLINE_MAX_BODY_BYTES);

module.exports = {
  cpuCount,
  cluster: {
    enabled: clusterEnabled,
    workers: workerCount,
  },
  security: {
    cors: {
      allowedOrigins: allowedCorsOrigins,
      allowSameHost: true,
      allowAny: corsOriginsConfig.allowAny,
    },
    http: {
      maxBodyBytes,
    },
    websocket: {
      allowedOrigins: allowedCorsOrigins,
      allowSameHost: true,
      allowAny: corsOriginsConfig.allowAny,
    },
  },
};
