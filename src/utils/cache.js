// Generic version of the TTL + insertion-order-eviction cache already used for
// damage calculations (src/scrapers/serebii.js's damageCache) — same design,
// reusable for any Map<string, value> cache with an expiry and a max size.
function createCache({ ttlMs, maxSize }) {
  const store = new Map();

  function get(key) {
    const entry = store.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.timestamp > ttlMs) {
      store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  function set(key, value, timestamp = Date.now()) {
    if (!store.has(key) && store.size >= maxSize) {
      const oldestKey = store.keys().next().value;
      store.delete(oldestKey);
    }
    store.set(key, { value, timestamp });
  }

  function stats() {
    let oldestTimestamp = null;
    for (const entry of store.values()) {
      if (oldestTimestamp === null || entry.timestamp < oldestTimestamp) {
        oldestTimestamp = entry.timestamp;
      }
    }
    return {
      size: store.size,
      max: maxSize,
      oldest_entry_age_seconds: oldestTimestamp === null
        ? 0
        : Math.floor((Date.now() - oldestTimestamp) / 1000),
    };
  }

  return { get, set, stats };
}

module.exports = { createCache };
