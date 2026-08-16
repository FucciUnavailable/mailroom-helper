# Deploy checklist

Getting from "works while `pnpm dev` is open" to "answers mail for the next few
days without my laptop". Work top to bottom; each step says how to tell it
worked.

The distinction that matters: a `tr_dev_…` secret key routes runs to your **dev**
environment, which only executes while `pnpm dev` is running. A deployed
`tr_prod_…` key runs without you. The approval branch parks on
`wait.forToken({ timeout: "1d" })`, and **a parked dev run cannot resume once
the terminal is gone** — so leaving it on dev is not a smaller version of
deploying, it is a version that loses approvals.

---

## 0. Two things that will waste your afternoon if they are wrong

**`RESEND_FROM` must be on a domain you have verified in Resend.** If it is
still `onboarding@resend.dev`, Resend delivers **only to the address on your own
Resend account** and silently drops everything else. Your own end-to-end test
would have passed exactly as it did, and every reply to the CTO would vanish
with no error anywhere — the send returns 200, `reply sent` appears in the run
timeline, and nothing arrives.

```bash
grep RESEND_FROM .env
```

If that is not an address on a domain showing **Verified** in the Resend
dashboard, fix it before anything else. This is the single most likely way the
handoff fails.

**Confirm `test@iishiedelu.resend.app` is a receiving address you control** and
that its webhook is subscribed to **`email.received` only**. With outbound
events also subscribed, every reply the agent sends re-enters as a new inbound
message. The header loop guards will not catch it, because our own send is not
marked automated.

---

## 1. Offline checks

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Green. This says nothing about whether Supabase, Anthropic, Resend, Slack or
Make are wired up — none are touched without credentials.

---

## 2. Re-seed the knowledge base

`supabase/seed.sql` gained nine chunks covering pricing in customer vocabulary,
free trials, cancellation and refunds, the API, uptime, GDPR, limits, migration
and an actual product overview. Without this step the agent still cannot answer
"how much does it cost" and still routes it to approval.

Run **`supabase/seed.sql`** in the Supabase SQL Editor. The knowledge base
section now begins with `delete from public.kb_chunks;` and rewrites itself, so
re-running it is safe and does not duplicate. `0001_init.sql` is unchanged and
does not need re-running.

Verify:

```sql
select source, count(*) from kb_chunks group by source order by source;
```

Expect **19 chunks across 12 sources**: `pricing.md` 4; `onboarding.md`,
`overview.md`, `security.md`, `support.md` 2 each; `api.md`, `billing.md`,
`data-retention.md`, `integrations.md`, `limits.md`, `privacy.md`,
`reliability.md` 1 each. A total of 27 means the delete did not run and the
original eight are duplicated alongside the new set.

---

## 3. Measure the grounding floor

```
supabase/diagnostics/rank-check.sql
```

Paste the whole file into the SQL Editor. Read-only, safe to re-run.

**Query 1** lists every probe with its best rank and an `ok` / `>>> WRONG`
verdict at the current floor of `0.08`. **Query 2** prints the range of floors
that separates answerable questions from the held-out subjects, and a
`suggested_rank_floor`.

- All `ok` → leave `RANK_FLOOR` at `0.08` and move on.
- Some `>>> WRONG`, status `separable` → set `RANK_FLOOR` in
  `src/tools/kb-search.ts` to `suggested_rank_floor`, and the `match_threshold`
  default in `supabase/migrations/0001_init.sql` to match. The tool passes the
  value explicitly, so the constant is what actually governs.
- Status `OVERLAP` → do not move the floor. A held-out subject is being
  partially matched, or a grounded question has no chunk in its words. Query 1
  shows which probe and which source.

This is the number the README has been calling unverified since the project
started. Settling it here means you can say it was measured.

---

## 4. Set the production environment variables

Deployed runs do **not** read `.env`. `src/env.ts` parses at import time, so a
missing variable fails the task at boot on the first message — by design, but
it fails in front of whoever is testing.

Trigger.dev dashboard → your project → **Environment Variables** → **Production**.
All seven, from `.env.example`:

| Variable | Notes |
| --- | --- |
| `SUPABASE_URL` | |
| `SUPABASE_SERVICE_ROLE_KEY` | service role, not anon — RLS is on with no policies |
| `ANTHROPIC_API_KEY` | the only metered API in the stack |
| `RESEND_API_KEY` | both directions: outbound send and the inbound retrieve |
| `RESEND_FROM` | step 0 |
| `APPROVAL_RELAY_BASE_URL` | Make scenario C's webhook URL |
| `SLACK_WEBHOOK_URL` | |

`TRIGGER_SECRET_KEY` and `TRIGGER_PROJECT_REF` are **not** in this list. They
are read by the CLI and by `scripts/send-sample.ts`, never by a task —
`src/env.ts` does not include them.

---

## 5. Build, then deploy

Dry run first. It builds everything and deploys nothing:

```bash
pnpm dlx trigger.dev@latest deploy --dry-run
```

**If it fails on `TRIGGER_PROJECT_REF is not set`:** `trigger.config.ts` reads
that variable at config-eval time and `.env` is absent on Trigger.dev's build
machines. The catch around `process.loadEnvFile()` handles a missing file but
not a missing variable. Either add `TRIGGER_PROJECT_REF` to the production
environment variables from step 4, or pass it explicitly:

```bash
pnpm dlx trigger.dev@latest deploy --project-ref proj_yourref
```

Then the real thing:

```bash
pnpm deploy
```

Verify: the dashboard shows a new deployment for **Production**, promoted as
current, listing both `inbound-email` and `resend-inbound`.

---

## 6. Repoint Make at production

1. Trigger.dev dashboard → **API Keys** → copy the **prod** secret key
   (`tr_prod_…`).
2. Make **scenario A**, module 2 (HTTP), `Authorization` header → replace
   `Bearer tr_dev_…` with `Bearer tr_prod_…`.
3. Both scenarios **ON**, scheduling set to **immediately as data arrives**.
   Scenario C in particular must respond immediately or the approver's browser
   hangs.

Scenario C needs no key — the waitpoint callback URL carries its own secret in
the path — so it does not change between environments.

---

## 7. Verify with real mail

Send template **01** from `templates/test-emails/`. You should get a reply in
about thirty seconds with **`pnpm dev` not running**. That last part is the
whole point of this document.

Then template **04** for the approval path: Slack card → click approve → reply
arrives.

> **Do not verify with `pnpm sample` pointed at prod.** It would work, but it
> spends Anthropic credit on every run and it bypasses Make and Resend
> entirely — which is exactly the half you are trying to prove. Use real mail.

### Three things the first production message settles

The repo has been carrying these as reasoned-about rather than measured. Check
them once, then update the README and `CLAUDE.md`, because "we measured it" is
worth more to a reviewer than a careful hedge.

1. **Does Resend return `Authentication-Results`?** In the `resend-inbound` run
   timeline, the `handed off to inbound-email` log line carries
   `hasAuthenticationResults`. If `false`, Resend runs its own inbound SPF/DKIM
   checks and mapping them onto the payload's `spfPass`/`dkimPass` booleans is a
   change to `authenticationResults()` in `src/trigger/resend-inbound.ts` and
   nowhere else. Until then every account-data request escalates rather than
   drafting — safe, but it means template 02 outcome B is unreachable.
2. **Which shape does `headers` use?** Array of `{name, value}`, or a map.
   `resendReceivedEmailSchema` accepts both, so nothing breaks either way, but
   only one is real. The retrieve response is in the run's payload view.
3. **The grounding floor**, if you have not already run step 3.

---

## 8. Leaving it up for a few days

- **Approvals expire after 24 hours.** `wait.createToken({ timeout: "1d" })`.
  An unclicked card times out, Slack says so, and the thread goes to
  `escalated`. If the CTO tests overnight and approves the next morning, that
  is the behaviour they will see. Raising it is a one-word change in
  `waitForApproval`.
- **Thread limits accumulate.** Five replies on one thread in 24h trips
  `reply_cap_exceeded`; three agent turns trips `agent_turn_limit`. Both are
  ESCALATE. If you have been hammering one subject line while testing, start a
  new thread before handing it over, or clear it:

  ```sql
  -- Local testing only.
  delete from threads where thread_key like 'demo-%';
  ```
- **Idempotency is permanent.** `messages.message_id` is unique with no expiry,
  so a message that was already processed is dropped forever. Vary the subject
  line rather than resending the identical message.
- **Anthropic is the only thing that costs money**, and the model is pinned to
  `claude-haiku-4-5` in `src/agent/model.ts`. Spam and escalations short-circuit
  before any model call, so the floor on cost is one classification call per
  message. A few days of testing is cents.
- **Make free tier operations.** Each inbound message is one scenario A
  execution; each approval click is one scenario C execution. Worth a glance at
  the operations counter if the CTO tests heavily.

---

## Rollback

Deployments are versioned. Dashboard → **Deployments** → pick the previous
version → promote it. To fall back to dev entirely, put the `tr_dev_…` key back
in scenario A module 2 and run `pnpm dev`.
