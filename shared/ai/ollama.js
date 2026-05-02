/**
 * Ollama LLM client for local inference.
 * Falls back gracefully when Ollama is not available.
 *
 * Env vars:
 *   OLLAMA_ENABLED   – 'true' to enable (default: false)
 *   OLLAMA_URL       – base URL (default: http://ollama:11434)
 *   OLLAMA_MODEL     – model name (default: llama3.2)
 *   OLLAMA_TIMEOUT_MS – per-request timeout (default: 30000)
 */

function createOllamaClient(options = {}) {
  const logger = options.logger;
  const enabled = String(process.env.OLLAMA_ENABLED || 'false').toLowerCase() === 'true';
  const baseUrl = (process.env.OLLAMA_URL || 'http://ollama:11434').replace(/\/$/, '');
  const model = process.env.OLLAMA_MODEL || 'llama3.2';
  const timeoutMs = Number(process.env.OLLAMA_TIMEOUT_MS || 30_000);

  async function request(path, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Ollama ${response.status}: ${text}`);
      }

      return response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Single-turn completion.
   * Returns { text, model, done }
   */
  async function generate(prompt, systemPrompt) {
    if (!enabled) {
      return { text: null, model, done: false, reason: 'ollama_disabled' };
    }

    const payload = {
      model,
      prompt,
      stream: false,
    };

    if (systemPrompt) {
      payload.system = systemPrompt;
    }

    const result = await request('/api/generate', payload);
    return {
      text: result.response || '',
      model: result.model || model,
      done: result.done ?? true,
      evalCount: result.eval_count,
      promptEvalCount: result.prompt_eval_count,
    };
  }

  /**
   * Chat-style completion with message history.
   * messages: [{ role: 'user'|'assistant'|'system', content: string }]
   */
  async function chat(messages) {
    if (!enabled) {
      return { text: null, model, done: false, reason: 'ollama_disabled' };
    }

    const result = await request('/api/chat', {
      model,
      messages,
      stream: false,
    });

    return {
      text: result.message?.content || '',
      role: result.message?.role || 'assistant',
      model: result.model || model,
      done: result.done ?? true,
    };
  }

  /**
   * Check if Ollama is reachable and the model is available.
   */
  async function ping() {
    if (!enabled) {
      return { available: false, reason: 'ollama_disabled' };
    }

    try {
      const response = await fetch(`${baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(5000),
      });

      if (!response.ok) {
        return { available: false, reason: `http_${response.status}` };
      }

      const payload = await response.json();
      const models = (payload.models || []).map((m) => m.name);
      const modelAvailable = models.some((m) => m === model || m.startsWith(`${model}:`));

      return {
        available: true,
        modelAvailable,
        model,
        availableModels: models,
      };
    } catch (error) {
      return { available: false, reason: error.message };
    }
  }

  return { enabled, baseUrl, model, generate, chat, ping };
}

module.exports = { createOllamaClient };
