'use strict';

function createObjectPool(createInstance, resetInstance, options = {}) {
  if (typeof createInstance !== 'function') {
    throw new TypeError('Object pool requires a factory function');
  }
  const free = [];
  const initialSize = Math.max(0, options.initialSize || 0);
  for (let i = 0; i < initialSize; i += 1) {
    free.push(createInstance());
  }

  return {
    acquire() {
      if (free.length > 0) {
        return free.pop();
      }
      return createInstance();
    },
    release(instance) {
      if (!instance) {
        return;
      }
      if (typeof resetInstance === 'function') {
        resetInstance(instance);
      }
      free.push(instance);
    },
    size() {
      return free.length;
    },
    prefill(count) {
      const numericCount = Number.isFinite(count) ? Math.floor(count) : 0;
      const target = Math.max(0, numericCount);
      while (free.length < target) {
        free.push(createInstance());
      }
    },
  };
}

module.exports = { createObjectPool };
