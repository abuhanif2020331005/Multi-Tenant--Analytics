/**
 * Fraud alert webhook dispatcher.
 * When a high-risk user is detected, POST the alert to a tenant-configured webhook URL.
 * Uses exponential backoff retry for reliability.
 */

const { withRetry } = require('../../../shared/utils/retry');

async function dispatchWebhook(webhookUrl, payload, logger) {
  if (!webhookUrl) return { dispatched: false, reason: 'no_webhook_url' };

  await withRetry(
    async () => {
      const response = await fetch(webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Platform-Event': 'fraud.alert' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        throw new Error(`Webhook responded with ${response.status}`);
      }
    },
    {
      attempts: 3,
      baseDelayMs: 500,
      operationName: 'fraud_webhook',
      logger,
      shouldRetry: (err) => !err.message.includes('4'), // don't retry 4xx
    }
  );

  return { dispatched: true, url: webhookUrl };
}

module.exports = { dispatchWebhook };
