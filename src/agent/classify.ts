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

- asksForAccountData: true when answering correctly would require reading
  private records about an account this sender already has — their invoices,
  their usage, their subscription, their stored data, their support history.
  The test is whether there is an existing account to disclose. A prospect
  asking "what would this cost us for 20 seats" or "what does the Team plan
  include" is asking about the published product, not about an account: that is
  false, because there is nothing private to leak. An existing customer asking
  "what am I currently paying" or "when does my contract renew" is true.
  When the message genuinely could be either, choose true — a false positive
  costs one human glance, a false negative discloses account data
  automatically.

- needsHuman: true when the subject matter belongs to a person no matter how
  well you understood the message: legal, compliance or security questionnaires,
  complaints, cancellation threats, disputes, anything involving money moving.
  Judge the subject, not yourself. Do not set this because you found the
  message hard to read or were unsure of the intent — that is what confidence
  is for, and it routes to a gentler outcome. This flag sends the thread
  straight to a human with no draft written at all.

- confidence: your genuine confidence in the intent label, and only in the
  intent label. Around 0.9 when the message plainly fits one category, around
  0.7 when it fits but touches a second, below 0.6 only when you truly cannot
  tell what the sender wants. Do not lower it because the topic is sensitive or
  because you are unsure of the answer — neither is what this measures. Below
  0.6 the reply is held for human approval, which is right for a genuinely
  ambiguous message and needless friction for a clear one.`;

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
