import crypto from 'node:crypto';

export const CURRENT_EMBEDDING_MODEL = 'recall-dense-v1';
export const CURRENT_EMBEDDING_VERSION = 1;
export const EMBEDDING_DIMENSIONS = 64;

export interface EmbeddingResult {
  vector: number[];
  model: string;
  version: number;
  contentHash: string;
}

/**
 * Computes SHA-256 hash of normalized text for cache invalidation.
 */
export function hashContent(text: string): string {
  return crypto.createHash('sha256').update(text.trim().toLowerCase()).digest('hex');
}

/**
 * Computes cosine similarity between two numeric vectors.
 * Returns a value between -1.0 and 1.0 (or 0.0 to 1.0 for positive embeddings).
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    const valA = a[i]!;
    const valB = b[i]!;
    dotProduct += valA * valB;
    normA += valA * valA;
    normB += valB * valB;
  }

  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Generates a local, deterministic dense vector embedding using feature hashing
 * over character n-grams and token roots. Runs 100% locally with zero external network.
 */
export function generateLocalDenseVector(text: string, dimensions = EMBEDDING_DIMENSIONS): number[] {
  const normalized = text.toLowerCase().trim();
  const vector = new Array<number>(dimensions).fill(0);

  if (!normalized) return vector;

  // Extract tokens and character tri-grams
  const words = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
  const features: string[] = [...words];

  // Add 3-grams and 4-grams for subword similarity
  for (const word of words) {
    if (word.length >= 3) {
      for (let i = 0; i <= word.length - 3; i++) {
        features.push(word.slice(i, i + 3));
      }
    }
  }

  // Feature hashing (Murmur/MD5 hashing into vector coordinates)
  for (const feat of features) {
    const hash = crypto.createHash('md5').update(feat).digest();
    const index = hash.readUInt16BE(0) % dimensions;
    const sign = (hash.readUInt8(2) & 1) === 1 ? 1 : -1;
    vector[index] = (vector[index] ?? 0) + sign;
  }

  // L2 Normalization
  let norm = 0;
  for (let i = 0; i < dimensions; i++) {
    const v = vector[i]!;
    norm += v * v;
  }

  if (norm > 0) {
    const sqrtNorm = Math.sqrt(norm);
    for (let i = 0; i < dimensions; i++) {
      vector[i] = vector[i]! / sqrtNorm;
    }
  }

  return vector;
}

/**
 * In-memory LRU / Map cache for generated embeddings.
 */
class EmbeddingCache {
  private cache = new Map<string, EmbeddingResult>();
  private readonly maxEntries = 2000;

  get(contentHash: string, model = CURRENT_EMBEDDING_MODEL, version = CURRENT_EMBEDDING_VERSION): EmbeddingResult | undefined {
    const key = `${model}:v${version}:${contentHash}`;
    return this.cache.get(key);
  }

  set(contentHash: string, result: EmbeddingResult): void {
    if (this.cache.size >= this.maxEntries) {
      // Evict oldest entry
      const firstKey = this.cache.keys().next().value;
      if (firstKey) this.cache.delete(firstKey);
    }
    const key = `${result.model}:v${result.version}:${contentHash}`;
    this.cache.set(key, result);
  }

  clear(): void {
    this.cache.clear();
  }
}

export const memoryEmbeddingCache = new EmbeddingCache();

/**
 * Gets or computes the dense vector embedding for the given text.
 * Reuses existing embeddings when content has not changed.
 */
export function getOrGenerateEmbedding(
  text: string,
  model = CURRENT_EMBEDDING_MODEL,
  version = CURRENT_EMBEDDING_VERSION,
): EmbeddingResult {
  const contentHash = hashContent(text);
  const cached = memoryEmbeddingCache.get(contentHash, model, version);
  if (cached) {
    return cached;
  }

  const vector = generateLocalDenseVector(text, EMBEDDING_DIMENSIONS);
  const result: EmbeddingResult = {
    vector,
    model,
    version,
    contentHash,
  };

  memoryEmbeddingCache.set(contentHash, result);
  return result;
}
