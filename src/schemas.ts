import { z } from "zod";

/**
 * Every boundary contract in one file.
 *
 * Three kinds live here: what Make sends us, what we send back to Make and
 * Slack, and the input/output shape of each agent tool. Keeping them together
 * means "is every boundary validated?" is a question you answer by reading one
 * file rather than grepping the tree.
 *
 * The risk-tier contracts (`classificationSchema`, `riskInputSchema`) stay in
 * src/lib/risk-tier.ts, which owns them, and are re-exported at the bottom.
 */

// ---------------------------------------------------------------------------
// Inbound: Make scenario A -> Trigger.dev
// ---------------------------------------------------------------------------

/**
 * Loop-guard headers. Their mere presence marks the sender as automated —
 * values are kept for the log, but the risk rule only asks whether any of them
 * arrived at all.
 */
export const loopGuardHeadersSchema = z.object({
  autoSubmitted: z.string().optional(),
  precedence: z.string().optional(),
  listUnsubscribe: z.string().optional(),
  listId: z.string().optional(),
});

export type LoopGuardHeaders = z.infer<typeof loopGuardHeadersSchema>;

export const inboundEmailPayloadSchema = z.object({
  /** RFC 5322 Message-ID, angle brackets included. The idempotency key. */
  messageId: z.string().min(1),
  /** Message-ID this is a reply to, when the mail client set one. */
  inReplyTo: z.string().optional(),
  /**
   * Stable conversation key. Make derives it from the References header when
   * present and falls back to normalised-subject + sender.
   */
  threadKey: z.string().min(1),

  from: z.object({
    email: z.email(),
    name: z.string().optional(),
  }),
  to: z.array(z.email()).min(1),
  subject: z.string().default(""),
  /** Plain-text body. HTML is stripped in Make so the agent never sees markup. */
  text: z.string(),

  headers: loopGuardHeadersSchema.default({}),

  /** SPF and DKIM verdicts from the receiving mail server. */
  spfPass: z.boolean(),
  dkimPass: z.boolean(),

  receivedAt: z.iso.datetime(),
});

export type InboundEmailPayload = z.infer<typeof inboundEmailPayloadSchema>;

// ---------------------------------------------------------------------------
// Outbound: Trigger.dev -> Make scenario B
// ---------------------------------------------------------------------------

export const outboundEmailSchema = z.object({
  threadKey: z.string().min(1),
  /** Set as In-Reply-To so the reply threads correctly in the client. */
  inReplyTo: z.string().min(1),
  to: z.email(),
  subject: z.string().min(1),
  body: z.string().min(1),
  /** Echoed back so scenario B can log the activity against the right contact. */
  contactEmail: z.email().nullable(),
  /** The rule that authorised this send. Logged to the CRM activity record. */
  riskReason: z.string().min(1),
});

export type OutboundEmail = z.infer<typeof outboundEmailSchema>;

// ---------------------------------------------------------------------------
// Outbound: Trigger.dev -> Slack incoming webhook
// ---------------------------------------------------------------------------

/**
 * `unfurl_links` is not cosmetic here. Slack fetches every URL in a message to
 * build its preview, and the approval message contains an approve link and a
 * reject link — so the unfurler clicked both, in the same second, before any
 * human saw the message. Whichever landed first burned the waitpoint.
 *
 * Turning unfurling off stops Slack specifically. It does not make the links
 * safe: they are still GETs that change state, so any URL scanner sitting in
 * front of a mailbox or browser can do the same thing. The durable fix is a
 * confirmation step in the relay, see make/README.md scenario C.
 */
export const slackNotificationSchema = z.object({
  text: z.string().min(1),
  unfurl_links: z.literal(false),
  unfurl_media: z.literal(false),
});

export type SlackNotification = z.infer<typeof slackNotificationSchema>;

// ---------------------------------------------------------------------------
// Agent tools.
//
// Output schemas matter as much as input schemas here. Each tool returns an
// explicit "found nothing" shape rather than throwing or returning null, so
// the model has something concrete to say when the answer is not available —
// which is the difference between "I don't have that, let me get a human" and
// an invented account status.
// ---------------------------------------------------------------------------

export const kbSearchInputSchema = z.object({
  query: z
    .string()
    .min(3)
    .describe("A focused natural-language question to look up."),
});

export const kbSearchOutputSchema = z.object({
  chunks: z.array(
    z.object({
      source: z.string(),
      content: z.string(),
      /** ts_rank score. Ordering signal only — the floor is applied in SQL. */
      rank: z.number(),
    }),
  ),
  /** False when nothing cleared the relevance floor. Feeds the risk input. */
  grounded: z.boolean(),
});

export type KbSearchOutput = z.infer<typeof kbSearchOutputSchema>;

export const crmLookupInputSchema = z.object({
  email: z.email().describe("The exact email address to look up."),
});

export const crmLookupOutputSchema = z.object({
  found: z.boolean(),
  contact: z
    .object({
      email: z.string(),
      fullName: z.string(),
      company: z.string().nullable(),
      lifecycleStage: z.string(),
      notes: z.string().nullable(),
    })
    .nullable(),
});

export type CrmLookupOutput = z.infer<typeof crmLookupOutputSchema>;

export const bookingLinkInputSchema = z.object({
  reason: z
    .string()
    .optional()
    .describe("Why a meeting is being offered. Used only for logging."),
});

export const bookingLinkOutputSchema = z.object({
  url: z.url(),
  note: z.string(),
});

export type BookingLinkOutput = z.infer<typeof bookingLinkOutputSchema>;

// ---------------------------------------------------------------------------
// Re-exports: the risk contracts live with the function that enforces them.
// ---------------------------------------------------------------------------

export {
  classificationSchema,
  riskInputSchema,
  preAgentRiskInputSchema,
  type Classification,
  type RiskInput,
  type PreAgentRiskInput,
} from "./lib/risk-tier";
