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

## Current state (as of 2026-08-14)

The TypeScript side is built and green: `pnpm typecheck`, `pnpm lint`, and
`pnpm test` (46 cases) all pass. What has **not** been run is anything that
touches a live service — no migration applied, no embedding seeded, no task
triggered, no email sent. Treat "compiles and unit-tests pass" and "works end to
end" as different claims until the live checklist in the README has been run.

`make/blueprints/` is deliberately empty. See `make/README.md`.

## Commands

```bash
pnpm install
cp .env.example .env                   # fill in every value

pnpm supabase db push                  # schema + synthetic seed
pnpm seed:kb                           # embeds kb_chunks locally, no API cost
pnpm dev                               # trigger.dev dev (runs tasks locally)

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
  The only paid API in the stack. The model is named in exactly one place,
  `src/agent/model.ts` — swapping model or effort is a one-line change there
  and nowhere else.
- **Local embeddings** via `@huggingface/transformers`, all-MiniLM-L6-v2, 384
  dims, in-process. No API key, no cost, no network at query time.
- **Trigger.dev's free credit covers compute, not model calls.** Runs parked on
  `wait.forToken` are suspended and burn none of it.

Thinking is left unconfigured on purpose: it is on by default on Opus 5, and
`effort` is the dial to reach for instead of turning it off.

## Environment variables

`.env.example` is the source of truth and lists every one with a placeholder.

| Variable | Used by |
| --- | --- |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | all table access; RLS is on with no policies, so the service role is the only way in |
| `ANTHROPIC_API_KEY` | classify + reply agent |
| `MAKE_OUTBOUND_WEBHOOK_URL` | POST target for Make scenario B |
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
Make scenario A (inbound, ~5 modules)
  Watch emails -> loop-guard filter -> HTTP POST to Trigger.dev -> done

Trigger.dev task: inbound-email  (all real logic, TypeScript)
  idempotencyKey = RFC 5322 Message-ID
  1. parse + validate payload (zod)
  2. resolve sender against contacts table
  3. classify (LLM, structured output, zod-validated)
  4. agent loop with tools (AI SDK)
  5. compute risk tier (pure function, src/lib/risk-tier.ts)
  6. BLOCK    -> log only, no reply
     AUTO     -> POST Make scenario B
     APPROVE  -> wait.forToken(), on approve POST Make scenario B
     ESCALATE -> notify human, no AI reply

Make scenario B (outbound, ~3 modules)
  Webhook -> send email -> log activity to CRM
```

### Why the split

Make owns connectors (mailbox auth, OAuth, sending) because that is genuinely
tedious to hand-roll. Trigger.dev owns anything with branching, retries, or
state because that is where Make becomes unmaintainable. This split is the
central argument of the project and the README must lead with it.

### Why waitpoints for approval

`wait.createToken({ timeout: "1d" })` plus `wait.forToken()` pauses the run and
resumes it when the callback URL is hit. The alternative (write a `pending` row,
poll it on a cron) is more code, more failure modes, and no timeout semantics.
Approve and reject links in the notification point directly at the token
callback URL.

## Scope

### In scope, build for real

- Inbound to reply, end to end, actually working from a clean clone
- One genuine RAG tool: pgvector similarity search over a small seeded knowledge
  base in Supabase
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
- `kb_chunks` - id, source, content, embedding vector(384)

`messages.message_id` unique is the database-level idempotency backstop. The
Trigger.dev `idempotencyKey` is the first line of defense.

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
