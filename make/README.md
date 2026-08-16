# Make scenarios

Two scenarios, five modules total. Make is the I/O shell: it owns the HTTP
plumbing Trigger.dev cannot do for itself. Every decision lives in `src/`.

**There is no outbound scenario.** Sending used to be a third scenario and is
now a direct Resend call in `src/lib/notify.ts`. One authenticated POST does not
need a connector platform; putting it behind a webhook would have bought an
extra network hop, an untyped payload, and a scenario to keep alive.

Inbound has shrunk the same way. It used to be a five-module mailbox watcher
that polled IMAP, derived the thread key, and composed the payload by hand.
Inbound mail now arrives at Resend, and the work Make was doing — parsing,
deriving, normalising — moved into `src/trigger/resend-inbound.ts` where it can
be typed and read. What is left in Make is the one thing TypeScript genuinely
cannot do here: **Trigger.dev v4 has no incoming-webhook trigger**, so something
has to turn Resend's POST into a task trigger. That is two modules, and the day
Trigger.dev ships a webhook trigger, scenario A deletes itself.

> **Both scenarios can now be committed.** See
> `make/blueprints/scenario-c-approval-relay.json` — a real export, scrubbed
> per the checklist at the bottom, with its `hook` id nulled so importing
> prompts you to attach your own webhook.
>
> Scenario A used to be the exception, because it carried a mailbox connection
> and exports embed connection ids. The relay version has **no connection at
> all** — a custom webhook and an HTTP module — so the only things to scrub are
> the hook id and the `Authorization` header. Build it from the table below,
> export, scrub, commit.

## Scenario A — inbound relay (2 modules)

Turns Resend's `email.received` webhook into a Trigger.dev task trigger. It does
no parsing whatsoever; it forwards three fields.

| # | Module | Notes |
|---|---|---|
| 1 | **Webhooks › Custom webhook** | Register this URL in the Resend dashboard. Subscribe it to **`email.received` only** — see the warning below. Make learns the data structure from the first request, so send one real email before wiring module 2 or `{{1.data.email_id}}` will not appear in the mapping panel. |
| 2 | **HTTP › Make a request** | `POST https://api.trigger.dev/api/v1/tasks/resend-inbound/trigger`<br>Headers: `Authorization: Bearer {{TRIGGER_SECRET_KEY}}`, `Content-Type: application/json`<br>Body: below. |

```json
{
  "payload": {
    "emailId": "{{1.data.email_id}}",
    "messageId": "{{1.data.message_id}}",
    "receivedAt": "{{1.created_at}}"
  },
  "options": { "idempotencyKey": "{{1.data.email_id}}" }
}
```

**Subscribe to `email.received` only.** Resend fires events for outbound mail on
the same endpoint if you let it, and every reply the agent sends would trigger a
fresh ingestion of its own reply. The header-based loop guards in `risk-tier.ts`
would not catch it, because our own send is not marked as automated.

**`{{1.created_at}}`, not `{{1.data.created_at}}`.** The envelope's timestamp is
when the mail arrived; the one inside `data` is when Resend wrote the record.
They differ by the ingest latency, and the first is what a human means by
"received".

The idempotency key is a **body field under `options`**, not an HTTP header —
the trigger endpoint ignores an `Idempotency-Key` header, so putting it there
looks correct and silently dedupes nothing. This one is keyed on `email_id`
rather than the Message-ID because it is deduplicating *webhook redelivery*, and
the email id is what identifies the delivery. The Message-ID key is applied one
layer in, when `resend-inbound` triggers `inbound-email`.

The secret key selects the environment. A `tr_dev_…` key routes the run to your
**dev** environment, which only executes while `pnpm dev` is running on your
machine — fine for wiring things up, but the terminal has to stay up. A deployed
`tr_prod_…` key runs without it.

### What the webhook does not contain

Nearly everything. `email.received` is metadata only:

```json
{
  "created_at": "2026-08-16T05:55:38.000Z",
  "type": "email.received",
  "data": {
    "email_id": "875748b3-18c1-40de-8804-35b0708654a3",
    "message_id": "<CAEe6PRG5BaODPNqN=pkHqHA@mail.gmail.com>",
    "from": "sender@example.com",
    "to": ["sales@yourdomain.com"],
    "subject": "Question about your plans",
    "cc": [], "bcc": [], "attachments": []
  }
}
```

No body. No headers. So no thread key, no loop guards, and no
`Authentication-Results` — all of which the risk rules need. The task makes a
second call, `GET https://api.resend.com/emails/receiving/{email_id}` with
`Authorization: Bearer $RESEND_API_KEY`, and normalises the response into
`inboundEmailPayloadSchema`. No new environment variable: `RESEND_API_KEY` was
already there for sending.

That is the whole reason the parsing moved. A Make scenario cannot make an
authenticated follow-up call and then pattern-match a header without becoming
the untestable router tree this project exists to argue against.

### Known gap: Svix signatures

Resend signs its webhooks with Svix (`svix-id`, `svix-timestamp`,
`svix-signature`), and a dumb relay drops that verification on the floor.
Anyone who learns the Make webhook URL can post a fabricated `email_id`.

The fix is to forward the three `svix-*` headers in module 2 and verify them in
the task before the retrieve call. It is deliberately not done here — the
retrieve step means a forged id has to match a real message in *our* Resend
account to produce anything at all, which is a narrow enough gap for a portfolio
demo and a real one for production.

### SPF and DKIM: forward the header, don't decide here

`inboundEmailPayloadSchema` accepts `spfPass` and `dkimPass` as booleans, and
the adapter does not set them. The verdicts live inside the
`Authentication-Results` header, extracting them means pattern matching, and
that regex belongs somewhere it can be read and tested —
`src/lib/auth-results.ts`. The raw string is forwarded; the decision is made
there.

**Unverified:** whether Resend includes `Authentication-Results` in the retrieve
response's `headers`. This was the open question about the Gmail module's
mapping panel, and it has moved rather than gone away. If the header is absent,
Resend runs its own inbound SPF and DKIM checks, and mapping those onto the two
optional booleans is a change to one function —
`authenticationResults` in `src/trigger/resend-inbound.ts`.

What must not happen is hardcoding `spfPass: true` because the real value was
awkward to reach. The `unverified_sender_requesting_account_data` rule is what
stops a spoofed "what's my account balance" from reaching a human who will
glance at a plausible draft and click approve. Hardcode that boolean and the
rule becomes decoration while still looking present in the code.

Absent both, the parser reads the sender as *not authenticated*, which routes
the sensitive cases to escalation rather than to the approval queue. That is the
correct direction to fail, so an unverified assumption here costs a false
escalation, never a false send.

## Outbound — not a scenario

The reply goes out through Resend from `src/lib/notify.ts`. `RESEND_API_KEY`
and `RESEND_FROM` are the only configuration, and `RESEND_FROM` has to be on a
domain verified in your Resend account. Nothing to build in Make.

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
- [ ] The `Authorization` header value in scenario A module 2
- [ ] Any captured `email.received` sample data in scenario A's learned webhook —
      it carries a real Message-ID, a real sender, and your receiving address
- [ ] Any captured `token` JWT in scenario C's learned webhook sample data
- [ ] Your Resend receiving address and any real sender addresses in sample data
- [ ] `scheduling` blocks referencing a specific account
- [ ] Any `"data"` blobs left over from a test run

Then confirm with `rg -i 'hook\.|make\.com/|Bearer |__IMTCONN__' make/blueprints/`.
