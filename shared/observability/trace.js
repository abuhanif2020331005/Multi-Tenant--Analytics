const crypto = require('crypto');

function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

function parseTraceparent(value) {
  const match = String(value || '').trim().match(/^([\da-f]{2})-([\da-f]{32})-([\da-f]{16})-([\da-f]{2})$/i);
  if (!match) {
    return null;
  }

  return {
    version: match[1].toLowerCase(),
    traceId: match[2].toLowerCase(),
    parentSpanId: match[3].toLowerCase(),
    traceFlags: match[4].toLowerCase(),
  };
}

function createTraceContext(headers) {
  const incomingTraceparent = headers['traceparent'];
  const parsed = parseTraceparent(incomingTraceparent);
  const traceId = parsed?.traceId || randomHex(16);
  const parentSpanId = parsed?.parentSpanId || null;
  const spanId = randomHex(8);
  const traceFlags = parsed?.traceFlags || '01';
  const traceparent = `00-${traceId}-${spanId}-${traceFlags}`;

  return {
    traceId,
    spanId,
    parentSpanId,
    traceFlags,
    traceparent,
    tracestate:
      typeof headers['tracestate'] === 'string' && headers['tracestate'].trim()
        ? headers['tracestate'].trim()
        : null,
    baggage:
      typeof headers['baggage'] === 'string' && headers['baggage'].trim()
        ? headers['baggage'].trim()
        : null,
  };
}

module.exports = {
  createTraceContext,
  parseTraceparent,
};
