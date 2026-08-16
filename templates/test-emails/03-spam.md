# 03 — Spam → BLOCK

The cheapest path in the system and the one that best shows the design
argument: the correct response to some email is nothing at all.

**To:** `test@iishiedelu.resend.app`
**Subject:** Boost your rankings — guaranteed first page

```
Hi there,

I came across your website and noticed you're not ranking for several
high-intent keywords your competitors dominate.

We've helped 400+ SaaS companies reach page one in under 90 days, and I'd
love to show you a free audit of what's holding you back. We also offer
backlink packages starting at $299/mo.

Are you free for 15 minutes this week?

Best,
Alex
Growth Partners International
```

## Expected

| | |
| --- | --- |
| intent | `spam` |
| tier | **BLOCK** |
| rule | `spam` |
| you receive | **nothing, ever** |
| Slack receives | nothing |

## What to look for

The run is logged and terminated in the pre-agent gate. `blocked, no reply
sent` appears in the timeline; there is no `drafted reply` line, no tool call,
and **no model call for the reply agent** — only the one classification call.
Compare the run duration against template 01 and the difference is the whole
point of splitting the rule list in two.

The thread is marked `closed` rather than `open`, so a follow-up from the same
sender starts from a closed thread rather than accumulating turns.

Verify silence rather than assuming it:

```sql
select m.direction, m.risk_tier, m.risk_reason, t.status
from messages m join threads t on t.id = m.thread_id
where t.thread_key = (
  select thread_key from threads order by last_message_at desc limit 1
)
order by m.created_at;
```

One `inbound` row with `BLOCK` / `spam`, thread status `closed`, and **no
`outbound` row**. The absence of that second row is the assertion.

## Why not a polite decline

The original brief said "always respond". An auto-reply to spam confirms a
live, human-monitored address to a sender who mass-mails, and gets you added to
more lists. This is the one deliberate departure from the brief and it is
documented as such in the README.

## Related: automated senders

A different rule, `automated_sender`, also produces BLOCK — for out-of-office
replies, bounce notifications and mailing list traffic, detected from
`Auto-Submitted`, `Precedence`, `List-Unsubscribe` and `List-Id` headers, and
from self-addressed mail. Two auto-responders discovering each other is an
unbounded loop, and it is the failure mode that generates a five-figure sending
bill overnight.

You cannot easily trigger this one by hand — most clients will not let you set
those headers. Use the fixture instead:

```bash
pnpm sample --fixture spam --fresh
```

then edit `scripts/fixtures/spam.json` to add `"headers": {"precedence":
"bulk"}` and run it again. The rule id changes from `spam` to
`automated_sender` and the tier stays BLOCK.
