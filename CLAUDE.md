# CLAUDE.md

Project context for Claude Code. Read this fully before planning.

## What this is

An AI email agent ("digital employee") that receives inbound email to a shared
sales inbox, decides what kind of message it is, and either replies
automatically, routes a draft to a human for approval, or deliberately does
nothing.

This is a portfolio build with a hard deadline. It is sent to a CTO for
evaluation, not deployed to production. Optimize for **legibility and
demonstrated judgment**, not completeness.

## Current state (as of 2026-08-16)

The TypeScript side is green: `pnpm typecheck`, `pnpm lint`, and `pnpm test`
(60 cases) all pass.

**It has now run end to end against live mail**, in the Trigger.dev **dev**
environment with `pnpm dev` open. A real email to the Resend receiving address
produced an auto-sent reply on one message, and on another produced a Slack
approval card that, once approved, sent the reply. So the full chain — Resend
inbound → Make scenario A → `resend-inbound` → `inbound-email` → classify →
agent loop → risk tier → Resend outbound, plus the waitpoint and Make scenario
C — is verified working, not just compiling. Make scenario A exists as a
result, but has **not** been exported and scrubbed into `make/blueprints/`,
which still holds scenario C only.

What that run has **not** established: nothing has been deployed. Production
runs, a `tr_prod_…` key in Make, and the prod environment variables are all
still to do — see `docs/deploy-checklist.md`.

What that run **did** establish, and which changed the code: live questions were
held for approval under `ungrounded_answer`. The cause was retrieval, not
policy, and it took two passes to find. The first pass blamed the corpus — an
eight-chunk knowledge base written in spec vocabulary — and rewrote the seed to
nineteen chunks in customer vocabulary. That was worth doing but was not the
bug. The bug was `RANK_FLOOR = 0.08`, set from the assumption that `ts_rank`
rises with the number of distinct query lexemes a chunk matches. **It does
not.** `ts_rank` tracks term frequency, and an OR-ed query is diluted by the
terms that miss, so a longer and more specific question scores *lower*. Measured
against the seed: "SSO" alone scores 0.0608 and "SAML single sign-on" against
the one chunk containing all three words scores the same 0.0608. At 0.08, zero
of twenty-one grounded probes cleared the floor — every product question in the
system was being routed to a human.

The floor is now **0.035**, measured rather than argued: above the highest
held-out probe (HIPAA at 0.0304, which hits the DPA chunk on "sign" +
"compliant") and below the grounded probes that must pass. The working band is
0.031–0.038; outside it, re-run `supabase/diagnostics/rank-check.sql`, which
holds the labelled probe set including the verbatim live email that failed. It
is not a perfect separator — eight grounded probes still sit under the floor and
get held for approval. That is a corpus gap and the safe direction to fail; do
not lower the floor to close it.

**On-premise/self-hosted deployment and HIPAA/BAA are held out of the seed
deliberately** — they are the only live demonstration of `ungrounded_answer`,
and adding chunks that mention them, even to say no, destroys it. The lower
bound of the floor's working band exists to protect the same thing.

Two things remain reasoned about rather than measured, both in Resend's
`GET /emails/receiving/{id}` response:

- Whether it includes `Authentication-Results` in `headers`. The
  `handed off to inbound-email` log line carries `hasAuthenticationResults`, so
  the next production run settles it by inspection. If it does not, Resend runs
  its own inbound SPF/DKIM checks and those map onto the payload's optional
  `spfPass`/`dkimPass` booleans — a change to `authenticationResults` in
  `src/trigger/resend-inbound.ts` and nowhere else. Absent both, the parser
  reads the sender as unauthenticated, which is the correct direction to fail.
- Which shape that response's `headers` uses. `resendReceivedEmailSchema`
  accepts both an array of `{name, value}` and a map, so either works, but only
  one is real.

## Handoff material

`templates/` is reviewer-facing: a CTO handoff note plus five copy-paste test
emails, one per path through `risk-tier.ts`. Keep it accurate when risk rules
change — each template names the rule id it should trigger, so a rename that
skips these files leaves instructions that quietly stop matching reality.

Three of the five templates produce no email on purpose. That is the first
thing the handoff note says, because BLOCK and ESCALATE read as a broken agent
to anyone who has not been told.

`docs/deploy-checklist.md` is dev → production, in order, with verification at
each step.

## Commands

```bash
pnpm install
cp .env.example .env                   # fill in every value

# Schema: run supabase/migrations/0001_init.sql then supabase/seed.sql in the
# Supabase SQL Editor. The CLI is deliberately not a dependency — `db push`
# does not run seed.sql against a hosted project, so it would only be half the
# setup while looking like all of it.

pnpm dev                               # trigger.dev dev (tasks run on your machine)
pnpm deploy                            # trigger deploy — needed for a webhook-driven
                                       # demo; a dev run cannot survive the terminal

pnpm typecheck                         # tsc --noEmit
pnpm lint                              # eslint
pnpm test                              # vitest run

pnpm vitest run src/lib/risk-tier.test.ts   # the only suite
pnpm vitest run -t "blocks spam"            # a single test by name

# Drive the task with Make out of the loop — this is the demo path
pnpm sample --fixture spam
pnpm sample --fixture account-question
pnpm sample --fixture general-question
pnpm sample --fixture spam --fresh     # new Message-ID, replays past idempotency
```

`pnpm sample` is the only way to exercise the system end to end without a Make
account, and it is what the Loom records. Keep it working.

## Providers and cost

- **Anthropic** (`@ai-sdk/anthropic`) for classification and the reply loop.
  The only metered API in the stack. The model is named in exactly one place,
  `src/agent/model.ts` — swapping model or effort is a one-line change there
  and nowhere else.
- **Resend** for outbound send, called directly from `src/lib/notify.ts` with
  `fetch`. No SDK — it would be one wrapper around one POST. `RESEND_FROM` must
  be on a domain verified in the Resend account; the shared `onboarding@
  resend.dev` sender only delivers to the account owner's own address.
- **Retrieval is Postgres full-text search**, not pgvector. No embedding model,
  no cost, no cold-start download. See the RAG note below.
- **Trigger.dev's free credit covers compute, not model calls.** Runs parked on
  `wait.forToken` are suspended and burn none of it.

The pinned model is `claude-haiku-4-5` — the cheapest available — chosen to keep
the cost of iterating on the demo near zero. It is not the intended production
choice; Sonnet 5 is.

Thinking is left unconfigured on purpose. On Haiku 4.5 that means no thinking,
which is the intended trade at this price point. Note that Haiku 4.5 **rejects
`effort` with a 400** rather than ignoring it, so `CLASSIFY_OPTIONS` and
`REPLY_OPTIONS` are both empty today. Moving back up to Sonnet 5 or Opus 5 means
restoring `effort` and the model id together — one edit, one file.

## Environment variables

`.env.example` is the source of truth and lists every one with a placeholder.

| Variable | Used by |
| --- | --- |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | all table access; RLS is on with no policies, so the service role is the only way in |
| `ANTHROPIC_API_KEY` | classify + reply agent |
| `RESEND_API_KEY` | outbound send in `src/lib/notify.ts`, and the inbound retrieve in `src/trigger/resend-inbound.ts` — one key, both directions |
| `RESEND_FROM` | outbound send in `src/lib/notify.ts` |
| `APPROVAL_RELAY_BASE_URL` | Make scenario C, the GET→POST approval relay |
| `SLACK_WEBHOOK_URL` | approval requests and escalation notices |
| `TRIGGER_SECRET_KEY`, `TRIGGER_PROJECT_REF` | CLI, `trigger.config.ts`, `pnpm sample` |

`src/env.ts` parses these with zod at import time, so a missing value fails at
boot rather than halfway through handling a customer email.

## Hard constraints (do not negotiate these away)

1. **TypeScript only.** No Python, no shell scripts beyond trivial glue. The
   reviewing team migrated off n8n specifically to be TypeScript-native.
2. **Business logic lives in Trigger.dev tasks, not in Make.** Make is the I/O
   shell. If you find yourself adding a fifth module to a Make scenario, the
   logic belongs in a task instead.
3. **Zod at every boundary.** Webhook payloads, LLM structured output, and each
   agent tool's input and output. No `any`, no unvalidated `JSON.parse`.
4. **No secrets in the repo.** `.env.example` lists every variable with
   commented placeholder values and zero real ones. Make blueprint JSON exports
   must be scrubbed of connection IDs, webhook URLs, and header values before
   they are committed.
5. **Seed data must be obviously synthetic.** No real names, real email
   addresses, or scraped data in the contacts table.
6. **The agent never invents customer facts.** If a tool returns nothing, the
   reply says so and offers a human. Fabricating an account status is the single
   worst failure mode in this domain.

## Architecture

```
Make scenario A (inbound relay, 2 modules)
  Custom webhook (Resend email.received) -> HTTP POST to Trigger.dev -> done
  No parsing. Forwards emailId, messageId, receivedAt and nothing else.

Trigger.dev task: resend-inbound  (the ingestion adapter, TypeScript)
  idempotencyKey = Resend email_id, set by Make
  1. GET /emails/receiving/{emailId}  (the webhook is metadata only)
  2. normalise into inboundEmailPayloadSchema (src/lib/inbound-normalize.ts)
  3. inboundEmail.trigger(payload, { idempotencyKey: <Message-ID>, global })

Trigger.dev task: inbound-email  (all real logic, TypeScript)
  idempotencyKey = RFC 5322 Message-ID
  1. parse + validate payload (zod)
  2. resolve sender against contacts table
  3. classify (LLM, structured output, zod-validated)
  4. agent loop with tools (AI SDK)
  5. compute risk tier (pure function, src/lib/risk-tier.ts)
  6. BLOCK    -> log only, no email of any kind
     AUTO     -> send via Resend
     APPROVE  -> wait.forToken(), on approve send via Resend
     ESCALATE -> notify human, no AI reply; send the sender a fixed
                 acknowledgment if the rule opted in (once per thread)

Make scenario C (approval relay, ~3 modules)
  GET from a Slack link -> POST the token callback -> confirmation page
```

### Why the split

Make owns the HTTP plumbing that the rest of the stack cannot do for itself.
Trigger.dev owns anything with branching, retries, or state, because that is
where Make becomes unmaintainable. This split is the central argument of the
project and the README must lead with it.

Both scenarios now exist for the same narrow reason: **an HTTP shape mismatch
Trigger.dev cannot bridge.** Scenario A exists because Trigger.dev v4 has no
incoming-webhook trigger, so Resend's POST has to be converted into a task
trigger. Scenario C exists because a Slack hyperlink is a GET and completing a
waitpoint is a POST. Neither scenario parses anything. If either grows a third
module that makes a decision, the decision belongs in a task.

The split is per-connector, not per-direction. **Sending is not in Make** — it
is a direct Resend call in `src/lib/notify.ts`, because one authenticated POST
does not need a connector platform, and routing it through a webhook would add
a hop, an untyped payload, and a scenario to maintain. Do not reintroduce an
outbound scenario.

**Ingestion is not in Make either, beyond the relay.** The Resend webhook is
metadata only, so the body, headers, thread key and SPF/DKIM verdicts all come
from a second authenticated GET, and normalising that response is real logic:
`src/lib/inbound-normalize.ts` plus `src/trigger/resend-inbound.ts`. Do not move
any of it back into a mapping panel.

`inbound-email` must stay a pure function of a validated
`inboundEmailPayloadSchema`. That is what lets `pnpm sample` drive the whole
system from a fixture with no mail provider in the loop, and it is the demo
path. Ingestion changes go in `resend-inbound`, never in `inbound-email`.

### Why waitpoints for approval

`wait.createToken({ timeout: "1d" })` plus `wait.forToken()` pauses the run and
resumes it when the callback URL is hit. The alternative (write a `pending` row,
poll it on a cron) is more code, more failure modes, and no timeout semantics.
Approve and reject links in the notification point directly at the token
callback URL.

## Scope

### In scope, build for real

- Inbound to reply, end to end, actually working from a clean clone
- One genuine retrieval tool over a small seeded knowledge base in Supabase.
  **This is Postgres full-text search, not pgvector.** The vector path cost a
  ~90MB model download on every deployed cold start against a 120s ceiling,
  which is not a trade worth making for nineteen chunks. What was kept is the
  grounding floor: no rows above it means `hasGroundingEvidence: false` and the
  reply is gated rather than invented. `src/tools/kb-search.ts` is the whole
  seam — restoring pgvector is one function and no caller changes.
- Waitpoint approval branch with a working approve link
- Idempotency (Message-ID) and auto-responder loop guards
- Spam classified, logged, and **not replied to**

### Deliberately mocked, and stated as mocked in the README

- CRM is a Supabase `contacts` table, not HubSpot. Tool implementation is
  isolated in `src/tools/crm.ts` so swapping it is one file.
- Meeting scheduling returns a static booking link. No real calendar writes.

### Explicitly out of scope

- Lead enrichment (emit an `enrichment_queued` event and move on)
- Multi-tenant anything
- A frontend beyond the approval links

## Data model (Supabase)

- `contacts` - id, email (unique), full_name, company, lifecycle_stage, notes
- `threads` - id, thread_key, contact_id, status, turn_count, last_message_at
- `messages` - id, thread_id, message_id (unique), direction, subject, body,
  classification jsonb, risk_tier, created_at
- `kb_chunks` - id, source, content, content_tsv (generated tsvector, GIN)

`messages.message_id` unique is the database-level idempotency backstop. The
Trigger.dev `idempotencyKey` is the first line of defense. The Resend
`Idempotency-Key` header is the third, and it is the only one covering a send
that succeeds remotely but fails before the outbound row is written.

## Risk tier rules

Implemented as a pure function in `src/lib/risk-tier.ts`. It is the only
safety-critical decision in the system and the only module with real unit test
coverage. Rules are ordered; first match wins. See the file for the canonical
list. Do not scatter risk logic into the task file.

The rule list is split in two. `PRE_AGENT_RULES` holds everything decidable
straight after classification — every BLOCK and ESCALATE rule, because both
tiers mean no AI-drafted reply is ever sent, so there is nothing for the agent
to write. `POST_AGENT_RULES` holds the four APPROVE rules, which need the
agent's output. `assessPreAgentRisk` runs the first band and returns `null` for
"keep going"; `assessRisk` runs both and is a complete decision on its own, so
the short circuit is an optimisation and never a precondition.

The practical effect: spam and escalations never reach a model call.

Invariants the test suite enforces, worth knowing before editing the rule array:

- Precedence is BLOCK > ESCALATE > APPROVE > AUTO, and reordering rules across
  those bands changes behavior silently. Tests pin the boundaries.
- A drift-guard test asserts the two entry points never disagree on a tier.
  Moving a rule across the pre/post boundary fails it.
- Account-data requests from an unauthenticated or unresolved sender
  **ESCALATE, they do not APPROVE**. A human shown a plausible draft will click
  yes, so a spoofable sender must never reach the approval queue.
- `assessRisk` parses its input with zod and **throws** on a malformed payload
  rather than falling through to AUTO. The caller must fail closed, not catch
  and send.
- Adding a rule means adding its case plus a precedence case. Every decision
  returns a `reason` equal to the rule `id`, and that string is logged verbatim
  as the audit trail.
- Each rule also carries an optional `acknowledge`, surfaced on `RiskDecision`,
  which decides whether the *sender* gets a short fixed note saying a human has
  it. Defaulting to `false` is deliberate: a new rule stays silent until someone
  reasons about it. Three invariants the suite pins, all of which look like
  inconsistencies until you know why:
  - **No BLOCK rule may ever acknowledge.** Acknowledging an `automated_sender`
    means our note trips their auto-reply, which we then classify and answer
    again — the unbounded loop. Acknowledging `abuse` confirms a monitored
    human reads the inbox.
  - **`reply_cap_exceeded` must not acknowledge**, even though it is ESCALATE.
    It fires because we have already sent five emails to this thread in 24h;
    the acknowledgment would be the sixth.
  - The copy is `ESCALATION_ACK_BODY` in `src/lib/notify.ts`, a constant, and
    must stay one. No model runs on an escalated message, so a generated
    acknowledgment would reintroduce exactly the fabrication risk that
    escalating was meant to avoid. It also states no reason — naming the failed
    check tells a spoofer what to forge.

  The once-per-thread guard lives in `finishWithoutReply` and reads
  `thread.status`, which is why `resolveThread` returns the status as it was
  *before* this message.

## Definition of done

The demo Loom must show, in one take:

1. A normal question arriving, hitting the RAG tool, and auto-sending
2. A message asking for account data, generating a draft, pausing, a human
   clicking approve, and the reply then sending
3. A spam message being classified and logged with no reply sent
4. The Trigger.dev run timeline for all three

If a feature does not appear in that list, it is not required.

## Repo conventions

- Conventional commits, small and incremental. No single squashed
  "initial commit".
- Build on a feature branch, open one PR into `main` with a real description,
  self-review with a few inline comments on tradeoffs, then merge.
- CI: one GitHub Actions workflow running `tsc --noEmit` and lint. Green check
  at the top of the repo.
- Tests: `risk-tier.test.ts` only. Do not chase coverage elsewhere.

## Anti-goals

Do not add: a dashboard, a settings UI, an admin panel, retry queues beyond what
Trigger.dev gives for free, an ORM abstraction layer, or a plugin system. Every
one of these makes the six-minute review worse.

<!-- TRIGGER.DEV SKILLS START -->
## Trigger.dev agent skills

This project has Trigger.dev agent skills installed in `.claude/skills/`. Before writing or changing Trigger.dev code (background tasks, scheduled tasks, realtime, or chat.agent AI agents), load the most relevant skill: `trigger-authoring-tasks`, `trigger-authoring-chat-agent`.
<!-- TRIGGER.DEV SKILLS END -->
