import { tool } from "ai";
import { logger } from "@trigger.dev/sdk";
import { embed } from "../lib/embeddings";
import { supabase } from "../lib/supabase";
import {
  kbSearchInputSchema,
  kbSearchOutputSchema,
  type KbSearchOutput,
} from "../schemas";

/**
 * The similarity floor. Below this a chunk is noise, and returning it would
 * let the model build a confident answer out of unrelated text.
 *
 * Tuned against the seeded knowledge base: on-topic questions score well above
 * it, and deliberately out-of-scope ones (on-prem deployment, HIPAA) score
 * below, which is what makes the ungrounded_answer risk rule observable.
 */
const SIMILARITY_FLOOR = 0.35;
const MAX_CHUNKS = 4;

interface MatchRow {
  id: string;
  source: string;
  content: string;
  similarity: number;
}

/**
 * The one real RAG tool: pgvector cosine search over the seeded knowledge base.
 *
 * Returns `grounded: false` with an empty list rather than throwing when
 * nothing clears the floor. That distinction is load-bearing — the task reads
 * it into the risk input, and the model is told to offer a human instead of
 * guessing.
 */
export async function searchKnowledgeBase(
  query: string,
): Promise<KbSearchOutput> {
  const queryEmbedding = await embed(query);

  const { data, error } = await supabase.rpc("match_kb_chunks", {
    query_embedding: JSON.stringify(queryEmbedding),
    match_threshold: SIMILARITY_FLOOR,
    match_count: MAX_CHUNKS,
  });

  if (error) {
    // A failed lookup is not an empty knowledge base. Throwing keeps the two
    // apart: the agent loop surfaces the error rather than the model
    // concluding we have no pricing page.
    throw new Error(`kb_search failed: ${error.message}`);
  }

  const rows = (data ?? []) as MatchRow[];

  logger.info("kb_search", { query, hits: rows.length });

  return kbSearchOutputSchema.parse({
    chunks: rows.map((row) => ({
      source: row.source,
      content: row.content,
      similarity: row.similarity,
    })),
    grounded: rows.length > 0,
  });
}

export const kbSearchTool = tool({
  description:
    "Search the product knowledge base for pricing, security, support, " +
    "integrations, onboarding, and data retention information. Use this " +
    "before answering any factual question about the product. If it returns " +
    "no chunks, the knowledge base genuinely does not cover the question — " +
    "say so rather than answering from memory.",
  inputSchema: kbSearchInputSchema,
  outputSchema: kbSearchOutputSchema,
  execute: async ({ query }) => searchKnowledgeBase(query),
});
