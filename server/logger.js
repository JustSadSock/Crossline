const os = require('os');
const pino = require('pino');

const level = process.env.CROSSLINE_LOG_LEVEL || 'info';

const logger = pino({
  level,
  base: {
    pid: process.pid,
    hostname: os.hostname(),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

module.exports = logger;
