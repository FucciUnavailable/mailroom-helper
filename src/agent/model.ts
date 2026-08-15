import { anthropic } from "@ai-sdk/anthropic";
import type { AnthropicProviderOptions } from "@ai-sdk/anthropic";

/**
 * The only place a model is named.
 *
 * Both agent steps run on Claude Haiku 4.5 — the cheapest model in the lineup
 * at $1/$5 per MTok, chosen to keep the cost of iterating on the demo near
 * zero. Swapping model or effort is an edit here and nowhere else.
 *
 * Haiku 4.5 does not accept the `effort` parameter — it is a 400, not a no-op —
 * so both options objects below are empty. Moving back up to Opus 5 or Sonnet 5
 * means restoring `effort: "low"` and `effort: "medium"` at the same time.
 *
 * Thinking is deliberately left unconfigured. On Haiku 4.5 that means no
 * thinking, which is the intended trade at this price point.
 */
export const MODEL = anthropic("claude-haiku-4-5");

/**
 * Classification is a short, well-specified judgement over one email — the
 * step that gives up the least by running on a small model, because the schema
 * does most of the constraining.
 */
export const CLASSIFY_OPTIONS = {} satisfies AnthropicProviderOptions;

/**
 * The reply loop reasons over retrieved context and decides what it cannot
 * answer, which is worth more than classification. This is the step to move
 * back up first if the drafts read thin on camera.
 */
export const REPLY_OPTIONS = {} satisfies AnthropicProviderOptions;
