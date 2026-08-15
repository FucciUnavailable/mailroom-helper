# Make scenarios

Three scenarios, eleven modules total. Make is the I/O shell: it owns mailbox
auth, sending, and the HTTP plumbing that is genuinely tedious to hand-roll.
Every decision lives in `src/`.

> **There are no blueprints committed yet.** Exports embed connection IDs,
> webhook URLs, and header values, and a hand-written export with guessed
> module identifiers will not import cleanly — a broken import is worse than
> none. Build the three scenarios below, export each one, run the scrub
> checklist at the bottom, and commit the results to `make/blueprints/`.

## Scenario A — inbound (5 modules)

Watches the shared mailbox and hands each message to Trigger.dev.

| # | Module | Notes |
|---|---|---|
| 1 | **Email › Watch emails** (or Gmail / Microsoft 365) | Poll the shared sales inbox. Mark as read on fetch so a slow run cannot double-deliver. |
| 2 | **Tools › Set multiple variables** | Derive `threadKey`: take the first Message-ID in `References`, else normalise the subject (strip `Re:`/`Fwd:`, lowercase, trim) and append the sender address. |
| 3 | **Flow control › Filter** | The loop guard. Drop the message when the sender equals the inbox address. Header-based guards are *not* filtered here — they are forwarded and decided in `risk-tier.ts`, so a blocked auto-responder still gets logged. |
| 4 | **Tools › Compose a string** | Build the JSON body. Shape below. |
| 5 | **HTTP › Make a request** | `POST https://api.trigger.dev/api/v1/tasks/inbound-email/trigger`<br>Headers: `Authorization: Bearer {{TRIGGER_SECRET_KEY}}`, `Content-Type: application/json`<br>Body: `{"payload": <the object below>, "options": {"idempotencyKey": "{{Message-ID}}"}}` |

The idempotency key is a **body field under `options`**, not an HTTP header —
the trigger endpoint ignores an `Idempotency-Key` header, so putting it there
looks correct and silently dedupes nothing. That body field is the first line of
defence against redelivery; the unique constraint on `messages.message_id` is
the second, and the only one that catches a mistake here.

The secret key selects the environment. A `tr_dev_…` key routes the run to your
**dev** environment, which only executes while `pnpm dev` is running on your
machine — fine for the demo, but the terminal has to stay up. A deployed
`tr_prod_…` key runs without it.

### Body shape

This must satisfy `inboundEmailPayloadSchema` in `src/schemas.ts` — that schema
is the contract, and the task rejects anything that does not match.

```json
{
  "messageId": "<CAF...@mail.example.com>",
  "inReplyTo": "<optional>",
  "threadKey": "derived-in-module-2",
  "from": { "email": "sender@example.com", "name": "Sender Name" },
  "to": ["sales@yourdomain.com"],
  "subject": "Question about your plans",
  "text": "plain text body, HTML stripped",
  "headers": {
    "autoSubmitted": "value of Auto-Submitted, omit if absent",
    "precedence": "value of Precedence, omit if absent",
    "listUnsubscribe": "value of List-Unsubscribe, omit if absent",
    "listId": "value of List-Id, omit if absent"
  },
  "spfPass": true,
  "dkimPass": true,
  "receivedAt": "2026-08-14T09:12:00.000Z"
}
```

Omit the header keys that are absent rather than sending empty strings — the
risk rule treats presence as the signal.

## Scenario B — outbound (3 modules)

| # | Module | Notes |
|---|---|---|
| 1 | **Webhooks › Custom webhook** | Receives `outboundEmailSchema`. Set this URL as `MAKE_OUTBOUND_WEBHOOK_URL`. |
| 2 | **Email › Send an email** | To `to`, subject `subject`, body `body`, and set the `In-Reply-To` header to `inReplyTo` so the reply threads properly. |
| 3 | **HTTP › Make a request** (or a CRM module) | Log the activity. `contactEmail` and `riskReason` are included so the CRM record shows which rule authorised the send. |

## Scenario C — approval relay (3 modules)

Exists because a Slack incoming webhook can only render a hyperlink, and a
hyperlink is a `GET` — but completing a Trigger.dev waitpoint is a `POST`.

| # | Module | Notes |
|---|---|---|
| 1 | **Webhooks › Custom webhook** | Accepts `GET` with `?callback=<url-encoded>&decision=approve\|reject&token=<jwt>`. Set the base URL as `APPROVAL_RELAY_BASE_URL`. Make learns a webhook's data structure from the first request it sees, so hit the URL once with all three query params before wiring module 2 — otherwise `{{callback}}` will not be offered in the mapping panel. |
| 2 | **HTTP › Make a request** | `POST` to `{{callback}}`, body `{"decision": "{{decision}}"}`. No auth header — the callback URL's own suffix is the credential. |
| 3 | **Webhooks › Webhook response** | Status `200`, a short HTML confirmation — this is what the approver sees in their browser. Needs the scenario set to respond immediately. |

There are **two different completion endpoints**, and they take different
bodies. Mixing them up costs an evening, so:

| Endpoint | Auth | Body | Used by |
| --- | --- | --- | --- |
| `/waitpoints/tokens/<id>/callback/<secret>` — this is `token.url` | the `<secret>` in the path | the raw body **is** the run's output: `{"decision":"approve"}` | scenario C |
| `/waitpoints/tokens/<id>/complete` | `Authorization: Bearer <key>` | wrapped: `{"data":{"decision":"approve"}}` | the SDK, so `pnpm approve` |

Send scenario C's body wrapped in `data` and the run resumes with `decision`
undefined, `approvalDecisionSchema` fails, and `inbound-email.ts` fails closed
with `approval_malformed` — the approver sees a success page in the browser and
the mail is never sent. Failing closed is correct, but it is silent from the
approver's side, so it is worth testing once for real.

Because the callback URL carries its own secret, the relay stores no
Trigger.dev credentials at all. The tradeoff is that the link is the authority:
anyone who can read the Slack channel can approve.

### The links are GETs, and bots click them

Approve and reject are plain hyperlinks, so **anything that follows links will
click both**. Slack's own unfurler did exactly that during testing — two
executions in the same second, one approve and one reject, several minutes
before a human saw the message. Whichever landed first burned the waitpoint;
the human's later click hit a spent token, got a cheerful 200, and did nothing.

`notifySlack` now sends `unfurl_links: false`, which stops Slack. It does not
make the links safe — a URL scanner in front of a mailbox or browser can still
trip them. The production fix is for the relay to answer the bare GET with a
confirmation page and only act on a second, explicit request: a **Router**
before module 2, where the confirming route filters on `confirm` existing and
the fallback route returns a page whose button links back with `&confirm=1`.
Crawlers fetch the page and stop.

## Scrub checklist before committing an export

Blueprint JSON embeds live values. Every one of these must be gone:

- [ ] `"__IMTCONN__"` connection IDs → replace with `null`
- [ ] Webhook URLs and hook IDs (`https://hook.*.make.com/...`)
- [ ] The `Authorization` header value in scenario A module 5
- [ ] Any captured `token` JWT in scenario C's learned webhook sample data
- [ ] The mailbox address and any real sender addresses in sample data
- [ ] `scheduling` blocks referencing a specific account
- [ ] Any `"data"` blobs left over from a test run

Then confirm with `rg -i 'hook\.|make\.com/|Bearer |__IMTCONN__' make/blueprints/`.
