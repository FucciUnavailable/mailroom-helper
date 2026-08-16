-- Mailroom schema.
--
-- Four tables, one full-text index, one search function. Everything is
-- reached through the service role from the Trigger.dev task, so RLS is
-- enabled with no policies: the service role bypasses it, and anon/authenticated
-- get nothing. There is no client-side reader by design.

-- --------------------------------------------------------------------------
-- contacts — the mocked CRM. Swapping to HubSpot replaces src/tools/crm.ts,
-- not this table.
-- --------------------------------------------------------------------------
create table if not exists public.contacts (
  id              uuid primary key default gen_random_uuid(),
  email           text not null unique,
  full_name       text not null,
  company         text,
  lifecycle_stage text not null default 'lead'
                  check (lifecycle_stage in ('lead', 'opportunity', 'customer', 'churned')),
  notes           text,
  created_at      timestamptz not null default now()
);

-- --------------------------------------------------------------------------
-- threads — one row per email conversation, keyed on the normalised subject +
-- participant pair that Make sends as thread_key.
-- --------------------------------------------------------------------------
create table if not exists public.threads (
  id              uuid primary key default gen_random_uuid(),
  thread_key      text not null unique,
  contact_id      uuid references public.contacts (id) on delete set null,
  status          text not null default 'open'
                  check (status in ('open', 'awaiting_approval', 'escalated', 'closed')),
  -- Agent turns taken on this thread. Feeds the agent_turn_limit risk rule.
  turn_count      integer not null default 0 check (turn_count >= 0),
  last_message_at timestamptz not null default now(),
  created_at      timestamptz not null default now()
);

create index if not exists threads_contact_id_idx on public.threads (contact_id);

-- --------------------------------------------------------------------------
-- messages — every inbound and outbound message, with the decision that was
-- made about it.
--
-- message_id is the RFC 5322 Message-ID and its unique constraint is the
-- database-level idempotency backstop. The Trigger.dev idempotencyKey is the
-- first line of defence; this is what catches a redelivery that slipped past
-- it. Double-replying to a customer is unrecoverable, so it is enforced twice.
-- --------------------------------------------------------------------------
create table if not exists public.messages (
  id             uuid primary key default gen_random_uuid(),
  thread_id      uuid not null references public.threads (id) on delete cascade,
  message_id     text not null unique,
  direction      text not null check (direction in ('inbound', 'outbound')),
  subject        text,
  body           text not null,
  classification jsonb,
  risk_tier      text check (risk_tier in ('BLOCK', 'APPROVE', 'ESCALATE', 'AUTO')),
  -- The rule id that fired, logged verbatim so a decision can be audited
  -- against src/lib/risk-tier.ts without re-running the model.
  risk_reason    text,
  created_at     timestamptz not null default now()
);

create index if not exists messages_thread_id_created_at_idx
  on public.messages (thread_id, created_at desc);

-- Supports the repliesLast24h count feeding the reply_cap_exceeded rule.
create index if not exists messages_outbound_recent_idx
  on public.messages (thread_id, created_at desc)
  where direction = 'outbound';

-- --------------------------------------------------------------------------
-- kb_chunks — the knowledge base behind the retrieval tool.
--
-- Retrieval is Postgres full-text search, not pgvector. A knowledge base this
-- small does not need semantic search to answer the questions in the demo, and
-- the vector path cost a 90MB model download inside the deployed container on
-- every cold start. The tool contract in src/tools/kb-search.ts is unchanged,
-- so swapping this function back to a cosine search is a one-function change
-- that no caller sees.
--
-- content_tsv is generated rather than maintained by a trigger: to_tsvector
-- with an explicit regconfig is immutable, which is exactly the condition
-- Postgres requires, and it cannot drift out of sync with content.
-- --------------------------------------------------------------------------
create table if not exists public.kb_chunks (
  id          uuid primary key default gen_random_uuid(),
  source      text not null,
  content     text not null,
  content_tsv tsvector generated always as (to_tsvector('english', content)) stored,
  created_at  timestamptz not null default now()
);

create index if not exists kb_chunks_content_tsv_idx
  on public.kb_chunks
  using gin (content_tsv);

-- --------------------------------------------------------------------------
-- search_kb_chunks — ranked full-text search.
--
-- The query is normalised into lexemes and OR-ed together rather than passed
-- through plainto_tsquery, which ANDs. ANDing is wrong here: the agent writes
-- a natural-language question, and requiring every lexeme to appear means a
-- question the knowledge base *does* answer returns nothing the moment the
-- agent phrases it with one word we never wrote down.
--
-- match_threshold is the grounding floor and it is doing the same job the
-- cosine floor did. If nothing clears it the tool returns zero rows,
-- hasGroundingEvidence goes false, and the reply is gated rather than invented.
--
-- The default mirrors RANK_FLOOR in src/tools/kb-search.ts, which is where the
-- number is reasoned about and where the measurement behind it is written down.
-- Note that ts_rank does *not* rise reliably with the number of distinct query
-- lexemes matched — it tracks term frequency, and an OR-ed query is diluted by
-- the terms that miss, so a longer question scores lower. Tuning this by
-- intuition produced a floor that rejected every real question. Re-run
-- diagnostics/rank-check.sql instead.
-- --------------------------------------------------------------------------
create or replace function public.search_kb_chunks (
  query_text text,
  match_threshold double precision default 0.035,
  match_count integer default 5
)
returns table (
  id      uuid,
  source  text,
  content text,
  rank    double precision
)
language sql
stable
security invoker
set search_path = public
as $$
  with q as (
    select to_tsquery(
      'english',
      array_to_string(
        tsvector_to_array(to_tsvector('english', query_text)),
        ' | '
      )
    ) as query
  )
  select
    c.id,
    c.source,
    c.content,
    ts_rank(c.content_tsv, q.query)::double precision as rank
  from public.kb_chunks c
  cross join q
  where c.content_tsv @@ q.query
    and ts_rank(c.content_tsv, q.query) >= match_threshold
  order by rank desc
  limit match_count;
$$;

alter table public.contacts  enable row level security;
alter table public.threads   enable row level security;
alter table public.messages  enable row level security;
alter table public.kb_chunks enable row level security;
