# Templates

Two audiences.

- **`cto-handoff.md`** — the note you send ahead of the link. Written so a
  reviewer knows what to send, what to expect back, and — the part that matters
  most — which of the outcomes are *silence on purpose*.
- **`test-emails/`** — five copy-paste messages, one per path through
  `risk-tier.ts`. Each states the rule it should trigger and how to verify it
  actually did.

## The one live value in here

Every template writes to:

```
test@iishiedelu.resend.app
```

That is the Resend receiving address wired to Make scenario A. It is the only
environment-specific string in this folder — change it here and in
`cto-handoff.md` if the address moves. Everything else is portable.

## Read this before handing the folder to anyone

**Not every template produces an answer, and one produces no email at all.**

| | reply | acknowledgment | who is handling it |
| --- | --- | --- | --- |
| AUTO (01) | yes | — | nobody, it's answered |
| APPROVE (04) | after a human clicks | — | a human, before sending |
| ESCALATE (02A, 05) | no | **yes** | a human, after |
| BLOCK (03) | no | no | nobody |

ESCALATE sends the sender a short fixed acknowledgment — a colleague has it,
they'll reply directly — because leaving a real person in silence is the worst
experience the system produces. The copy is a constant in `src/lib/notify.ts`,
not a generated draft, so no model runs on an escalated message and there is
nothing in it that can invent an account fact.

BLOCK stays completely silent, and that is not an oversight. Acknowledging an
automated sender means our acknowledgment trips their auto-reply, which trips
ours — the unbounded loop the whole design exists to prevent — and
acknowledging abuse confirms a monitored human reads the inbox. A reviewer who
does not know this reads template 03 as a broken agent, which is the opposite
of the argument the project is making. `cto-handoff.md` leads with it.

**The approval demo moved.** Before the knowledge base was widened, ordinary
product questions found nothing above the relevance floor and were held for
approval under `ungrounded_answer` — which is why a random question produced a
Slack card. Those questions are now answered and auto-send, which is the
correct behaviour and means `ungrounded_answer` no longer fires on them. The
dependable approval demo is now template **04**, which asks about a subject
deliberately held out of the knowledge base (on-premise deployment). Template
**02** also reaches approval, but only after you add your own address to
`contacts` — see that file.

**Message-ID is the idempotency key.** Sending the identical message twice from
the same client can produce the same Message-ID and the second one is dropped
before the task starts. That is a feature and it is worth showing once, but if
you are trying to re-run a scenario, change the subject line.

## Verifying any of them

Three places, in increasing order of detail:

1. **Slack** — approval cards and escalation notices land there.
2. **Trigger.dev run timeline** — `cloud.trigger.dev`, the `inbound-email` run.
   The `risk decision` log line carries `tier` and `reason`, and `reason` is the
   rule id from `src/lib/risk-tier.ts` verbatim.
3. **Supabase** — every decision is persisted:

   ```sql
   select created_at, subject, risk_tier, risk_reason,
          classification->>'intent'             as intent,
          classification->>'confidence'         as confidence,
          classification->>'asksForAccountData' as asks_account_data,
          classification->>'needsHuman'         as needs_human
   from messages
   where direction = 'inbound'
   order by created_at desc
   limit 20;
   ```

If a template produces the wrong tier, that query tells you which of the four
classifier fields was responsible before you touch any prompt.

## Driving the same paths without email

`pnpm sample` triggers the task directly from a JSON fixture, with Resend and
Make both out of the loop:

```bash
pnpm sample --fixture general-question   # AUTO
pnpm sample --fixture account-question   # APPROVE / ESCALATE
pnpm sample --fixture spam               # BLOCK
pnpm sample --fixture spam --fresh       # new Message-ID, replays idempotency
```

The fixtures in `scripts/fixtures/` set `spfPass` and `dkimPass` directly,
which real mail cannot do — so they are the way to exercise the authenticated
sender branch without owning a verified domain.
