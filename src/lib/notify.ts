import { logger } from "@trigger.dev/sdk";
import { env } from "../env";
import {
  outboundEmailSchema,
  slackNotificationSchema,
  type OutboundEmail,
} from "../schemas";

/**
 * The two outbound I/O calls: send an email via Make scenario B, and tell a
 * human via Slack. Both validate their payload before it leaves the process.
 */

async function postJson(url: string, body: unknown, label: string) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "<unreadable>");
    throw new Error(`${label} failed: ${response.status} ${text.slice(0, 200)}`);
  }
}

/** POSTs to Make scenario B, which sends the email and logs CRM activity. */
export async function sendReply(email: OutboundEmail): Promise<void> {
  const payload = outboundEmailSchema.parse(email);

  await postJson(env.MAKE_OUTBOUND_WEBHOOK_URL, payload, "sendReply");

  logger.info("reply dispatched to Make", {
    to: payload.to,
    riskReason: payload.riskReason,
  });
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
