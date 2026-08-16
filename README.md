# Mailroom

An AI email agent for a shared sales inbox. It reads inbound mail, answers what
it can from a knowledge base, routes anything sensitive to a human for approval,
and deliberately stays silent on spam.

**[Watch the 4 minute walkthrough](TODO-loom-link)**

> Built as a working reference for how I'd structure an AI digital employee:
> Make for connectors, Trigger.dev for typed durable logic.

---

## The architecture bet

Make is excellent at connectors and poor at branching logic. Trigger.dev is the
inverse. So mailbox polling and OAuth stay in Make, and every decision lives in
typed TypeScript that can be tested and version controlled.

The split is drawn per-connector, not per-direction. Watching a shared inbox
earns a connector platform: OAuth, polling, header extraction, all of it
tedious and none of it interesting. Sending is one authenticated POST to
Resend, so it stays in TypeScript where it can be typed, retried, and made
idempotent. "Use the connector platform for the connectors that are actually
hard" is a more useful rule than "all I/O goes in Make".

```mermaid
flowchart TD
    A[Inbound email] --> B["Make scenario A<br/>Watch emails · loop-guard filter"]
    B -->|HTTP POST| C["Trigger.dev: inbound-email<br/>idempotencyKey = Message-ID"]

    C --> D[Validate payload · zod]
    D --> E[Resolve sender against contacts]
    E --> F[Classify · structured output]

    F --> P{"Pre-agent gate<br/>BLOCK · ESCALATE rules"}
    P -->|BLOCK| I[Log only. No reply sent.]
    P -->|ESCALATE| J[Notify human. No AI reply.]
    P -->|clear| G["Agent loop · AI SDK<br/>kb_search · crm_lookup · booking_link"]

    G --> H{"risk-tier.ts<br/>full pass"}
    H -->|APPROVE| K["wait.forToken timeout 1d"]
    H -->|AUTO| L["Resend<br/>send · record outbound"]

    K -->|Slack link| R["Make scenario C<br/>GET → POST relay"]
    R -->|approved| L
    R -->|rejected| J
    K -->|timeout| J

    G <--> M[(Supabase<br/>contacts · threads<br/>messages · kb_chunks)]

    L --> N[Reply delivered]
```

The Make side is 8 modules across two scenarios. Everything that would have
become an unreadable router tree is a function instead.

Two things in that diagram are worth pausing on.

**The gate runs twice, and the first pass is the cheap one.** Every BLOCK and
ESCALATE rule is decidable from the classification alone, and both tiers mean
no AI-drafted reply is ever sent — so there is nothing for the agent to write.
Spam and escalations never reach a model call or a tool. The full pass still
re-checks both bands, so it remains correct on its own; skipping ahead is an
optimisation, not a precondition, and a test asserts the two never disagree.

**Scenario C exists for a boring reason.** A Slack incoming webhook can only
render a hyperlink, and a hyperlink is a `GET` — but completing a Trigger.dev
waitpoint is a `POST`. Two modules bridge the two. The token's callback URL
carries its own secret, so the relay stores no credentials.

## What's real and what's mocked

Stated up front so you don't have to go find out.

| Component                    | Status    | Notes                                                                          |
| ---------------------------- | --------- | ------------------------------------------------------------------------------ |
| Inbound to reply, end to end | **Real**  | Works from a clean clone via `pnpm sample`                                      |
| Classification               | **Real**  | Claude structured output, zod-validated                                        |
| Knowledge base retrieval     | **Real**  | Postgres full-text search, ranked, with a grounding floor. Lexical, not semantic — see below |
| Sending                      | **Real**  | Resend, threaded via In-Reply-To, idempotent on the inbound Message-ID          |
| Approval gate                | **Real**  | Trigger.dev waitpoint, live approve/reject links                               |
| Idempotency + loop guards    | **Real**  | Message-ID keyed, enforced three times; header-based guards                    |
| CRM                          | Mocked    | Supabase `contacts` table. Swapping to HubSpot is one file: `src/tools/crm.ts` |
| Meeting scheduling           | Mocked    | Returns a static booking link. No calendar writes.                             |
| Lead enrichment              | Not built | Out of scope                                                                   |
| Make blueprints              | Partial   | Scenario C is committed and importable; A is specified in `make/README.md` but not exported |

Seed data is synthetic throughout, on the RFC 2606 reserved `.test` and
`.invalid` TLDs — a misconfigured demo cannot email a real person.

**Providers.** Claude does classification and the reply loop, and is the only
metered API here. Resend sends, on a free tier that comfortably covers a demo.
Retrieval is Postgres, so it costs nothing and adds no provider. The model is
named in exactly one file, `src/agent/model.ts`.

That file currently pins `claude-haiku-4-5`, the cheapest model in the lineup,
so that iterating on the demo costs approximately nothing. Haiku 4.5 rejects the
`effort` parameter outright, so both provider-options objects are empty; moving
up to Sonnet 5 or Opus 5 means restoring `effort` in the same edit. The comment
in that file says so, because the two changes have to travel together.

## Design decisions

**Spam gets no reply.** The brief said "always respond." I don't think that's
right. An auto-reply confirms a live, human-monitored address and gets you added
to more lists. Spam is classified, logged, and dropped. Deciding when _not_ to
act is most of the work in an autonomous email agent.

**Approval is a waitpoint, not a status column.** `wait.forToken({ timeout:
"1d" })` pauses the run with no idle cost and resumes it when the approve link
is hit. The alternative is a `pending` row plus a polling cron, which is more
code, has no timeout semantics, and loses the run context.

**Idempotency is keyed on the RFC 5322 Message-ID**, enforced three times: as
the Trigger.dev `idempotencyKey`, as a unique constraint on
`messages.message_id`, and as the `Idempotency-Key` on the Resend send. Mail
triggers re-fire. Double-replying to a customer is unrecoverable.

The third layer is not belt-and-braces, it covers a window the other two miss.
A send that succeeds at Resend but fails before the outbound row is written
gets retried by Trigger.dev, and the outbound row is keyed on a fresh UUID, so
nothing downstream would notice the duplicate. The inbound Message-ID is stable
across every attempt of the run, so Resend returns the original send instead of
delivering a second copy.

**Risk tiering is one pure function**, `src/lib/risk-tier.ts`, and it's the only
module with real test coverage. That's deliberate. It's the only place in the
system where a bug sends the wrong thing to a real person, so it's the only
place worth testing hard.

**The agent never fills gaps.** If a tool returns nothing, the reply says so and
offers a human. In any regulated or money-adjacent domain, a confidently
fabricated account status is worse than no reply at all. This is enforced in the
tool contracts, not just the prompt: every tool returns an explicit
`found: false` / `grounded: false` shape rather than throwing or returning null,
so "we don't have that" is a value the model receives and can report — and the
same boolean feeds the risk rule that gates ungrounded answers.

**Retrieval is full-text search, and that is a downgrade I chose.** This
started as pgvector with all-MiniLM-L6-v2 embedded locally, which was lovely
until it had to run in a deployed container: ~90MB of model weights pulled at
every cold start, `onnxruntime-node` externalised out of the bundle because
esbuild has no loader for prebuilt `.node` binaries, against a 120-second run
ceiling. For eight knowledge base chunks, that is a lot of machinery bought
with the first impression of a live demo.

So `search_kb_chunks` is `ts_rank` over a generated `tsvector` column. The
query is normalised into lexemes and OR-ed rather than passed through
`plainto_tsquery`, which ANDs — ANDing means a question the knowledge base does
answer returns nothing the moment the agent phrases it with one word we never
wrote down.

What survives is the part that mattered: the grounding floor. A rank below it
returns zero rows, `hasGroundingEvidence` goes false, and the reply is gated
rather than invented — exactly as the cosine floor did. `src/tools/kb-search.ts`
is the entire seam, so restoring pgvector is one function and no caller
changes.

**Sender authentication is parsed in TypeScript, not in Make.** No mailbox
module exposes SPF and DKIM as booleans; they live inside the
`Authentication-Results` header. Make forwards the raw string and
`src/lib/auth-results.ts` decides, because a regex that gates account-data
disclosure belongs somewhere it can be read and tested. A missing header reads
as *not authenticated* — for a signal whose only job is to gate account data,
unknown has to mean no.

## Running it locally

```bash
pnpm install
cp .env.example .env          # fill in the values listed there
```

Create the schema by running two files in the Supabase SQL Editor, in order:
`supabase/migrations/0001_init.sql`, then `supabase/seed.sql`. Two copy-pastes,
no CLI login and no project linking — worth it to keep setup under a minute.

There is no indexing step. `kb_chunks.content_tsv` is a generated column, so
the knowledge base is searchable the moment `seed.sql` finishes.

```bash
pnpm dev                      # trigger.dev dev — tasks run on your machine
```

Then drive the task directly, with Make out of the loop:

```bash
pnpm sample --fixture general-question   # → RAG hit, auto-sends
pnpm sample --fixture account-question   # → draft, waitpoint, Slack approval
pnpm sample --fixture spam               # → blocked before any model call
pnpm sample --fixture spam --fresh       # new Message-ID, replays past idempotency
```

Offline checks need no credentials at all:

```bash
pnpm typecheck && pnpm lint && pnpm test
```

### Running it from a real mailbox

Build the two scenarios in `make/README.md`, then decide which Trigger.dev
environment the inbound webhook points at. The secret key in scenario A's
`Authorization` header is what chooses.

A `tr_dev_…` key routes runs to your **dev** environment, which only executes
while `pnpm dev` is running on your machine. That is fine for wiring things up
and wrong for anything you intend to leave running: the approval branch parks
on `wait.forToken({ timeout: "1d" })`, and a parked dev run cannot resume once
the terminal is gone.

```bash
pnpm deploy                   # trigger deploy
```

Then put a `tr_prod_…` key in Make. Deployed runs do not read `.env` — set
every variable from `.env.example` in the Trigger.dev dashboard for the prod
environment, or the task fails at boot on the first message, which is by design
(`src/env.ts` parses at import time).

### What a green checkmark does and doesn't tell you

CI runs `tsc --noEmit`, `eslint`, and the risk-tier suite. That is a real
signal about the decision logic and the type-level contracts, and it says
nothing about whether Supabase, Anthropic, Resend, Slack, or Make are wired up
correctly — none of those are touched without credentials. The three `pnpm
sample` runs above are what actually proves the path end to end.

One number in particular is unverified until you run it: the `RANK_FLOOR` in
`src/tools/kb-search.ts` was reasoned about from how `ts_rank` scales with
matched lexemes, not measured against a live database. Check that
`general-question` retrieves the pricing and SSO chunks and that an
out-of-scope question (on-prem deployment, HIPAA) retrieves nothing, and adjust
the one constant if not.

## Layout

```
src/
  trigger/inbound-email.ts   the spine — branching only
  agent/model.ts             the only place a model is named
  agent/classify.ts          generateObject, zod-validated
  agent/reply.ts             the tool loop
  tools/                     kb-search, crm, booking — zod in and out
  lib/risk-tier.ts           the safety-critical decision
  lib/risk-tier.test.ts      the only real test suite
  lib/auth-results.ts        SPF/DKIM out of Authentication-Results
  lib/db.ts, notify.ts       everything with I/O, kept out of the spine
  schemas.ts                 zod contracts for every boundary
  env.ts                     parsed at import; missing vars fail at boot
make/README.md               the eight Make modules, spec'd
supabase/migrations/         schema + search_kb_chunks
supabase/seed.sql            synthetic contacts and KB text
scripts/                     send-sample, fixtures
```

## What I'd do next

- Replace the mock CRM with HubSpot (one file, the tool interface is already the
  seam)
- Real scheduling: freebusy query, propose slots, book only after the recipient
  picks one
- Sender verification as a hard gate before any reply containing account data,
  rather than routing it to approval. The SPF/DKIM half exists
  (`src/lib/auth-results.ts`); pairing it with an exact contact match and
  refusing outright is the change
- Restore pgvector for retrieval once cold starts are worth solving — a
  prebuilt image with the weights baked in, or a hosted embedding call. The
  tool contract already accommodates it
- Per-thread reply rate limiting, and hard escalation after 3 agent turns with
  no resolution
- Evaluation harness over a fixture set, scoring classification accuracy and
  risk-tier precision. Recall on the APPROVE tier matters far more than
  precision: a false AUTO is a customer-facing incident, a false APPROVE is
  someone clicking a button.
