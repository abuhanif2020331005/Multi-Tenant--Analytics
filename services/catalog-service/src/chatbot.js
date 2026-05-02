/**
 * RAG-based product chatbot handler.
 * Retrieves relevant products from the DB semantic index,
 * builds a context prompt, and calls Ollama for a response.
 * Falls back to a keyword-matched answer when Ollama is disabled.
 */

const Joi = require('joi');
const { buildSemanticDocument, scoreSemanticMatch } = require('../../../shared/ai/semantic');
const { createOllamaClient } = require('../../../shared/ai/ollama');

const chatSchema = Joi.object({
  message: Joi.string().trim().min(2).max(500).required(),
  history: Joi.array()
    .items(
      Joi.object({
        role: Joi.string().valid('user', 'assistant').required(),
        content: Joi.string().max(1000).required(),
      })
    )
    .max(10)
    .default([]),
});

const SYSTEM_PROMPT = `You are a helpful product assistant for an e-commerce store.
Answer questions about products based only on the catalog context provided.
Be concise, friendly, and accurate. If a product is not in the context, say so.
Do not invent product details.`;

function buildContextBlock(products) {
  if (!products.length) {
    return 'No matching products found in the catalog.';
  }

  return products
    .map((p, i) => {
      const price = p.price !== null ? `$${Number(p.price).toFixed(2)}` : 'price not listed';
      const desc = p.description ? ` – ${p.description}` : '';
      return `${i + 1}. ${p.name} (${p.category || 'uncategorized'}, ${price})${desc}`;
    })
    .join('\n');
}

function buildFallbackAnswer(query, products) {
  if (!products.length) {
    return `I couldn't find any products matching "${query}" in the catalog.`;
  }

  const top = products[0];
  const price = top.price !== null ? `$${Number(top.price).toFixed(2)}` : 'price not listed';
  return (
    `Based on your query "${query}", the closest match is **${top.name}** ` +
    `(${top.category || 'uncategorized'}, ${price}).` +
    (top.description ? ` ${top.description}` : '') +
    (products.length > 1
      ? ` Other options include: ${products
          .slice(1)
          .map((p) => p.name)
          .join(', ')}.`
      : '')
  );
}

function createChatbotHandler(pool, logger) {
  const ollama = createOllamaClient({ logger });

  return async function handleChat(req, res) {
    const { error, value } = chatSchema.validate(req.body, { convert: true });
    if (error) {
      return res.status(400).json({ error: error.details[0].message });
    }

    const { message, history } = value;

    try {
      // Retrieve candidate products via semantic scoring
      const result = await pool.query(
        `SELECT
           p.product_id,
           p.name,
           p.category,
           p.description,
           p.price,
           pe.document_text,
           pe.semantic_tokens
         FROM products p
         LEFT JOIN product_embeddings pe
           ON pe.tenant_id = p.tenant_id
          AND pe.product_id = p.product_id
         WHERE p.tenant_id = $1 AND p.is_active = true`,
        [req.user.tenantId]
      );

      const ranked = result.rows
        .map((row) => {
          const fallbackSemantic = buildSemanticDocument({
            name: row.name,
            category: row.category,
            description: row.description,
            metadata: row.metadata,
          });
          const searchable = {
            ...row,
            document_text: row.document_text || fallbackSemantic.documentText,
            semantic_tokens: row.semantic_tokens || fallbackSemantic.tokens,
          };
          return { ...searchable, score: scoreSemanticMatch(message, searchable) };
        })
        .filter((row) => row.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);

      const contextBlock = buildContextBlock(ranked);

      if (!ollama.enabled) {
        return res.json({
          answer: buildFallbackAnswer(message, ranked),
          strategy: 'keyword-fallback',
          ollamaEnabled: false,
          contextProducts: ranked.map((p) => ({
            productId: p.product_id,
            name: p.name,
            score: p.score,
          })),
        });
      }

      // Build chat messages for Ollama
      const messages = [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'system',
          content: `Current product catalog context:\n${contextBlock}`,
        },
        ...history,
        { role: 'user', content: message },
      ];

      const llmResult = await ollama.chat(messages);

      return res.json({
        answer: llmResult.text,
        strategy: 'rag-ollama',
        model: llmResult.model,
        ollamaEnabled: true,
        contextProducts: ranked.map((p) => ({
          productId: p.product_id,
          name: p.name,
          score: p.score,
        })),
      });
    } catch (err) {
      logger.error('chatbot_error', { error: err.message, tenantId: req.user.tenantId });
      return res.status(500).json({ error: 'Chatbot request failed' });
    }
  };
}

module.exports = { createChatbotHandler, chatSchema };
