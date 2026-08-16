# 04 — Out-of-scope question → APPROVE

**This is the approval demo.** It needs no database setup and no verified
sender, so it is the one to use on a call or in the Loom.

**To:** `test@iishiedelu.resend.app`
**Subject:** Deployment options

```
Hi,

Our security team won't approve anything multi-tenant. Can we run Mailroom
on-premise in our own datacenter, and what does that involve?

Thanks,
Sam
```

## Expected

| | |
| --- | --- |
| intent | `general_info` |
| asksForAccountData | `false` |
| hasGroundingEvidence | `false` |
| tier | **APPROVE** |
| rule | `ungrounded_answer` |
| you receive | **nothing** until a human clicks approve |
| Slack receives | an approval card with the draft, approve and reject links |

Click **Approve and send** and the reply arrives. Click **Reject** and it never
does, and Slack says so.

## Why this one is reliable

On-premise and self-hosted deployment are held out of the seeded knowledge base
on purpose, and `supabase/seed.sql` says so at the top. Nothing above the
relevance floor means `hasGroundingEvidence` goes false, and a `general_info`
question with no grounding is either an admission of ignorance or an
invention — both worth one human glance.

HIPAA and BAA are held out the same way, so this also works:

```
Are you HIPAA compliant, and will you sign a BAA?
```

**Do not add chunks covering either subject**, even to say no. That would
ground the answer and this template stops demonstrating anything.

## What the draft should say

It should decline cleanly — no on-premise option that it knows of, and an offer
to put the sender in touch with a person. It must **not** invent a deployment
model, a price for one, or a timeline.

If the draft confidently describes an on-premise offering, that is the single
worst failure mode in this system and it means the grounding contract is not
holding. Check the `kb_search` result in the timeline: `hits` should be `0`. If
it is not, a chunk is partially matching and
`supabase/diagnostics/rank-check.sql` will show which.

## Note if you tested before the knowledge base was widened

Ordinary product questions used to land here too — the knowledge base was eight
chunks and a question like "how much does it cost" found nothing above the
floor, so it was held for approval under this same rule. That was the floor
working correctly on a corpus that was too thin, not a policy about pricing
questions. Those now auto-send (template 01), and `ungrounded_answer` fires
only for subjects genuinely outside the knowledge base — which is what it was
always meant to mean.
