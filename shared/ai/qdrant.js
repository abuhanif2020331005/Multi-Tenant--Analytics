function createQdrantClient(options = {}) {
  const logger = options.logger;
  const enabled = String(process.env.QDRANT_ENABLED || 'false').toLowerCase() === 'true';
  const baseUrl = process.env.QDRANT_URL || 'http://qdrant:6333';
  const collection = process.env.QDRANT_COLLECTION || 'product-embeddings';
  const vectorSize = Number(process.env.QDRANT_VECTOR_SIZE || 16);

  async function request(path, init = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
      headers: {
        'Content-Type': 'application/json',
        ...(init.headers || {}),
      },
      ...init,
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Qdrant ${response.status}: ${text}`);
    }

    if (response.status === 204) {
      return null;
    }

    return response.json();
  }

  return {
    enabled,
    baseUrl,
    collection,
    vectorSize,
    async ensureCollection() {
      if (!enabled) {
        return false;
      }

      try {
        await request(`/collections/${collection}`);
        return true;
      } catch (error) {
        await request(`/collections/${collection}`, {
          method: 'PUT',
          body: JSON.stringify({
            vectors: {
              size: vectorSize,
              distance: 'Cosine',
            },
          }),
        });
        logger?.info('qdrant_collection_created', { collection, vectorSize });
        return true;
      }
    },
    async upsertPoints(points) {
      if (!enabled || !points.length) {
        return { upserted: 0 };
      }

      await this.ensureCollection();
      await request(`/collections/${collection}/points?wait=true`, {
        method: 'PUT',
        body: JSON.stringify({ points }),
      });
      return { upserted: points.length };
    },
    async search(vector, limit, filter) {
      if (!enabled) {
        return [];
      }

      await this.ensureCollection();
      const payload = await request(`/collections/${collection}/points/search`, {
        method: 'POST',
        body: JSON.stringify({
          vector,
          limit,
          with_payload: true,
          filter,
        }),
      });

      return payload?.result || [];
    },
    async collectionInfo() {
      if (!enabled) {
        return { enabled: false };
      }

      const payload = await request(`/collections/${collection}`);
      return payload?.result || {};
    },
  };
}

module.exports = {
  createQdrantClient,
};
