# Handoff note

Send this ahead of the repo link. Replace the bracketed bits and delete this
heading.

---

**Subject:** Mailroom — AI email agent, live for the next few days

Hi [name],

The repo is at [link]. It is a working AI email agent for a shared sales
inbox, and it is currently live if you want to send it something rather than
read about it.

**Write to `test@iishiedelu.resend.app` from any address.** It replies to the
address you send from, usually within about thirty seconds.

Before you do, one thing worth knowing, because otherwise half of what it does
looks like a bug:

> **It deliberately does not answer everything.** Deciding when *not* to reply
> is most of the work in an autonomous email agent, so some messages get an
> answer, some get drafted and held for a human, some get a short "a colleague
> is picking this up", and one kind gets nothing at all. Not answering is an
> outcome, not a failure.

Four things worth trying:

| Send it | What happens | Why |
| --- | --- | --- |
| A product question — pricing, SSO, uptime, GDPR | Replies automatically | It found a grounded answer in the knowledge base |
| "Can we run this on-premise?" | **No answer.** A draft is held for human approval | The knowledge base genuinely does not cover it, so an answer would be invented. It gets a human's eyes before it goes anywhere |
| "What's my current invoice?" | **No answer** — but you get a short note saying a colleague has it | You are not a recognised, authenticated contact. Account data never goes out on a spoofable sender, and it does not even reach the approval queue: a human shown a plausible draft clicks yes. Note what the acknowledgment does *not* say — it never explains that verification failed, because that tells a spoofer what to forge next |
| A cold sales pitch | **Nothing at all.** Logged and dropped | Auto-replying confirms a live, monitored address and gets you on more lists. This is the one case that gets no acknowledgment either — replying to an auto-responder means it replies to us, and two auto-responders discovering each other is an unbounded loop |

The middle two are the interesting ones. In both cases the system has a
plausible reply available and declines to send it.

**The architecture, in three sentences.** Make.com holds five modules across
two scenarios and makes zero decisions — it exists only because Trigger.dev has
no incoming-webhook trigger and because a Slack link is a GET while completing
a waitpoint is a POST. Everything with branching, retries or state is typed
TypeScript in Trigger.dev tasks, validated with zod at every boundary. The
safety-critical part — which messages get answered, drafted or dropped — is one
pure function in `src/lib/risk-tier.ts` and the only module with real test
coverage, because it is the only place where a bug sends the wrong thing to a
real person.

The README is honest about what is real and what is mocked; there is a table
near the top. Short version: inbound-to-reply, classification, retrieval,
sending, the approval gate and the idempotency guards are real. CRM is a
Supabase table rather than HubSpot, and meeting scheduling returns a static
booking link.

Happy to walk through any of it.

[your name]

---

## Notes for you, not for the CTO

- **Check the agent is actually live before sending this.** A deployed
  Trigger.dev version has to exist and Make scenario A has to hold a
  `tr_prod_…` key. If it still holds a `tr_dev_…` key, nothing runs unless
  `pnpm dev` is open on your machine — and a run parked on the approval
  waitpoint cannot resume once that terminal closes. `docs/deploy-checklist.md`
  covers the switch.
- **Watch Slack while they test.** Rows two and three above both produce a
  notification, and row two needs you to click approve for the reply to arrive.
  If you want it to complete without you, say so in the note.
- The approval link is a plain hyperlink and anything that follows links will
  click it. Slack unfurling is already disabled in `notifySlack`; a URL scanner
  in front of a mailbox still could. See `make/README.md`.
