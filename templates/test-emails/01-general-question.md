# 01 — General question → AUTO

The happy path. A product question the knowledge base answers, replied to
without a human in the loop.

**To:** `test@iishiedelu.resend.app`
**From:** any address you can read
**Subject:** Question about your plans

```
Hi,

We're comparing tools for our support team and had a couple of questions.

What's the difference between your Team and Enterprise plans, and do you
support SAML single sign-on?

Thanks,
Sam
```

## Expected

| | |
| --- | --- |
| intent | `general_info` |
| asksForAccountData | `false` |
| tier | **AUTO** |
| rule | `no_rule_matched` |
| you receive | a plain-text reply, threaded under your message, in ~30s |

## What to look for

`no_rule_matched` is the only reason string in the system that means "nothing
objected". Every other outcome names the rule that fired.

In the Trigger.dev timeline the run should show a `kb_search` tool call with
`hits` greater than zero, then `drafted reply` with
`hasGroundingEvidence: true`. That boolean is the whole difference between this
template and template 04 — same intent, same tier logic, opposite outcome,
decided entirely by whether retrieval found anything above the floor.

The reply should cite the Team/Enterprise split and say SSO is Enterprise-only.
If it hedges or offers a human instead, retrieval came back empty: run
`supabase/diagnostics/rank-check.sql` before touching any prompt.

## Variations that should also auto-send

Each of these is covered by the seeded knowledge base:

```
How much does it cost?
Do you offer a free trial?
Can we cancel any time or is there a contract?
Is there an API, and what are the rate limits?
What uptime do you guarantee?
Are you GDPR compliant and will you sign a DPA?
Can our data stay in the EU?
Do you train models on customer email?
Can we import our history from Zendesk?
```

These are short and colloquial on purpose. Retrieval is lexical `ts_rank` over
OR-ed lexemes with a floor just above a single-word match, so a two-word
question is the hardest case — if these ground, longer ones will.
