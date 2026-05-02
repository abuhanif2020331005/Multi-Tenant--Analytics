/**
 * OpenTelemetry tracer that exports spans to the OTel Collector via HTTP.
 *
 * Env vars:
 *   OTEL_ENABLED          – 'true' to enable (default: false)
 *   OTEL_EXPORTER_URL     – collector HTTP endpoint (default: http://otel-collector:4318)
 *   OTEL_SERVICE_NAME     – overrides the service name passed to createTracer()
 *   OTEL_SAMPLE_RATE      – 0.0–1.0 head-based sampling (default: 1.0)
 *
 * This is a lightweight manual implementation that avoids the heavy
 * @opentelemetry/sdk-node dependency so services stay lean.
 * For production, swap this out for the full OTel SDK.
 */

const crypto = require('crypto');

const OTEL_ENABLED = String(process.env.OTEL_ENABLED || 'false').toLowerCase() === 'true';
const COLLECTOR_URL = (process.env.OTEL_EXPORTER_URL || 'http://otel-collector:4318').replace(/\/$/, '');
const SAMPLE_RATE = Math.min(1, Math.max(0, Number(process.env.OTEL_SAMPLE_RATE || 1)));

function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString('hex');
}

function nowNs() {
  const [sec, ns] = process.hrtime();
  return BigInt(sec) * 1_000_000_000n + BigInt(ns);
}

function shouldSample() {
  return Math.random() < SAMPLE_RATE;
}

async function exportSpans(spans, serviceName) {
  if (!spans.length) return;

  const body = JSON.stringify({
    resourceSpans: [
      {
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: serviceName } },
            { key: 'telemetry.sdk.name', value: { stringValue: 'platform-manual-tracer' } },
          ],
        },
        scopeSpans: [
          {
            scope: { name: serviceName },
            spans: spans.map((span) => ({
              traceId: span.traceId,
              spanId: span.spanId,
              parentSpanId: span.parentSpanId || undefined,
              name: span.name,
              kind: span.kind || 1, // INTERNAL
              startTimeUnixNano: String(span.startNs),
              endTimeUnixNano: String(span.endNs),
              status: span.error
                ? { code: 2, message: span.error }
                : { code: 1 },
              attributes: Object.entries(span.attributes || {}).map(([key, value]) => ({
                key,
                value: typeof value === 'number'
                  ? { intValue: value }
                  : { stringValue: String(value) },
              })),
            })),
          },
        ],
      },
    ],
  });

  try {
    await fetch(`${COLLECTOR_URL}/v1/traces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    // Silently drop — tracing must never break the application
  }
}

function createTracer(serviceName) {
  const name = process.env.OTEL_SERVICE_NAME || serviceName;

  function startSpan(spanName, options = {}) {
    const sampled = OTEL_ENABLED && shouldSample();
    const traceId = options.traceId || randomHex(16);
    const spanId = randomHex(8);
    const startNs = nowNs();
    const attributes = { ...(options.attributes || {}) };

    return {
      traceId,
      spanId,
      parentSpanId: options.parentSpanId || null,
      name: spanName,
      kind: options.kind || 1,
      startNs,
      attributes,
      sampled,

      setAttribute(key, value) {
        attributes[key] = value;
        return this;
      },

      setError(error) {
        this.error = error?.message || String(error);
        attributes['error.type'] = error?.name || 'Error';
        attributes['error.message'] = this.error;
        return this;
      },

      async end() {
        if (!sampled) return;
        const endNs = nowNs();
        await exportSpans(
          [{ traceId, spanId, parentSpanId: options.parentSpanId || null, name: spanName, kind: options.kind || 1, startNs, endNs, attributes, error: this.error }],
          name
        );
      },
    };
  }

  /**
   * Wrap an async function with a span.
   * The span is automatically ended when the function resolves or rejects.
   */
  async function trace(spanName, fn, options = {}) {
    const span = startSpan(spanName, options);
    try {
      const result = await fn(span);
      await span.end();
      return result;
    } catch (error) {
      span.setError(error);
      await span.end();
      throw error;
    }
  }

  /**
   * Extract trace context from incoming HTTP headers (W3C traceparent).
   */
  function extractContext(headers) {
    const traceparent = headers?.traceparent || headers?.['traceparent'];
    if (!traceparent) return {};

    const match = String(traceparent).match(
      /^[\da-f]{2}-([\da-f]{32})-([\da-f]{16})-([\da-f]{2})$/i
    );
    if (!match) return {};

    return {
      traceId: match[1].toLowerCase(),
      parentSpanId: match[2].toLowerCase(),
    };
  }

  return { startSpan, trace, extractContext, enabled: OTEL_ENABLED, serviceName: name };
}

module.exports = { createTracer };
