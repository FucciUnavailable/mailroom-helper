import { logger, schemaTask, wait } from "@trigger.dev/sdk";
import { z } from "zod";
import { classify } from "../agent/classify";
import { draftReply, type ReplyResult } from "../agent/reply";
import {
  advanceThread,
  countRepliesLast24h,
  recordDecision,
  recordInboundMessage,
  recordOutboundMessage,
  resolveContact,
  resolveThread,
} from "../lib/db";
import { approvalLinks, notifySlack, sendReply } from "../lib/notify";
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

    const baseRiskInput = {
      classification,
      isAutomatedSender: isAutomatedSender(payload),
      senderAuthenticated: payload.spfPass && payload.dkimPass,
      contactResolved: contact !== null,
      threadTurnCount: thread.turnCount,
      repliesLast24h,
    };

    // ---- 4. Pre-agent gate ---------------------------------------------
    // BLOCK and ESCALATE both mean no AI-drafted reply is ever sent, so there
    // is nothing for the agent to write. Short-circuiting here is what keeps
    // spam from reaching a model call.
    const earlyDecision = assessPreAgentRisk(baseRiskInput);

    if (earlyDecision !== null) {
      await recordDecision(message.id, classification, earlyDecision);
      return finishWithoutReply(
        earlyDecision,
        payload,
        classification,
        thread.id,
        thread.turnCount,
      );
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
        return waitForApproval(
          payload,
          draft,
          decision,
          thread.id,
          thread.turnCount,
        );

      // The pre-agent gate already returned for these, but the switch stays
      // exhaustive: assessRisk is a complete decision on its own, and a future
      // rule moving across the pre/post boundary must not fall through here.
      case RiskTier.BLOCK:
      case RiskTier.ESCALATE:
        return finishWithoutReply(
          decision,
          payload,
          classification,
          thread.id,
          thread.turnCount,
        );
    }
  },
});

/** BLOCK logs and stops. ESCALATE hands the thread to a human, with no draft. */
async function finishWithoutReply(
  decision: RiskDecision,
  payload: InboundEmailPayload,
  classification: Classification,
  threadId: string,
  turnCount: number,
) {
  if (decision.tier === RiskTier.BLOCK) {
    logger.info("blocked, no reply sent", {
      reason: decision.reason,
      intent: classification.intent,
      from: payload.from.email,
    });
    await advanceThread(threadId, "closed", false, turnCount);
    return { outcome: "blocked" as const, reason: decision.reason };
  }

  await notifySlack(
    [
      `:rotating_light: *Escalated — no AI reply sent*`,
      `*From:* ${payload.from.email}`,
      `*Subject:* ${payload.subject}`,
      `*Rule:* \`${decision.reason}\``,
      `*Intent:* ${classification.intent}`,
      "",
      "The agent did not draft anything. This thread needs a human.",
    ].join("\n"),
  );

  await advanceThread(threadId, "escalated", false, turnCount);
  return { outcome: "escalated" as const, reason: decision.reason };
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
 */
async function waitForApproval(
  payload: InboundEmailPayload,
  draft: ReplyResult,
  decision: RiskDecision,
  threadId: string,
  turnCount: number,
) {
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
    ].join("\n"),
  );

  await advanceThread(threadId, "awaiting_approval", false, turnCount);

  const result = await wait.forToken<ApprovalDecision>(token);

  if (!result.ok) {
    await notifySlack(
      `:hourglass: Approval timed out for *${payload.subject}* from ${payload.from.email}. No reply was sent.`,
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
      `:x: Draft rejected for *${payload.subject}*. Nothing was sent.`,
    );
    await advanceThread(threadId, "escalated", false, turnCount);
    return { outcome: "rejected" as const, reason: decision.reason };
  }

  await dispatch(payload, draft, decision, threadId);
  await advanceThread(threadId, "open", true, turnCount);

  return { outcome: "sent_after_approval" as const, reason: decision.reason };
}
