import { tool } from "ai";
import { logger } from "@trigger.dev/sdk";
import { supabase } from "../lib/supabase";
import {
  kbSearchInputSchema,
  kbSearchOutputSchema,
  type KbSearchOutput,
} from "../schemas";

/**
 * The relevance floor. Below this a chunk is noise, and returning it would let
 * the model build a confident answer out of unrelated text.
 *
 * ts_rank grows with the number of distinct query lexemes a chunk matches, and
 * a single-lexeme hit lands near 0.06 — so this sits just above one word in
 * common. Deliberately out-of-scope questions (on-prem deployment, HIPAA) fall
 * under it, which is what makes the ungrounded_answer risk rule observable.
 *
 * The same number is the SQL function's default. It is passed explicitly
 * anyway: the floor is a product decision about when we are willing to answer,
 * and it belongs somewhere a reviewer reads, not only in a migration.
 *
 * Requiring two matched lexemes cuts both ways, and the cost lands on short
 * questions: "what does it cost?" carries two content words, so a chunk that
 * says "custom-priced" and never says "cost" is not evidence and the reply
 * gets held for approval. That is the floor working correctly on a knowledge
 * base that was too thin — the fix is chunks written in the words people ask
 * in, which is why seed.sql now covers pricing, trials, cancellation, the API,
 * uptime, GDPR and limits, and says so in customer vocabulary.
 *
 * Measure before changing this number: supabase/diagnostics/rank-check.sql
 * runs a labelled probe set through this exact function and prints the range
 * of floors that separates "we answer this" from the held-out subjects.
 */
const RANK_FLOOR = 0.08;
const MAX_CHUNKS = 4;

interface MatchRow {
  id: string;
  source: string;
  content: string;
  rank: number;
}

/**
 * Retrieval over the seeded knowledge base: Postgres full-text search, ranked.
 *
 * Returns `grounded: false` with an empty list rather than throwing when
 * nothing clears the floor. That distinction is load-bearing — the task reads
 * it into the risk input, and the model is told to offer a human instead of
 * guessing.
 *
 * Lexical, not semantic. At nineteen chunks that is the right trade, and this
 * function is the whole seam: restoring pgvector means changing the RPC call
 * below and nothing else in the codebase.
 */
export async function searchKnowledgeBase(
  query: string,
): Promise<KbSearchOutput> {
  const { data, error } = await supabase.rpc("search_kb_chunks", {
    query_text: query,
    match_threshold: RANK_FLOOR,
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
      rank: row.rank,
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
