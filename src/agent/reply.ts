import { generateText, stepCountIs } from "ai";
import { logger } from "@trigger.dev/sdk";
import { MODEL, REPLY_OPTIONS } from "./model";
import { bookingLinkTool } from "../tools/booking";
import { crmLookupTool } from "../tools/crm";
import { kbSearchTool } from "../tools/kb-search";
import {
  kbSearchOutputSchema,
  type Classification,
  type InboundEmailPayload,
} from "../schemas";

/**
 * Tools that mutate state outside this system. Every call to one of these puts
 * the reply behind the approval gate via the external_write risk rule.
 *
 * Empty today: kb_search and crm_lookup are reads, and booking_link returns a
 * static URL without touching a calendar. The rule is armed rather than
 * decorative — the first genuinely mutating tool (create a deal, book a slot,
 * issue a refund) gets its name added here and is gated from that moment,
 * without touching risk-tier.ts.
 */
const WRITE_TOOLS = new Set<string>();

/** Three tools, so four steps leaves room to search, look up, and then answer. */
const MAX_STEPS = 4;

const SYSTEM = `You write replies for a B2B software company's shared sales inbox.
You are a support agent, not a chatbot: what you write is sent as an email over
the company's name.

The one rule that matters more than the others: never invent a customer fact.
If a tool returns nothing, or returns found: false, that means we genuinely do
not have the information. Say so plainly and offer to put the person in touch
with a human. A confidently wrong account status is far worse than admitting a
gap — it is the single worst thing you can do in this inbox.

How to work:
- Search the knowledge base before answering any factual question about the
  product. Do not answer product questions from memory, even ones you are sure
  about; the docs are the source of truth and they change.
- Look up the sender in the CRM when their account context would change the
  answer.
- Offer the booking link when someone wants a call or demo. Never state a
  specific time — the link is self-serve and holds nothing.
- Do not use a tool you do not need. A short answer that required no lookup is
  a good answer.

How to write:
- Plain text, no markdown, no headings, no bullet characters. This is email.
- Lead with the answer. Two or three short paragraphs is usually right.
- Match the sender's register. Do not open with "I hope this email finds you
  well" or close with a marketing pitch.
- Sign off as "The Mailroom team". Do not invent a personal name.
- Write only the body. No subject line, no "Subject:" prefix, no quoting of
  the original message.`;

export interface ReplyResult {
  /** The drafted email body. */
  body: string;
  /** Names of mutating tools the agent actually called. Feeds the risk input. */
  proposedWrites: string[];
  /** True when a kb_search returned at least one chunk above the floor. */
  hasGroundingEvidence: boolean;
  /** Every tool the agent called, in order. Logged for the run timeline. */
  toolsCalled: string[];
}

export async function draftReply(
  payload: InboundEmailPayload,
  classification: Classification,
): Promise<ReplyResult> {
  const result = await generateText({
    model: MODEL,
    system: SYSTEM,
    maxOutputTokens: 4_000,
    providerOptions: { anthropic: REPLY_OPTIONS },
    tools: {
      kb_search: kbSearchTool,
      crm_lookup: crmLookupTool,
      booking_link: bookingLinkTool,
    },
    stopWhen: stepCountIs(MAX_STEPS),
    prompt: [
      `The triage step classified this as intent "${classification.intent}"`,
      `with urgency "${classification.urgency}".`,
      "",
      `From: ${payload.from.name ?? ""} <${payload.from.email}>`,
      `Subject: ${payload.subject}`,
      "",
      payload.text.slice(0, 8_000),
      "",
      "Write the reply body.",
    ].join("\n"),
  });

  const toolsCalled: string[] = [];
  const proposedWrites: string[] = [];
  let hasGroundingEvidence = false;

  for (const step of result.steps) {
    for (const call of step.toolCalls) {
      toolsCalled.push(call.toolName);
      if (WRITE_TOOLS.has(call.toolName)) {
        proposedWrites.push(call.toolName);
      }
    }

    for (const toolResult of step.toolResults) {
      if (toolResult.toolName !== "kb_search") continue;

      // Re-validate rather than trusting the union narrowing: this boolean
      // decides whether an ungrounded answer reaches a customer unreviewed.
      const parsed = kbSearchOutputSchema.safeParse(toolResult.output);
      if (parsed.success && parsed.data.grounded) {
        hasGroundingEvidence = true;
      }
    }
  }

  const body = result.text.trim();

  if (body.length === 0) {
    throw new Error(
      "Agent produced no reply text. Refusing to send an empty email.",
    );
  }

  logger.info("drafted reply", {
    toolsCalled,
    proposedWrites,
    hasGroundingEvidence,
    steps: result.steps.length,
    bodyLength: body.length,
  });

  return { body, proposedWrites, hasGroundingEvidence, toolsCalled };
}
