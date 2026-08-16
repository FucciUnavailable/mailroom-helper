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
  /** At least one knowledge-base chunk cleared the relevance floor. */
  hasGroundingEvidence: z.boolean(),
});

export type RiskInput = z.infer<typeof riskInputSchema>;

/**
 * Everything knowable about a message before the agent loop runs — which is
 * everything except what the agent itself produces. Deliberately derived from
 * `riskInputSchema` with `.omit` rather than declared separately, so a new
 * field can never be silently absent from the pre-agent pass.
 */
export const preAgentRiskInputSchema = riskInputSchema.omit({
  proposedWrites: true,
  hasGroundingEvidence: true,
});

export type PreAgentRiskInput = z.infer<typeof preAgentRiskInputSchema>;

export interface RiskDecision {
  tier: RiskTier;
  /** The rule that fired. Logged verbatim so decisions are auditable. */
  reason: string;
  /**
   * Send the sender a fixed acknowledgment — "a colleague is picking this up" —
   * instead of leaving them in silence.
   *
   * A property of the *rule*, not of the tier, because the tiers do not split
   * cleanly on it. It is never set on a BLOCK rule and it is deliberately not
   * set on every ESCALATE rule; see the rule arrays for the reasoning in each
   * case. The copy is a constant in `src/lib/notify.ts` and contains no
   * customer facts, so acknowledging costs nothing the agent could get wrong.
   */
  acknowledge: boolean;
}

const MAX_AGENT_TURNS = 3;
const MAX_REPLIES_24H = 5;
const MIN_CONFIDENCE = 0.6;

interface Rule<I> {
  id: string;
  tier: RiskTier;
  /**
   * Acknowledge to the sender. Defaults to false, and the default is the safe
   * one: a new rule stays silent until someone decides otherwise, rather than
   * inheriting a reply it was never reasoned about.
   */
  acknowledge?: boolean;
  when: (i: I) => boolean;
}

/**
 * Rules decidable before the agent loop runs, in precedence order.
 *
 * Every one of these resolves to BLOCK or ESCALATE, and both of those outcomes
 * mean "no AI-drafted reply is ever sent". So if one fires there is nothing for
 * the agent to draft, and running the loop would burn a model call and a round
 * of tool calls to produce output we are contractually going to throw away.
 * Spam in particular never reaches a model.
 *
 * Typed against the narrow input so a rule cannot quietly start depending on
 * agent output and break the short circuit.
 */
const PRE_AGENT_RULES: ReadonlyArray<Rule<PreAgentRiskInput>> = [
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
    // No acknowledgment, and this is the one ESCALATE rule where that is not a
    // judgement call. The rule exists because we have already sent this thread
    // five emails in 24 hours and must stop; an acknowledgment would be the
    // sixth. Setting `acknowledge` here would mean every further message on the
    // thread triggers exactly the send the cap was written to prevent.
    when: (i) => i.repliesLast24h >= MAX_REPLIES_24H,
  },
  {
    id: "unverified_sender_requesting_account_data",
    tier: RiskTier.ESCALATE,
    // Envelope sender is spoofable. Never let an unauthenticated address pull
    // account data, even behind an approval gate: the approver sees a plausible
    // draft and clicks yes.
    //
    // Acknowledged, with one eye open. This is the most common escalation in
    // practice — while `Authentication-Results` is unverified, every account
    // question lands here — and silence toward someone asking about their own
    // invoice is the worst experience the system produces. The acknowledgment
    // discloses nothing and, deliberately, does not say *why* a human is
    // involved: telling a spoofer that verification failed tells them what to
    // forge next. The residual risk is backscatter to a forged address, bounded
    // by the once-per-thread guard in inbound-email.ts.
    acknowledge: true,
    when: (i) =>
      i.classification.asksForAccountData &&
      (!i.senderAuthenticated || !i.contactResolved),
  },
  {
    id: "model_requested_human",
    tier: RiskTier.ESCALATE,
    // Legal, complaints, cancellations, money moving. A person is genuinely
    // picking this up, which is exactly what the acknowledgment promises.
    acknowledge: true,
    when: (i) => i.classification.needsHuman,
  },
  {
    id: "agent_turn_limit",
    tier: RiskTier.ESCALATE,
    // If three exchanges have not resolved it, a fourth will not either.
    //
    // The sender is mid-conversation and has had replies until now, so going
    // abruptly silent reads as being ignored. Distinct from reply_cap_exceeded:
    // that rule is a hard budget on outbound volume, this one is a judgement
    // that the agent is not converging, and one more short message does not
    // undermine it.
    acknowledge: true,
    when: (i) => i.threadTurnCount >= MAX_AGENT_TURNS,
  },
];

/**
 * Rules that need the agent's output, in precedence order. These run only
 * after the loop, and every one of them resolves to APPROVE: a draft exists
 * and a human decides whether it goes out.
 */
const POST_AGENT_RULES: ReadonlyArray<Rule<RiskInput>> = [
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

function firstMatch<I>(
  rules: ReadonlyArray<Rule<I>>,
  input: I,
): RiskDecision | null {
  for (const rule of rules) {
    if (rule.when(input)) {
      return {
        tier: rule.tier,
        reason: rule.id,
        acknowledge: rule.acknowledge ?? false,
      };
    }
  }
  return null;
}

/**
 * The cheap pass, run immediately after classification.
 *
 * Returns a decision only when the message can be settled without a draft —
 * always BLOCK or ESCALATE. `null` means "keep going": run the agent loop, then
 * call {@link assessRisk} for the real decision. Never returns AUTO, because
 * clearing the pre-agent rules is not on its own permission to send.
 */
export function assessPreAgentRisk(raw: unknown): RiskDecision | null {
  return firstMatch(PRE_AGENT_RULES, preAgentRiskInputSchema.parse(raw));
}

/**
 * The full pass, run after the agent loop. Re-checks the pre-agent rules rather
 * than trusting that the caller ran them, so this function alone is a complete
 * and correct decision — the short circuit is an optimisation, not a
 * precondition.
 */
export function assessRisk(raw: unknown): RiskDecision {
  const input = riskInputSchema.parse(raw);

  return (
    firstMatch(PRE_AGENT_RULES, input) ??
    firstMatch(POST_AGENT_RULES, input) ?? {
      tier: RiskTier.AUTO,
      reason: "no_rule_matched",
      // AUTO sends the real reply. An acknowledgment on top of it would be a
      // second email saying less.
      acknowledge: false,
    }
  );
}
