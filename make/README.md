# Make scenarios

Three scenarios, ten modules total. Make is the I/O shell: it owns mailbox
auth, sending, and the HTTP plumbing that is genuinely tedious to hand-roll.
Every decision lives in `src/`.

> **`blueprints/` is empty in this repo.** Blueprint exports embed connection
> IDs, webhook URLs, and header values, and a hand-written export with guessed
> module identifiers will not import. Build the three scenarios below, export
> each one, run the scrub checklist, and commit the results.

## Scenario A — inbound (5 modules)

Watches the shared mailbox and hands each message to Trigger.dev.

| # | Module | Notes |
|---|---|---|
| 1 | **Email › Watch emails** (or Gmail / Microsoft 365) | Poll the shared sales inbox. Mark as read on fetch so a slow run cannot double-deliver. |
| 2 | **Tools › Set multiple variables** | Derive `threadKey`: take the first Message-ID in `References`, else normalise the subject (strip `Re:`/`Fwd:`, lowercase, trim) and append the sender address. |
| 3 | **Flow control › Filter** | The loop guard. Drop the message when the sender equals the inbox address. Header-based guards are *not* filtered here — they are forwarded and decided in `risk-tier.ts`, so a blocked auto-responder still gets logged. |
| 4 | **Tools › Compose a string** | Build the JSON body. Shape below. |
| 5 | **HTTP › Make a request** | `POST https://api.trigger.dev/api/v3/tasks/inbound-email/trigger`<br>Headers: `Authorization: Bearer {{TRIGGER_SECRET_KEY}}`, `Content-Type: application/json`, **`Idempotency-Key: {{Message-ID}}`**<br>Body: `{"payload": <the object below>}` |

The `Idempotency-Key` header is the first line of defence against redelivery.
The unique constraint on `messages.message_id` is the second.

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

## Scenario C — approval relay (2 modules)

Exists because a Slack incoming webhook can only render a hyperlink, and a
hyperlink is a `GET` — but completing a Trigger.dev waitpoint is a `POST`.

| # | Module | Notes |
|---|---|---|
| 1 | **Webhooks › Custom webhook** | Accepts `GET` with `?callback=<url-encoded>&decision=approve\|reject`. Set the base URL as `APPROVAL_RELAY_BASE_URL`. |
| 2 | **HTTP › Make a request** | `POST` to `{{callback}}` with body `{"decision": "{{decision}}"}`. Then respond `200` with a short confirmation page — this is what the approver sees in their browser. |

The callback URL carries its own unguessable secret, so this scenario stores no
Trigger.dev credentials. The tradeoff is that the link itself is the authority:
anyone who can read the Slack channel can approve. Keep that channel private.

## Scrub checklist before committing an export

Blueprint JSON embeds live values. Every one of these must be gone:

- [ ] `"__IMTCONN__"` connection IDs → replace with `null`
- [ ] Webhook URLs and hook IDs (`https://hook.*.make.com/...`)
- [ ] The `Authorization` header value in scenario A module 5
- [ ] The mailbox address and any real sender addresses in sample data
- [ ] `scheduling` blocks referencing a specific account
- [ ] Any `"data"` blobs left over from a test run

Then confirm with `rg -i 'hook\.|make\.com/|Bearer |__IMTCONN__' make/blueprints/`.
