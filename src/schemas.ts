import { z } from "zod";

/**
 * Every boundary contract in one file.
 *
 * Four kinds live here: what Make sends us, what Resend sends back when we ask
 * for a received message, what we send on to Slack and Resend, and the
 * input/output shape of each agent tool. Keeping them together means "is every
 * boundary validated?" is a question you answer by reading one file rather than
 * grepping the tree.
 *
 * The risk-tier contracts (`classificationSchema`, `riskInputSchema`) stay in
 * src/lib/risk-tier.ts, which owns them, and are re-exported at the bottom.
 */

// ---------------------------------------------------------------------------
// Inbound step 1: Make scenario A -> Trigger.dev `resend-inbound`
// ---------------------------------------------------------------------------

/**
 * What the relay forwards from Resend's `email.received` webhook.
 *
 * That webhook is **metadata only** — no body, no headers, no attachments — so
 * three fields is genuinely all there is worth passing on. Everything the agent
 * needs comes from the retrieve call in `src/trigger/resend-inbound.ts`.
 *
 * `receivedAt` is the envelope's `created_at` (when the mail arrived), not
 * `data.created_at` (when Resend wrote the record). They differ by the ingest
 * latency, and the first one is the one a human means by "received".
 */
export const resendInboundNoticeSchema = z.object({
  /** Resend's own id for the received message. Keys the retrieve call. */
  emailId: z.string().min(1),
  /** RFC 5322 Message-ID, angle brackets included. */
  messageId: z.string().min(1),
  receivedAt: z.iso.datetime(),
});

export type ResendInboundNotice = z.infer<typeof resendInboundNoticeSchema>;

// ---------------------------------------------------------------------------
// Inbound step 2: Resend `GET /emails/receiving/{id}` -> Trigger.dev
// ---------------------------------------------------------------------------

/**
 * Header collections arrive in one of the two shapes every mail API picks
 * between, and which one Resend returns is **not verified against a live
 * response yet**. Accepting both costs a union and removes an entire class of
 * first-run failure; guessing wrong costs a demo.
 *
 * A repeated header (`Received:` appears once per hop) is legal and common,
 * hence the array-valued map case.
 */
const resendHeadersSchema = z.union([
  z.array(z.object({ name: z.string(), value: z.string() })),
  z.record(z.string(), z.union([z.string(), z.array(z.string())])),
]);

export type ResendHeaders = z.infer<typeof resendHeadersSchema>;

/**
 * The retrieve response.
 *
 * Deliberately loose about everything we do not read. `attachments`, `raw` and
 * `html_format` are returned and ignored — declaring them would only create a
 * second place to update when Resend adds a field. What is pinned is the four
 * things normalisation depends on, and `text` is pinned as *nullable* because
 * an HTML-only message really does come back with `text: null`.
 */
export const resendReceivedEmailSchema = z.looseObject({
  /** Absent in principle; the webhook's copy is the fallback. */
  message_id: z.string().min(1).optional(),
  from: z.string().min(1),
  to: z.array(z.string()).default([]),
  received_for: z.array(z.string()).default([]),
  subject: z.string().nullish(),
  /** Null whenever the sender's client only produced an HTML part. */
  text: z.string().nullish(),
  html: z.string().nullish(),
  headers: resendHeadersSchema.default({}),
});

export type ResendReceivedEmail = z.infer<typeof resendReceivedEmailSchema>;

// ---------------------------------------------------------------------------
// Inbound step 3: `resend-inbound` -> `inbound-email`
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
   * Stable conversation key: the first Message-ID in `References` when the
   * client set one, else normalised-subject + sender. Derived in
   * `src/lib/inbound-normalize.ts`.
   */
  threadKey: z.string().min(1),

  from: z.object({
    email: z.email(),
    name: z.string().optional(),
  }),
  to: z.array(z.email()).min(1),
  subject: z.string().default(""),
  /** Plain-text body. HTML is stripped upstream so the agent never sees markup. */
  text: z.string(),

  headers: loopGuardHeadersSchema.default({}),

  /**
   * SPF and DKIM verdicts from the receiving mail server.
   *
   * Optional because the ingestion path usually cannot produce them: the
   * verdicts live inside the raw `Authentication-Results` header below, not as
   * booleans. Send either. Absent both, `resolveAuthentication` reads the
   * sender as unauthenticated — see src/lib/auth-results.ts for why that
   * direction is not negotiable.
   */
  spfPass: z.boolean().optional(),
  dkimPass: z.boolean().optional(),

  /** Raw `Authentication-Results` header, parsed into the two verdicts above. */
  authenticationResults: z.string().optional(),

  receivedAt: z.iso.datetime(),
});

export type InboundEmailPayload = z.infer<typeof inboundEmailPayloadSchema>;

// ---------------------------------------------------------------------------
// Outbound: Trigger.dev -> Resend
// ---------------------------------------------------------------------------

export const outboundEmailSchema = z.object({
  threadKey: z.string().min(1),
  /**
   * The inbound Message-ID. Becomes In-Reply-To and References so the reply
   * threads correctly, and doubles as the Resend idempotency key.
   */
  inReplyTo: z.string().min(1),
  to: z.email(),
  subject: z.string().min(1),
  body: z.string().min(1),
  /** The rule that authorised this send. Logged with every dispatch. */
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
