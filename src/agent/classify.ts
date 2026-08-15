import { generateObject } from "ai";
import { logger } from "@trigger.dev/sdk";
import { CLASSIFY_OPTIONS, MODEL } from "./model";
import {
  classificationSchema,
  type Classification,
  type InboundEmailPayload,
} from "../schemas";

const SYSTEM = `You triage inbound email for a B2B software company's shared sales inbox.

Classify the message. You are not writing a reply and you are not deciding
what happens next — a separate rules engine does that from your output. Your
only job is to describe the message accurately.

Field guidance:

- intent: what the sender actually wants.
  - account_question: asks about THEIR specific account, subscription, billing,
    usage, or data. The distinguishing feature is that answering correctly
    requires looking up private records about this particular customer.
  - general_info: asks about the product in general — pricing tiers, security
    posture, integrations, how something works. Answerable from public docs.
  - sales: evaluating or buying. Asks for quotes, comparisons, trials.
  - meeting: wants to schedule a call, demo, or meeting.
  - spam: unsolicited bulk mail, SEO and lead-gen pitches, crypto, anything
    mass-mailed. Cold outreach TO us is spam, not sales.
  - abuse: threats, harassment, or clearly malicious content.
  - other: none of the above.

- asksForAccountData: true when a correct answer would disclose something
  specific to this sender's account. Err toward true — a false positive costs
  one human glance, a false negative discloses account data automatically.

- needsHuman: true when a person should handle this regardless of what the
  message asks: legal or compliance matters, complaints, cancellation threats,
  anything involving money moving, or anything you cannot confidently classify.

- confidence: your genuine confidence in the intent label. Do not inflate it.
  Low confidence routes the reply to a human for approval, which is the correct
  outcome when the message is genuinely ambiguous.`;

export async function classify(
  payload: InboundEmailPayload,
): Promise<Classification> {
  const { object } = await generateObject({
    model: MODEL,
    schema: classificationSchema,
    system: SYSTEM,
    maxOutputTokens: 2_000,
    providerOptions: { anthropic: CLASSIFY_OPTIONS },
    prompt: [
      `From: ${payload.from.name ?? ""} <${payload.from.email}>`,
      `Subject: ${payload.subject}`,
      "",
      payload.text.slice(0, 8_000),
    ].join("\n"),
  });

  logger.info("classified", {
    intent: object.intent,
    confidence: object.confidence,
    asksForAccountData: object.asksForAccountData,
    needsHuman: object.needsHuman,
  });

  return object;
}
