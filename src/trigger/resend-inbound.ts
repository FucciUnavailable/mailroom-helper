import {
  AbortTaskRunError,
  idempotencyKeys,
  logger,
  schemaTask,
} from "@trigger.dev/sdk";
import { env } from "../env";
import {
  deriveThreadKey,
  headerLookup,
  loopGuardHeaders,
  parseAddress,
  parseAddressList,
  resolveBody,
  type HeaderLookup,
} from "../lib/inbound-normalize";
import {
  inboundEmailPayloadSchema,
  resendInboundNoticeSchema,
  resendReceivedEmailSchema,
  type ResendInboundNotice,
  type ResendReceivedEmail,
} from "../schemas";
import { inboundEmail } from "./inbound-email";

/**
 * The ingestion adapter: Resend's `email.received` notice in, a validated
 * `inboundEmailPayloadSchema` out.
 *
 * It exists because Resend's webhook is **metadata only**. There is no body, no
 * headers, and no attachments in the event — those come from a second,
 * authenticated `GET /emails/receiving/{id}`. Something has to make that call,
 * and it is not going to be a Make module: the response needs parsing,
 * normalising, and validating, which is precisely the work this project keeps
 * in TypeScript.
 *
 * The split it leaves behind is the smallest one yet. Make scenario A is two
 * modules — a webhook and an HTTP POST — because Trigger.dev v4 has no incoming
 * webhook trigger of its own. Make is doing nothing but converting one HTTP
 * request into another, and the moment Trigger.dev ships a webhook trigger,
 * scenario A deletes itself.
 *
 * `inbound-email` is untouched by all of this. It stays a pure function of a
 * validated payload, which is what lets `pnpm sample` keep driving it from a
 * fixture with no mail provider in the loop at all.
 */

const RECEIVING_ENDPOINT = "https://api.resend.com/emails/receiving";

/**
 * Fetches the full message.
 *
 * A 5xx, a 429, or a 404 is retried by the platform: the first two are
 * transient, and the third can be the webhook outrunning the record it points
 * at. Every other 4xx aborts, because a rejected key or a malformed id returns
 * the same answer on attempt three as on attempt one and the only thing three
 * attempts buys is a slower failure.
 */
async function retrieveEmail(emailId: string): Promise<ResendReceivedEmail> {
  const response = await fetch(
    `${RECEIVING_ENDPOINT}/${encodeURIComponent(emailId)}`,
    { headers: { authorization: `Bearer ${env.RESEND_API_KEY}` } },
  );

  const body = await response.text().catch(() => "<unreadable>");

  if (!response.ok) {
    const detail = `${response.status} ${body.slice(0, 200)}`;
    const retryable =
      response.status >= 500 || response.status === 429 || response.status === 404;

    if (!retryable) {
      throw new AbortTaskRunError(`Resend retrieve rejected: ${detail}`);
    }

    throw new Error(`Resend retrieve failed: ${detail}`);
  }

  return resendReceivedEmailSchema.parse(JSON.parse(body));
}

/**
 * Authentication verdicts, forwarded rather than decided.
 *
 * The raw `Authentication-Results` string goes across as-is and
 * `src/lib/auth-results.ts` pattern-matches it, for the reason that file
 * documents at length: the regex that gates account-data disclosure belongs
 * somewhere it can be read and tested, not spread across an ingestion path.
 *
 * **Unverified against a live response:** whether Resend includes
 * `Authentication-Results` in `headers` at all. If it turns out not to, Resend
 * runs its own inbound SPF and DKIM checks and this is the one function that
 * changes — map those fields onto the payload's optional `spfPass`/`dkimPass`
 * booleans, which `resolveAuthentication` already prefers over the header.
 *
 * Until then, absence is not a problem to paper over. A missing header reads as
 * *unauthenticated*, which routes an account-data request to escalation instead
 * of putting a spoofable draft in front of a human who will click approve.
 * Hardcoding `spfPass: true` here would turn a real rule into decoration.
 */
function authenticationResults(lookup: HeaderLookup): string | undefined {
  return lookup("Authentication-Results");
}

function buildPayload(notice: ResendInboundNotice, email: ResendReceivedEmail) {
  const lookup = headerLookup(email.headers);

  const from = parseAddress(email.from);
  const subject = email.subject ?? "";

  // `to` is the envelope's recipient list; `received_for` is the address Resend
  // actually accepted the mail for, and it is the one that survives an alias or
  // a Bcc — where `to` names someone else entirely, or nobody.
  const recipients = parseAddressList(email.to);
  const to =
    recipients.length > 0 ? recipients : parseAddressList(email.received_for);

  const inReplyTo = lookup("In-Reply-To");
  const auth = authenticationResults(lookup);

  return inboundEmailPayloadSchema.parse({
    messageId: email.message_id ?? notice.messageId,
    ...(inReplyTo !== undefined && { inReplyTo }),
    threadKey: deriveThreadKey(lookup("References"), subject, from.email),

    from,
    to,
    subject,
    text: resolveBody(email.text, email.html),

    headers: loopGuardHeaders(lookup),
    ...(auth !== undefined && { authenticationResults: auth }),

    receivedAt: notice.receivedAt,
  });
}

export const resendInbound = schemaTask({
  id: "resend-inbound",
  schema: resendInboundNoticeSchema,
  // One authenticated GET and one trigger. Nothing here waits on a model.
  maxDuration: 60,
  run: async (notice) => {
    const email = await retrieveEmail(notice.emailId);

    // The webhook and the stored record both carry a Message-ID and they should
    // agree. If they ever don't, the retrieved one wins — it comes from the same
    // response as the headers everything else is derived from — but the
    // disagreement is worth a log line, because it means one of the two is not
    // what we think it is.
    if (
      email.message_id !== undefined &&
      email.message_id !== notice.messageId
    ) {
      logger.warn("Message-ID disagreement between webhook and record", {
        fromWebhook: notice.messageId,
        fromRecord: email.message_id,
      });
    }

    let payload;

    try {
      payload = buildPayload(notice, email);
    } catch (error) {
      // Normalisation produced something the task contract rejects. Retrying
      // re-derives it from the same bytes and fails identically, so stop — and
      // stop loudly, because a message dropped here never reaches the classifier
      // and would otherwise look like mail that simply never arrived.
      throw new AbortTaskRunError(
        `Could not normalise ${notice.emailId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    // Global scope, not the default.
    //
    // Inside a run, a raw string key is scoped to *this* run, which would make
    // it useless for the thing it is here to do: two `resend-inbound` runs for
    // the same message — a webhook redelivered after Make's own dedupe window,
    // say — would each get their own key and each trigger a reply. Scoping to
    // the Message-ID globally is what makes it the idempotency key the rest of
    // the system already assumes it is.
    const key = await idempotencyKeys.create(payload.messageId, {
      scope: "global",
    });

    const handle = await inboundEmail.trigger(payload, { idempotencyKey: key });

    logger.info("handed off to inbound-email", {
      emailId: notice.emailId,
      messageId: payload.messageId,
      threadKey: payload.threadKey,
      runId: handle.id,
      bodyChars: payload.text.length,
      // Absence is the interesting case: it means the reply to anything
      // sensitive will be escalated rather than drafted.
      hasAuthenticationResults: payload.authenticationResults !== undefined,
    });

    return {
      outcome: "handed_off" as const,
      messageId: payload.messageId,
      runId: handle.id,
    };
  },
});
