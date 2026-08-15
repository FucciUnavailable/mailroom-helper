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

**The repo is pre-scaffold.** Four files exist: this document, `README.md`, and
`risk-tier.ts` + `risk-tier.test.ts` **at the repo root**. There is no
`package.json`, no `src/`, no `supabase/`, no `make/`, no CI workflow, no
`.env.example`, and no git history (`git init` has not been run).

Everything from the Architecture heading down is the intended design, not the
built system. Before citing a path from this document or the README, check
whether it exists. In particular both docs say `src/lib/risk-tier.ts`; the file
is currently `./risk-tier.ts` and needs moving when the scaffold lands.

## Commands

No `package.json` exists yet, so these are contracts the scaffold must satisfy,
not verified commands. The README already promises them to a reviewer running a
clean clone.

```bash
pnpm install
cp .env.example .env
pnpm supabase db push                  # schema + synthetic seed
pnpm dlx trigger.dev@latest dev        # local task runner

pnpm tsc --noEmit                      # CI gate 1
pnpm lint                              # CI gate 2

pnpm vitest run                        # full suite (risk-tier only)
pnpm vitest run src/lib/risk-tier.test.ts
pnpm vitest run -t "blocks spam"       # single test by name

# Drive the task without Make in the loop
pnpm tsx scripts/send-sample.ts --fixture spam
pnpm tsx scripts/send-sample.ts --fixture account-question
pnpm tsx scripts/send-sample.ts --fixture general-question
```

The `--fixture` script is the demo path and the only way to exercise the system
end to end without a Make account. Keep it working.

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
- `kb_chunks` - id, source, content, embedding vector(1536)

`messages.message_id` unique is the database-level idempotency backstop. The
Trigger.dev `idempotencyKey` is the first line of defense.

## Risk tier rules

Implemented as a pure function in `src/lib/risk-tier.ts`. It is the only
safety-critical decision in the system and the only module with real unit test
coverage. Rules are ordered; first match wins. See the file for the canonical
list. Do not scatter risk logic into the task file.

Invariants the test suite enforces, worth knowing before editing the rule array:

- Precedence is BLOCK > ESCALATE > APPROVE > AUTO, and reordering rules across
  those bands changes behavior silently. Tests pin the boundaries.
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
