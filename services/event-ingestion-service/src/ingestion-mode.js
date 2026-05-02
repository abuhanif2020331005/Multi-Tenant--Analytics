const validIngestionModes = new Set(['direct', 'outbox', 'broker']);
const queuedIngestionModes = new Set(['outbox', 'broker']);

function normalizeIngestionMode(value, fallback = 'outbox') {
  const requestedMode = String(value || fallback).trim().toLowerCase();
  const normalizedMode = validIngestionModes.has(requestedMode) ? requestedMode : fallback;

  return {
    requestedMode,
    normalizedMode,
    usedFallback: requestedMode !== normalizedMode,
  };
}

function shouldQueueEvents(mode) {
  return queuedIngestionModes.has(mode);
}

module.exports = {
  normalizeIngestionMode,
  shouldQueueEvents,
};
