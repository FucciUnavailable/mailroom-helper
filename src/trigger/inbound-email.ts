import { logger, schemaTask, wait } from "@trigger.dev/sdk";
import { z } from "zod";
import { classify } from "../agent/classify";
import { draftReply, type ReplyResult } from "../agent/reply";
import { resolveAuthentication } from "../lib/auth-results";
import {
  advanceThread,
  countRepliesLast24h,
  recordDecision,
  recordInboundMessage,
  recordOutboundMessage,
  resolveContact,
  resolveThread,
  type ThreadState,
} from "../lib/db";
import {
  approvalLinks,
  HOLDING_ACK_BODY,
  notifySlack,
  sendHoldingAck,
  sendReply,
} from "../lib/notify";
import {
  assessPreAgentRisk,
  assessRisk,
  RiskTier,
  type RiskDecision,
} from "../lib/risk-tier";
import {
  inboundEmailPayloadSchema,
  type Classification,
  type InboundEmailPayload,
} from "../schemas";

/**
 * What Make scenario C posts to the waitpoint callback when a link is clicked.
 *
 * `token.url` is the `/callback/<secret>` endpoint, whose raw body becomes the
 * run's output verbatim — so the relay posts this shape unwrapped. The SDK's
 * `wait.completeToken` targets a different endpoint that wraps the same shape
 * in `{"data": ...}`, which is why `pnpm approve` and Make send different
 * bytes to mean the same thing.
 */
const approvalDecisionSchema = z.object({
  decision: z.enum(["approve", "reject"]),
});

type ApprovalDecision = z.infer<typeof approvalDecisionSchema>;

/**
 * Any of these headers means a machine sent the message. Their presence, not
 * their value, is the signal — a bounce notifier and a mailing list are both
 * things we must never reply to, because two auto-responders discovering each
 * other is an unbounded loop.
 */
function isAutomatedSender(payload: InboundEmailPayload): boolean {
  const { autoSubmitted, precedence, listUnsubscribe, listId } =
    payload.headers;

  if (listUnsubscribe !== undefined || listId !== undefined) return true;
  if (autoSubmitted !== undefined && autoSubmitted.toLowerCase() !== "no") {
    return true;
  }
  if (precedence !== undefined) {
    return ["bulk", "list", "junk"].includes(precedence.toLowerCase());
  }

  // Self-addressed mail: our own outbound looping back into the inbox.
  return payload.to.some(
    (recipient) => recipient.toLowerCase() === payload.from.email.toLowerCase(),
  );
}

function replySubject(subject: string): string {
  return /^re:/i.test(subject) ? subject : `Re: ${subject || "your message"}`;
}

/**
 * How much of the inbound email goes into a Slack card.
 *
 * A Slack webhook accepts roughly 40k characters, so this is not a protocol
 * limit — it is a reading limit. The approver has to judge a draft against the
 * question that produced it, and a wall of quoted reply history buries that
 * question below the fold. Anyone who needs the rest has the thread in the
 * inbox and the run in the Trigger.dev timeline.
 */
const SLACK_QUOTE_LIMIT = 1200;

/**
 * The sender's own words, fenced for Slack.
 *
 * Without this the approver sees a reply with nothing to check it against, and
 * approving is a formality rather than a decision. The body is untrusted text
 * from an unauthenticated stranger, so it gets two defences: triple backticks
 * are neutralised, since one in an email body would otherwise close the fence
 * early and let the rest of the message render as Slack markup — including the
 * `<url|label>` link syntax the approve and reject links use. And it goes last
 * in the card, below those links, so a long quote can never push them off.
 */
function quoteInbound(text: string): string[] {
  const cleaned = text.trim().replaceAll("```", "'''");
  const truncated =
    cleaned.length > SLACK_QUOTE_LIMIT
      ? `${cleaned.slice(0, SLACK_QUOTE_LIMIT)}\n… (truncated)`
      : cleaned;

  return [
    "*What they wrote:*",
    "```",
    truncated || "(empty message body)",
    "```",
  ];
}

export const inboundEmail = schemaTask({
  id: "inbound-email",
  schema: inboundEmailPayloadSchema,
  maxDuration: 120,
  run: async (payload) => {
    // ---- 1. Resolve identity and thread state --------------------------
    const contact = await resolveContact(payload.from.email);
    const thread = await resolveThread(payload.threadKey, contact?.id ?? null);

    // ---- 2. Idempotency backstop ---------------------------------------
    const message = await recordInboundMessage(thread.id, payload);

    if (message === null) {
      logger.warn("duplicate delivery ignored", {
        messageId: payload.messageId,
      });
      return { outcome: "duplicate" as const, messageId: payload.messageId };
    }

    const repliesLast24h = await countRepliesLast24h(thread.id);

    // ---- 3. Classify ---------------------------------------------------
    const classification = await classify(payload);

    const auth = resolveAuthentication(payload);

    const baseRiskInput = {
      classification,
      isAutomatedSender: isAutomatedSender(payload),
      senderAuthenticated: auth.spfPass && auth.dkimPass,
      contactResolved: contact !== null,
      threadTurnCount: thread.turnCount,
      repliesLast24h,
    };

    // Every input the tier is about to be computed from, in one line.
    //
    // The decision itself is already audited — `reason` is the rule id and it
    // is logged wherever the tier is acted on. What was missing is *why that
    // rule matched*, and the two most common escalations both turn on booleans
    // that were being derived and discarded here. Without them, working out
    // whether a message escalated because SPF failed or because the sender
    // simply is not in the contacts table means reasoning from the rule
    // predicate backwards, which is exactly the debugging this line removes.
    logger.info("risk input", {
      ...baseRiskInput,
      // Not part of the decision, but the two things you want next when it
      // looks wrong: the verdicts separately, since the rule only sees them
      // ANDed together, and whether the header they came from arrived at all.
      spfPass: auth.spfPass,
      dkimPass: auth.dkimPass,
      hasAuthenticationResults: payload.authenticationResults !== undefined,
      from: payload.from.email,
    });

    // ---- 4. Pre-agent gate ---------------------------------------------
    // BLOCK and ESCALATE both mean no AI-drafted reply is ever sent, so there
    // is nothing for the agent to write. Short-circuiting here is what keeps
    // spam from reaching a model call.
    const earlyDecision = assessPreAgentRisk(baseRiskInput);

    if (earlyDecision !== null) {
      await recordDecision(message.id, classification, earlyDecision);
      return finishWithoutReply(earlyDecision, payload, classification, thread);
    }

    // ---- 5. Agent loop -------------------------------------------------
    const draft = await draftReply(payload, classification);

    // ---- 6. Full risk assessment ---------------------------------------
    const decision = assessRisk({
      ...baseRiskInput,
      proposedWrites: draft.proposedWrites,
      hasGroundingEvidence: draft.hasGroundingEvidence,
    });

    await recordDecision(message.id, classification, decision);

    logger.info("risk decision", {
      tier: decision.tier,
      reason: decision.reason,
    });

    // ---- 7. Branch -----------------------------------------------------
    switch (decision.tier) {
      case RiskTier.AUTO:
        await dispatch(payload, draft, decision, thread.id);
        await advanceThread(thread.id, "open", true, thread.turnCount);
        return { outcome: "sent" as const, reason: decision.reason };

      case RiskTier.APPROVE:
        return waitForApproval(payload, draft, decision, thread);

      // The pre-agent gate already returned for these, but the switch stays
      // exhaustive: assessRisk is a complete decision on its own, and a future
      // rule moving across the pre/post boundary must not fall through here.
      case RiskTier.BLOCK:
      case RiskTier.ESCALATE:
        return finishWithoutReply(decision, payload, classification, thread);
    }
  },
});

/** BLOCK logs and stops. ESCALATE hands the thread to a human, with no draft. */
async function finishWithoutReply(
  decision: RiskDecision,
  payload: InboundEmailPayload,
  classification: Classification,
  thread: ThreadState,
) {
  if (decision.tier === RiskTier.BLOCK) {
    logger.info("blocked, no reply sent", {
      reason: decision.reason,
      intent: classification.intent,
      from: payload.from.email,
    });
    await advanceThread(thread.id, "closed", false, thread.turnCount);
    return { outcome: "blocked" as const, reason: decision.reason };
  }

  // Tell the sender a human has it — but only once per thread, and only for
  // rules that opted in. `status` is the thread as it was before this message,
  // so a thread already in `escalated` has had its acknowledgment and a
  // follow-up on the same subject does not get another one.
  //
  // No BLOCK rule can reach this branch, which is what keeps the auto-responder
  // loop closed: our acknowledgment may well trip the recipient's own
  // auto-reply, but that reply comes back marked automated, blocks, and stops.
  const acknowledge = decision.acknowledge && thread.status !== "escalated";

  await notifySlack(
    [
      `:rotating_light: *Escalated — no AI reply sent*`,
      `*From:* ${payload.from.email}`,
      `*Subject:* ${payload.subject}`,
      `*Rule:* \`${decision.reason}\``,
      `*Intent:* ${classification.intent}`,
      "",
      "The agent did not draft anything. This thread needs a human.",
      acknowledge
        ? "_The sender has been told a colleague is picking it up._"
        : "_The sender has not been contacted._",
    ].join("\n"),
  );

  if (acknowledge) {
    const subject = replySubject(payload.subject);

    await sendHoldingAck({
      threadKey: payload.threadKey,
      inReplyTo: payload.messageId,
      to: payload.from.email,
      subject,
      riskReason: decision.reason,
    });

    // Recorded like any other outbound message, so the acknowledgment counts
    // toward countRepliesLast24h. An acknowledgment that did not count would
    // be a send the reply cap cannot see.
    await recordOutboundMessage(
      thread.id,
      payload.messageId,
      subject,
      HOLDING_ACK_BODY,
      decision,
    );

    logger.info("acknowledged escalation to sender", {
      reason: decision.reason,
      to: payload.from.email,
    });
  }

  await advanceThread(thread.id, "escalated", false, thread.turnCount);
  return {
    outcome: "escalated" as const,
    reason: decision.reason,
    acknowledged: acknowledge,
  };
}

/**
 * Sends the reply and records it, in that order and always together.
 *
 * The outbound row is what `countRepliesLast24h` reads, so a send that skips
 * it would leave the reply_cap_exceeded rule permanently looking at zero. The
 * two calls live in one function so a future branch cannot do one without the
 * other.
 */
async function dispatch(
  payload: InboundEmailPayload,
  draft: ReplyResult,
  decision: RiskDecision,
  threadId: string,
) {
  const subject = replySubject(payload.subject);

  await sendReply({
    threadKey: payload.threadKey,
    inReplyTo: payload.messageId,
    to: payload.from.email,
    subject,
    body: draft.body,
    riskReason: decision.reason,
  });

  await recordOutboundMessage(
    threadId,
    payload.messageId,
    subject,
    draft.body,
    decision,
  );
}

/**
 * Pauses the run on a waitpoint until a human clicks approve or reject.
 *
 * The run is suspended, not spinning: it consumes no compute while parked, and
 * the timeout is enforced by the platform rather than by a cron sweeping a
 * `pending` table.
 *
 * The sender is told a human is looking, before the wait begins. Without it,
 * every terminal branch below except `approve` ends in permanent silence toward
 * someone who asked a real question — a rejected draft and a 24 hour timeout
 * both notify Slack and nothing else. Acknowledging once, up front, covers all
 * three outcomes rather than bolting a message onto each; the cost is that a
 * fast approval arrives as a second email a few minutes behind the first, which
 * is a fair trade against going dark for a day.
 */
async function waitForApproval(
  payload: InboundEmailPayload,
  draft: ReplyResult,
  decision: RiskDecision,
  thread: ThreadState,
) {
  const { id: threadId, turnCount } = thread;

  const token = await wait.createToken({
    timeout: "1d",
    tags: [`thread:${payload.threadKey}`],
  });

  const links = approvalLinks(token.url);

  // The token id (not the callback secret) goes in the run timeline, so an
  // approval can be correlated with its run — and so `pnpm approve --token`
  // can drive this branch before Make scenario C exists.
  logger.info("parked on approval waitpoint", {
    tokenId: token.id,
    rule: decision.reason,
  });

  // Once per thread, on the same rule as the escalation acknowledgment and for
  // the same reason: `status` is the thread as it was before this message, so a
  // sender who has already been told a human is involved — whether by an
  // escalation or by an earlier draft still sitting in the queue — is not told
  // again on every follow-up.
  const acknowledge =
    thread.status !== "awaiting_approval" && thread.status !== "escalated";

  await notifySlack(
    [
      `:eyes: *Approval needed*`,
      `*From:* ${payload.from.email}`,
      `*Subject:* ${payload.subject}`,
      `*Rule:* \`${decision.reason}\``,
      "",
      "*Draft reply:*",
      "```",
      draft.body,
      "```",
      "",
      `<${links.approve}|Approve and send>  ·  <${links.reject}|Reject>`,
      "_Expires in 24 hours._",
      acknowledge
        ? "_The sender has been told a colleague is picking it up._"
        : "_The sender has not been contacted again; they were already told._",
      "",
      ...quoteInbound(payload.text),
    ].join("\n"),
  );

  if (acknowledge) {
    await sendHoldingAck({
      threadKey: payload.threadKey,
      inReplyTo: payload.messageId,
      to: payload.from.email,
      subject: replySubject(payload.subject),
      riskReason: decision.reason,
    });

    // Counted like any other outbound message, so the acknowledgment is visible
    // to countRepliesLast24h. A send the reply cap cannot see is a hole in it.
    await recordOutboundMessage(
      threadId,
      payload.messageId,
      replySubject(payload.subject),
      HOLDING_ACK_BODY,
      decision,
    );

    logger.info("acknowledged pending approval to sender", {
      reason: decision.reason,
      to: payload.from.email,
    });
  }

  await advanceThread(threadId, "awaiting_approval", false, turnCount);

  const result = await wait.forToken<ApprovalDecision>(token);

  if (!result.ok) {
    await notifySlack(
      [
        `:hourglass: Approval timed out for *${payload.subject}* from ${payload.from.email}. The draft was never sent.`,
        acknowledge
          ? "The sender was told a colleague is picking it up, so they are waiting on a human reply. This thread needs one."
          : "The sender had already been acknowledged earlier in this thread.",
      ].join(" "),
    );
    await advanceThread(threadId, "escalated", false, turnCount);
    return { outcome: "approval_timeout" as const, reason: decision.reason };
  }

  const parsed = approvalDecisionSchema.safeParse(result.output);

  if (!parsed.success) {
    // Fail closed: an unrecognised callback payload is not an approval.
    //
    // The raw output is logged alongside the issues because zod's issue objects
    // keep `input` non-enumerable — it vanishes through JSON.stringify, so the
    // issue list alone reads identically whether the relay sent `{}`, an empty
    // string, an unrendered `{{decision}}`, or a `{"data":{…}}` wrapper.
    logger.error("malformed approval payload, treating as reject", {
      issues: parsed.error.issues,
      rawOutput: result.output,
      rawOutputType: typeof result.output,
    });
    await advanceThread(threadId, "escalated", false, turnCount);
    return { outcome: "approval_malformed" as const, reason: decision.reason };
  }

  if (parsed.data.decision === "reject") {
    await notifySlack(
      [
        `:x: Draft rejected for *${payload.subject}*. The draft was not sent.`,
        acknowledge
          ? "The sender was told a colleague is picking it up, so they are expecting a human reply."
          : "The sender had already been acknowledged earlier in this thread.",
      ].join(" "),
    );
    await advanceThread(threadId, "escalated", false, turnCount);
    return { outcome: "rejected" as const, reason: decision.reason };
  }

  await dispatch(payload, draft, decision, threadId);
  await advanceThread(threadId, "open", true, turnCount);

  return { outcome: "sent_after_approval" as const, reason: decision.reason };
}
