import { logger } from "@trigger.dev/sdk";
import { z } from "zod";
import { env } from "../env";
import {
  outboundEmailSchema,
  slackNotificationSchema,
  type OutboundEmail,
} from "../schemas";

/**
 * The two outbound I/O calls: send an email via Resend, and tell a human via
 * Slack. Both validate their payload before it leaves the process.
 *
 * Sending does not go through Make. Mailbox ingestion does, because OAuth
 * against a shared inbox is genuinely tedious plumbing — but sending is one
 * authenticated POST, and routing it through a webhook would buy an extra
 * network hop, an untyped payload, and a scenario to maintain. The asymmetry
 * is the point: Make where connectors are hard, TypeScript where they are not.
 */

const RESEND_ENDPOINT = "https://api.resend.com/emails";

/** Resend answers a successful send with the id it filed the message under. */
const resendResponseSchema = z.object({ id: z.string().min(1) });

async function postJson(
  url: string,
  body: unknown,
  label: string,
  headers: Record<string, string> = {},
): Promise<string> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

  const text = await response.text().catch(() => "<unreadable>");

  if (!response.ok) {
    throw new Error(`${label} failed: ${response.status} ${text.slice(0, 200)}`);
  }

  return text;
}

/**
 * Sends the reply through Resend.
 *
 * In-Reply-To and References are both set to the inbound Message-ID. One
 * ancestor is a degenerate References chain, but it is enough for every major
 * client to file the reply under the original conversation, and it is what
 * keeps a reply from arriving as a detached new thread.
 */
export async function sendReply(email: OutboundEmail): Promise<void> {
  const payload = outboundEmailSchema.parse(email);

  const raw = await postJson(
    RESEND_ENDPOINT,
    {
      from: env.RESEND_FROM,
      to: [payload.to],
      subject: payload.subject,
      text: payload.body,
      headers: {
        "In-Reply-To": payload.inReplyTo,
        References: payload.inReplyTo,
      },
    },
    "sendReply",
    {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      // Third idempotency layer, and the only one that covers this specific
      // window: a send that succeeds at Resend but fails before we record it
      // is retried by Trigger.dev, and the outbound row is keyed on a fresh
      // UUID so nothing downstream would catch the duplicate. The inbound
      // Message-ID is stable across every attempt of this run, so Resend
      // returns the original send instead of delivering twice.
      "Idempotency-Key": payload.inReplyTo,
    },
  );

  // A 200 whose body we cannot read is not a send we can claim happened, so
  // this parse throws rather than shrugging and logging a success.
  const { id } = resendResponseSchema.parse(JSON.parse(raw));

  logger.info("reply sent", {
    to: payload.to,
    resendId: id,
    riskReason: payload.riskReason,
  });
}

/**
 * What an escalated sender receives instead of silence.
 *
 * A constant, not a generated draft, and that is the entire safety argument: no
 * model runs on an escalated message, so there is nothing here that can invent
 * an account status, promise a refund, or quote a price. It is the same text
 * every time and it can be read in full, right here, by whoever is deciding
 * whether it is safe to send.
 *
 * Two things it deliberately does not do. It does not say **why** a human is
 * involved — "we could not verify your identity" tells a spoofer precisely what
 * to forge next, and `unverified_sender_requesting_account_data` is the rule
 * that sends this most often. And it does not promise a timeframe we have not
 * agreed to; "shortly" is a commitment the support plan may not carry, so the
 * copy stays vague about when and specific about what happens next.
 */
export const ESCALATION_ACK_BODY = `Thanks for getting in touch.

Someone from the team is looking at this and will reply to you directly. There's
nothing you need to do in the meantime, and there's no need to send this again —
your message is with us.

The Mailroom team`;

/**
 * Acknowledges an escalated message.
 *
 * Goes through `sendReply` rather than posting to Resend separately, so it
 * inherits the threading headers and — more importantly — the same
 * Message-ID-keyed `Idempotency-Key`. A run that sends the acknowledgment and
 * then fails before recording it is retried, and Resend returns the original
 * send instead of delivering a second copy.
 */
export async function sendEscalationAck(
  email: Omit<OutboundEmail, "body">,
): Promise<void> {
  await sendReply({ ...email, body: ESCALATION_ACK_BODY });
}

export async function notifySlack(text: string): Promise<void> {
  const payload = slackNotificationSchema.parse({
    text,
    unfurl_links: false,
    unfurl_media: false,
  });

  await postJson(env.SLACK_WEBHOOK_URL, payload, "notifySlack");
}

/**
 * Builds an approve/reject link pair for a waitpoint token.
 *
 * A Slack incoming webhook can only render a hyperlink, and a hyperlink is a
 * GET — but completing a waitpoint is a POST. Make scenario C is the
 * three-module relay that bridges the two: it takes this GET, POSTs the
 * decision to the token's callback URL, and returns a confirmation page.
 *
 * `token.url` ends in `/callback/<64-hex>`, and that suffix is the credential —
 * the relay needs no Trigger.dev key of its own. (There is a second endpoint,
 * `/complete`, which does want a bearer token. It is not the one we use.)
 *
 * The tradeoff is that the link itself is the authority: anyone who can read
 * the Slack channel can approve. That is the intended threat model for an
 * approval channel, but it is why the channel should be private — and why the
 * relay must not act on the GET itself. See make/README.md scenario C.
 */
export function approvalLinks(callbackUrl: string): {
  approve: string;
  reject: string;
} {
  const build = (decision: "approve" | "reject") => {
    const url = new URL(env.APPROVAL_RELAY_BASE_URL);
    url.searchParams.set("callback", callbackUrl);
    url.searchParams.set("decision", decision);
    return url.toString();
  };

  return { approve: build("approve"), reject: build("reject") };
}
