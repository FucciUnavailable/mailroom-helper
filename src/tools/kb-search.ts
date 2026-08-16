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
 * This number is measured, not reasoned about, and the distinction cost a live
 * run. It was previously 0.08, derived from the plausible-sounding premise that
 * ts_rank grows with the number of distinct query lexemes a chunk matches, so a
 * two-word overlap would clear a one-word hit near 0.06. That premise is false.
 * ts_rank is driven by term *frequency*, and for an OR-ed query it is diluted by
 * the query terms that do not match — so a longer, more specific question scores
 * *lower*. Measured against this corpus: "SSO" alone scores 0.0608, and "SAML
 * single sign-on" against the one chunk containing all three words scores the
 * same 0.0608. The real customer email that asked about plan tiers and SAML
 * scored 0.0405 and was held for approval with the SSO chunk sitting at the top
 * of the result set, under the floor. At 0.08, none of the twenty-one grounded
 * probes in rank-check.sql cleared it: every product question in the system was
 * being routed to a human.
 *
 * 0.035 is the midpoint of the band that actually separates the two groups:
 *
 *   highest held-out probe   0.0304  (HIPAA, which hits the DPA chunk on
 *                                     "sign" + "compliant")
 *   lowest grounded probe we require  0.0380  (uptime)
 *
 * Both edges are load-bearing. Below ~0.031 the HIPAA question starts returning
 * evidence and the ungrounded_answer rule stops being demonstrable; above
 * ~0.038 real questions start falling through again. Anything outside 0.031 to
 * 0.038 needs the probe set re-run, not an opinion.
 *
 * The floor is not a perfect separator and is not meant to be: eight of the
 * twenty-one grounded probes still land under it and get held for approval.
 * Failing toward a human on a thin retrieval hit is the correct direction for
 * this system, and closing that gap is a corpus problem, not a threshold one.
 *
 * The same number is the SQL function's default. It is passed explicitly
 * anyway: the floor is a product decision about when we are willing to answer,
 * and it belongs somewhere a reviewer reads, not only in a migration.
 *
 * Measure before changing this number: supabase/diagnostics/rank-check.sql
 * runs a labelled probe set through this exact function and prints the range
 * of floors that separates "we answer this" from the held-out subjects.
 */
const RANK_FLOOR = 0.035;
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
