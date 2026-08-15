import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";

/**
 * Local embeddings. No API key, no network at query time, no per-call cost.
 *
 * all-MiniLM-L6-v2 produces 384-dimension vectors, which is what
 * kb_chunks.embedding is declared as. Changing the model here means changing
 * the column width in the migration and re-running the seed — the two numbers
 * are one decision, not two.
 */
export const EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
export const EMBEDDING_DIMENSIONS = 384;

let extractor: Promise<FeatureExtractionPipeline> | null = null;

/**
 * The model weights are ~90MB and load once per process. Cached as the pending
 * promise rather than the resolved value so two concurrent callers during a
 * cold start share one load instead of racing two.
 */
function getExtractor(): Promise<FeatureExtractionPipeline> {
  extractor ??= pipeline("feature-extraction", EMBEDDING_MODEL);
  return extractor;
}

/**
 * Embeds one text into a normalised 384-dim vector.
 *
 * Mean pooling plus L2 normalisation is what MiniLM expects, and normalising
 * here is what lets the SQL side use cosine distance directly.
 */
export async function embed(text: string): Promise<number[]> {
  const [vector] = await embedMany([text]);

  if (!vector) {
    throw new Error("Embedding pipeline returned no vectors for one input.");
  }

  return vector;
}

export async function embedMany(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];

  const extract = await getExtractor();
  const output = await extract(texts, { pooling: "mean", normalize: true });

  const vectors = output.tolist() as number[][];

  for (const vector of vectors) {
    if (vector.length !== EMBEDDING_DIMENSIONS) {
      throw new Error(
        `Expected ${EMBEDDING_DIMENSIONS}-dim embeddings from ${EMBEDDING_MODEL}, ` +
          `got ${vector.length}. The kb_chunks.embedding column will reject these.`,
      );
    }
  }

  return vectors;
}
