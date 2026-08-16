# 05 — Explicit escalation → ESCALATE

Covers the rule that fires on subject matter rather than on sender identity:
some things belong to a person no matter who is asking or how clearly they
asked.

**To:** `test@iishiedelu.resend.app`
**Subject:** Cancelling our contract

```
Hi,

We've been unhappy with the service for a couple of months now and my board
wants us out of the contract. Before I hand this to our legal team I want to
know what our options are on early termination and whether we're getting
anything back for the remainder of the term.

Sam
```

## Expected

| | |
| --- | --- |
| intent | `account_question` or `other` |
| needsHuman | `true` |
| tier | **ESCALATE** |
| rule | `model_requested_human` — or `unverified_sender_requesting_account_data` if it fires first |
| you receive | a short acknowledgment — a colleague has it — and **no answer** |
| Slack receives | a red escalation notice, no draft, and a line saying the sender was acknowledged |

Both rules are ESCALATE and both are in the pre-agent gate, so the outcome is
the same either way — but the reason string differs and precedence decides.
`unverified_sender_requesting_account_data` sits **above**
`model_requested_human` in `PRE_AGENT_RULES`, so if the classifier also set
`asksForAccountData: true` and you are not a known contact, that is the reason
you will see.

To isolate `model_requested_human` specifically, either add yourself to
`contacts` (see template 02) or send something that needs a human without
touching account data:

```
Subject: Security questionnaire

Hi — our procurement team needs your SOC 2 report and a completed CAIQ
questionnaire before we can sign. Who should I send the forms to?
```

## What to look for

`escalated`, not `blocked`. The distinction is the whole reason both tiers
exist:

| | BLOCK | ESCALATE |
| --- | --- | --- |
| AI reply sent | no | no |
| sender acknowledged | **no** | **yes**, once per thread |
| Slack notified | no | yes |
| thread status | `closed` | `escalated` |
| meaning | there is nothing here worth a person's time | a person needs to handle this |

The acknowledgment row is the one to explain out loud. ESCALATE means a human
genuinely is picking the thread up, so telling the sender costs nothing and
saves them wondering. BLOCK means nobody is, and acknowledging there would be
actively harmful — an automated sender would auto-reply to our acknowledgment,
we would classify that reply, and if BLOCK acknowledged we would answer it
again. `acknowledge` is a property of each individual rule in
`src/lib/risk-tier.ts` rather than of the tier, and the test suite pins that no
BLOCK rule ever carries it.

No draft is written in either case. That is deliberate and it is the same
argument as template 02: a human shown a plausible draft approves it, so on the
paths where the model should not be trusted to answer, it is not asked to write
anything at all. The Slack notice carries the sender, subject, intent and rule
id — enough to pick the thread up — and no suggested wording to anchor on.

```sql
select m.risk_tier, m.risk_reason, t.status
from messages m join threads t on t.id = m.thread_id
where m.direction = 'inbound'
order by m.created_at desc limit 3;
```

`ESCALATE` with thread status `escalated`, and no outbound row.

## The other three escalation rules

Not worth a template each, but they exist and they are all pre-agent:

| rule | fires when | acknowledges |
| --- | --- | --- |
| `reply_cap_exceeded` | 5 replies already sent on this thread in 24h | **no** |
| `agent_turn_limit` | 3 agent turns already taken on this thread | yes |
| `unverified_sender_requesting_account_data` | template 02, outcome A | yes |

The first two are rate limits on the agent rather than judgements about the
message, and both are reachable by replying to your own thread repeatedly if
you want to see them. Watch `threads.turn_count` climb as you do.

`reply_cap_exceeded` is the one ESCALATE rule that stays silent, and the reason
is worth a sentence in a walkthrough: the rule exists because we have already
sent this thread five emails today and must stop. An acknowledgment would be
the sixth. Everywhere else the acknowledgment is a courtesy; there it would be
the exact send the rule was written to prevent.
