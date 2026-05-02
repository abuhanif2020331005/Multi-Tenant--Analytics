const {
  tokenize,
  normalizeText,
  buildSemanticDocument,
  buildDeterministicVector,
  scoreSemanticMatch,
} = require('./semantic');

describe('tokenize', () => {
  it('lowercases and removes stop words', () => {
    const tokens = tokenize('The best waterproof jacket for hiking');
    expect(tokens).toContain('waterproof');
    expect(tokens).toContain('jacket');
    expect(tokens).toContain('hiking');
    expect(tokens).not.toContain('the');
    expect(tokens).not.toContain('for');
  });

  it('removes punctuation', () => {
    const tokens = tokenize('rain-proof, all-weather!');
    expect(tokens.every((t) => /^[a-z0-9]+$/.test(t))).toBe(true);
  });

  it('returns empty array for empty string', () => {
    expect(tokenize('')).toEqual([]);
  });
});

describe('buildDeterministicVector', () => {
  it('returns a vector of the specified dimension', () => {
    const v = buildDeterministicVector(['jacket', 'waterproof'], 16);
    expect(v).toHaveLength(16);
  });

  it('is deterministic — same tokens produce same vector', () => {
    const a = buildDeterministicVector(['jacket', 'hiking']);
    const b = buildDeterministicVector(['jacket', 'hiking']);
    expect(a).toEqual(b);
  });

  it('is normalized (magnitude ≈ 1)', () => {
    const v = buildDeterministicVector(['jacket', 'waterproof', 'hiking']);
    const magnitude = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    expect(magnitude).toBeCloseTo(1, 4);
  });

  it('returns zero vector for empty tokens', () => {
    const v = buildDeterministicVector([]);
    expect(v.every((x) => x === 0)).toBe(true);
  });
});

describe('buildSemanticDocument', () => {
  const product = {
    productId: 'sku_001',
    name: 'Stormguard Hiking Shell',
    category: 'outerwear',
    description: 'Waterproof technical shell for alpine weather.',
    metadata: { tags: ['waterproof', 'hiking', 'shell'] },
  };

  it('builds a document with tokens and vector', () => {
    const doc = buildSemanticDocument(product);
    expect(doc.documentText).toContain('Stormguard');
    expect(doc.tokens).toContain('waterproof');
    expect(doc.tokens).toContain('hiking');
    expect(doc.vector).toHaveLength(16);
    expect(doc.embeddingVersion).toBe('local-keyword-v1');
  });

  it('deduplicates tokens', () => {
    const doc = buildSemanticDocument({ ...product, description: 'hiking hiking hiking' });
    const count = doc.tokens.filter((t) => t === 'hiking').length;
    expect(count).toBe(1);
  });
});

describe('scoreSemanticMatch', () => {
  const product = {
    name: 'Stormguard Hiking Shell',
    category: 'outerwear',
    document_text: 'Stormguard Hiking Shell outerwear Waterproof technical shell alpine weather',
    semantic_tokens: ['stormguard', 'hiking', 'shell', 'outerwear', 'waterproof', 'technical', 'alpine', 'weather'],
  };

  it('returns positive score for matching query', () => {
    const score = scoreSemanticMatch('waterproof hiking jacket', product);
    expect(score).toBeGreaterThan(0);
  });

  it('returns 0 for completely unrelated query', () => {
    const score = scoreSemanticMatch('laptop computer keyboard', product);
    expect(score).toBe(0);
  });

  it('gives higher score for multi-token match vs single token', () => {
    const multi = scoreSemanticMatch('waterproof hiking shell', product);
    const single = scoreSemanticMatch('laptop', product);
    expect(multi).toBeGreaterThan(single);
  });
});
