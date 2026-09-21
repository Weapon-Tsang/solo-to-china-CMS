export function createSummaryCache({ ttlMs = 15_000, clock = Date.now } = {}) {
  let value, expires = 0, revision = null;
  return {
    read(compute, currentRevision = null) {
      if (value === undefined || clock() >= expires || (currentRevision !== null && currentRevision !== revision)) {
        value = compute(); expires = clock() + ttlMs; revision = currentRevision;
      }
      return value;
    },
    invalidate() { value = undefined; expires = 0; revision = null; },
  };
}
