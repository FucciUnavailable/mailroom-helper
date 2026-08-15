import { z } from "zod";

/**
 * The only safety-critical decision in the system.
 *
 * Kept as a pure function with no I/O so it can be exhaustively tested and so
 * the reply/no-reply policy lives in exactly one readable place. Do not inline
 * risk checks into the task file.
 */

export const RiskTier = {
  /** Log it, send nothing. Replying would actively cause harm. */
  BLOCK: "BLOCK",
  /** Draft it, pause on a waitpoint, send only after a human approves. */
  APPROVE: "APPROVE",
  /** Hand the thread to a human. The agent does not draft or send. */
  ESCALATE: "ESCALATE",
  /** Send it. */
  AUTO: "AUTO",
} as const;

export type RiskTier = (typeof RiskTier)[keyof typeof RiskTier];

export const classificationSchema = z.object({
  intent: z.enum([
    "account_question",
    "sales",
    "meeting",
    "general_info",
    "spam",
    "abuse",
    "other",
  ]),
  urgency: z.enum(["low", "normal", "high"]),
  asksForAccountData: z.boolean(),
  needsHuman: z.boolean(),
  confidence: z.number().min(0).max(1),
});

export type Classification = z.infer<typeof classificationSchema>;

export const riskInputSchema = z.object({
  classification: classificationSchema,
  /** Auto-Submitted, Precedence: bulk, List-Unsubscribe, or self-addressed. */
  isAutomatedSender: z.boolean(),
  /** SPF and DKIM both passed. */
  senderAuthenticated: z.boolean(),
  /** Sender email is an exact match on a known contact. */
  contactResolved: z.boolean(),
  /** Agent turns already taken on this thread. */
  threadTurnCount: z.number().int().min(0),
  /** Replies already sent on this thread in the last 24h. */
  repliesLast24h: z.number().int().min(0),
  /** Tools the agent wants to call that mutate external state. */
  proposedWrites: z.array(z.string()),
  /** At least one knowledge-base chunk cleared the similarity floor. */
  hasGroundingEvidence: z.boolean(),
});

export type RiskInput = z.infer<typeof riskInputSchema>;

export interface RiskDecision {
  tier: RiskTier;
  /** The rule that fired. Logged verbatim so decisions are auditable. */
  reason: string;
}

const MAX_AGENT_TURNS = 3;
const MAX_REPLIES_24H = 5;
const MIN_CONFIDENCE = 0.6;

/**
 * Ordered rules, first match wins. Order encodes precedence: safety gates run
 * before convenience gates, and BLOCK conditions run before everything.
 */
const RULES: ReadonlyArray<{
  id: string;
  tier: RiskTier;
  when: (i: RiskInput) => boolean;
}> = [
  {
    id: "automated_sender",
    tier: RiskTier.BLOCK,
    // Two auto-responders discovering each other is an unbounded loop.
    when: (i) => i.isAutomatedSender,
  },
  {
    id: "abuse",
    tier: RiskTier.BLOCK,
    when: (i) => i.classification.intent === "abuse",
  },
  {
    id: "spam",
    tier: RiskTier.BLOCK,
    // Auto-replying confirms a live, monitored address.
    when: (i) => i.classification.intent === "spam",
  },
  {
    id: "reply_cap_exceeded",
    tier: RiskTier.ESCALATE,
    when: (i) => i.repliesLast24h >= MAX_REPLIES_24H,
  },
  {
    id: "unverified_sender_requesting_account_data",
    tier: RiskTier.ESCALATE,
    // Envelope sender is spoofable. Never let an unauthenticated address pull
    // account data, even behind an approval gate: the approver sees a plausible
    // draft and clicks yes.
    when: (i) =>
      i.classification.asksForAccountData &&
      (!i.senderAuthenticated || !i.contactResolved),
  },
  {
    id: "model_requested_human",
    tier: RiskTier.ESCALATE,
    when: (i) => i.classification.needsHuman,
  },
  {
    id: "agent_turn_limit",
    tier: RiskTier.ESCALATE,
    // If three exchanges have not resolved it, a fourth will not either.
    when: (i) => i.threadTurnCount >= MAX_AGENT_TURNS,
  },
  {
    id: "low_confidence",
    tier: RiskTier.APPROVE,
    when: (i) => i.classification.confidence < MIN_CONFIDENCE,
  },
  {
    id: "account_data_disclosure",
    tier: RiskTier.APPROVE,
    when: (i) => i.classification.asksForAccountData,
  },
  {
    id: "external_write",
    tier: RiskTier.APPROVE,
    when: (i) => i.proposedWrites.length > 0,
  },
  {
    id: "ungrounded_answer",
    tier: RiskTier.APPROVE,
    // No retrieval hit means the reply is either "I don't know" or invented.
    // Both are worth a human glance.
    when: (i) =>
      i.classification.intent === "general_info" && !i.hasGroundingEvidence,
  },
];

export function assessRisk(raw: unknown): RiskDecision {
  const input = riskInputSchema.parse(raw);

  for (const rule of RULES) {
    if (rule.when(input)) {
      return { tier: rule.tier, reason: rule.id };
    }
  }

  return { tier: RiskTier.AUTO, reason: "no_rule_matched" };
}
