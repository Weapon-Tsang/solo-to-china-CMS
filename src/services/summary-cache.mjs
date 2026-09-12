export function createSummaryCache({ ttlMs = 15_000, clock = Date.now } = {}) {
  let value, expires = 0;
  return {
    read(compute) {
      if (value === undefined || clock() >= expires) { value = compute(); expires = clock() + ttlMs; }
      return value;
    },
    invalidate() { value = undefined; expires = 0; },
  };
}
