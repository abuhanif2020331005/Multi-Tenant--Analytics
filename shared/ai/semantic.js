const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'for',
  'from',
  'in',
  'is',
  'it',
  'of',
  'on',
  'or',
  'that',
  'the',
  'this',
  'to',
  'with',
]);

function normalizeText(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(value) {
  return normalizeText(value)
    .split(' ')
    .map((token) => token.trim())
    .filter((token) => token && !STOP_WORDS.has(token) && token.length > 1);
}

function collectMetadataTokens(metadata) {
  if (!metadata || typeof metadata !== 'object') {
    return [];
  }

  const values = [];
  for (const value of Object.values(metadata)) {
    if (Array.isArray(value)) {
      values.push(...value.map((item) => String(item)));
      continue;
    }

    if (value && typeof value === 'object') {
      values.push(JSON.stringify(value));
      continue;
    }

    values.push(String(value));
  }

  return tokenize(values.join(' '));
}

function buildSemanticDocument(product) {
  const metadata = product.metadata && typeof product.metadata === 'object' ? product.metadata : {};
  const tags = Array.isArray(metadata.tags) ? metadata.tags.join(' ') : '';
  const text = [
    product.name || '',
    product.category || '',
    product.description || '',
    tags,
  ]
    .filter(Boolean)
    .join(' ');

  const tokens = Array.from(
    new Set([
      ...tokenize(product.name || ''),
      ...tokenize(product.category || ''),
      ...tokenize(product.description || ''),
      ...collectMetadataTokens(metadata),
    ])
  );

  const featureWeights = {};
  for (const token of tokens) {
    featureWeights[token] = (featureWeights[token] || 0) + 1;
  }

  return {
    documentText: text,
    tokens,
    featureWeights,
    vector: buildDeterministicVector(tokens),
    embeddingVersion: 'local-keyword-v1',
  };
}

function tokenHash(token) {
  let hash = 2166136261;
  for (let index = 0; index < token.length; index += 1) {
    hash ^= token.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0);
}

function buildDeterministicVector(tokens, dimensions = 16) {
  const vector = Array.from({ length: dimensions }, () => 0);
  const uniqueTokens = Array.from(new Set(tokens || []));

  for (const token of uniqueTokens) {
    const hash = tokenHash(token);
    const index = hash % dimensions;
    vector[index] += ((hash % 1000) + 1) / 1000;
  }

  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => Number((value / magnitude).toFixed(6)));
}

function scoreSemanticMatch(query, product) {
  const queryTokens = Array.from(new Set(tokenize(query)));
  const productTokens = new Set(
    Array.isArray(product.semantic_tokens) ? product.semantic_tokens : tokenize(product.document_text || '')
  );

  if (queryTokens.length === 0 || productTokens.size === 0) {
    return 0;
  }

  let matches = 0;
  for (const token of queryTokens) {
    if (productTokens.has(token)) {
      matches += 1;
    }
  }

  const overlapScore = matches / queryTokens.length;
  const queryText = normalizeText(query);
  const titleText = normalizeText(product.name || '');
  const categoryText = normalizeText(product.category || '');
  const docText = normalizeText(product.document_text || '');

  let boost = 0;
  if (titleText.includes(queryText) && queryText) {
    boost += 0.5;
  }
  if (categoryText.includes(queryText) && queryText) {
    boost += 0.3;
  }
  if (docText.includes(queryText) && queryText) {
    boost += 0.2;
  }

  return Number((overlapScore + boost).toFixed(4));
}

module.exports = {
  buildSemanticDocument,
  buildDeterministicVector,
  normalizeText,
  scoreSemanticMatch,
  tokenize,
};
