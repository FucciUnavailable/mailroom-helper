# 02 — Account question → ESCALATE, or APPROVE with setup

This template has **two** outcomes and which one you get depends on whether the
system recognises you. Both are correct. Know which one you are demonstrating
before you send it.

**To:** `test@iishiedelu.resend.app`
**Subject:** Invoice question

```
Hi,

Can you tell me what we're currently paying and when our contract renews?
I can't find the invoice.

Thanks,
Sam
```

## Outcome A — you are not a known contact (the default)

| | |
| --- | --- |
| intent | `account_question` |
| asksForAccountData | `true` |
| senderAuthenticated | `false` unless SPF **and** DKIM both pass |
| contactResolved | `false` |
| tier | **ESCALATE** |
| rule | `unverified_sender_requesting_account_data` |
| you receive | a short acknowledgment — a colleague has it — and **no answer** |
| Slack receives | a red escalation notice, no draft, and a line saying the sender was acknowledged |

This fires in the pre-agent gate, so no model call and no tool call happen at
all — the run is fast and the timeline is short. The acknowledgment is a
constant in `src/lib/notify.ts`, not a generated draft, which is why sending it
on a path where the model never ran is safe.

Read what the acknowledgment does not say. It gives no reason. "We could not
verify your identity" would tell a spoofer exactly what to forge next, and this
is the rule that fires on precisely that attack. It also promises no timeframe.

You get it **once per thread.** Reply to your own message and the second one
escalates silently — `threads.status` is already `escalated`, so the guard in
`finishWithoutReply` suppresses the repeat. Worth demonstrating; it is the
difference between a courtesy and a way to make the system mail someone
repeatedly.

The reason there is no draft is worth saying out loud when demoing: a human
shown a plausible, well-written draft approves it. So a sender who could be
spoofed never reaches the approval queue in the first place. Routing this to
approval instead of escalation would look more capable and be strictly less
safe.

## Outcome B — you are a known, authenticated contact

Requires **both** of:

1. Your address exists in `contacts`.
2. SPF and DKIM both pass on your message, parsed out of the
   `Authentication-Results` header by `src/lib/auth-results.ts`. Mail from
   Gmail, Outlook or any reputable provider normally passes both. If the header
   is absent from Resend's retrieve response, this reads as unauthenticated by
   design and you stay on outcome A.

To add yourself, in the Supabase SQL Editor:

```sql
-- Local only. Do not commit this, and do not add it to seed.sql — the repo
-- keeps contacts synthetic on the RFC 2606 reserved .test / .invalid TLDs so a
-- misconfigured demo cannot email a real person.
insert into public.contacts (email, full_name, company, lifecycle_stage, notes)
values ('you@yourdomain.com', 'Your Name', 'Your Co', 'customer',
        'Pro plan since 2024. Added manually for live testing.')
on conflict (email) do nothing;
```

Then resend:

| | |
| --- | --- |
| tier | **APPROVE** |
| rule | `account_data_disclosure` |
| Slack receives | an approval card with the draft, plus approve and reject links |
| you receive | the reply, **after** you click approve |

The agent will have called `crm_lookup` and found you, so the draft reflects
the `notes` field on your contact row. That is the mocked CRM doing its job —
swap `src/tools/crm.ts` for HubSpot and nothing else changes.

## Verifying which one you got

```sql
select subject, risk_tier, risk_reason
from messages
where direction = 'inbound'
order by created_at desc limit 5;
```

`unverified_sender_requesting_account_data` is outcome A,
`account_data_disclosure` is outcome B. If you see `no_rule_matched`, the
classifier read this as a general pricing question rather than an account one —
check `classification->>'asksForAccountData'` and make the message more clearly
about an account you already hold.
