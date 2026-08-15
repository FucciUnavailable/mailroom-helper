import { anthropic } from "@ai-sdk/anthropic";
import type { AnthropicProviderOptions } from "@ai-sdk/anthropic";

/**
 * The only place a model is named.
 *
 * Both agent steps run on Claude Opus 5. Swapping model or effort is an edit
 * here and nowhere else — which is the point, because reply quality is the
 * thing most likely to need tuning after watching the demo back.
 *
 * Thinking is deliberately left unconfigured: it is on by default on Opus 5,
 * and turning it off is the more expensive lever in every sense. Effort is the
 * dial to reach for instead.
 */
export const MODEL = anthropic("claude-opus-5");

/**
 * Classification is a short, well-specified judgement over one email. Low
 * effort keeps it cheap and fast; the schema does the constraining.
 */
export const CLASSIFY_OPTIONS = {
  effort: "low",
} satisfies AnthropicProviderOptions;

/**
 * The reply loop reasons over retrieved context and decides what it cannot
 * answer, which is worth more than classification. Medium is the balance
 * point; raise it if the drafts read thin on camera.
 */
export const REPLY_OPTIONS = {
  effort: "medium",
} satisfies AnthropicProviderOptions;
