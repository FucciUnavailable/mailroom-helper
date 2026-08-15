-- Mailroom schema.
--
-- Four tables, one vector index, one similarity function. Everything is
-- reached through the service role from the Trigger.dev task, so RLS is
-- enabled with no policies: the service role bypasses it, and anon/authenticated
-- get nothing. There is no client-side reader by design.

create extension if not exists vector with schema extensions;

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
-- kb_chunks — the knowledge base behind the one real RAG tool.
--
-- embedding is nullable so seed.sql can ship readable text with no vector
-- literals in git; scripts/seed-kb.ts fills them in on setup.
--
-- 384 dims to match all-MiniLM-L6-v2, which runs locally in-process via
-- transformers.js. Embeddings are the one part of the pipeline with no API
-- cost and no provider account. Changing embedding model means changing this
-- number and re-running the seed — the column width is not negotiable at
-- query time.
-- --------------------------------------------------------------------------
create table if not exists public.kb_chunks (
  id         uuid primary key default gen_random_uuid(),
  source     text not null,
  content    text not null,
  embedding  extensions.vector(384),
  created_at timestamptz not null default now()
);

-- HNSW rather than IVFFlat: IVFFlat needs a populated table to build a useful
-- list structure, and this knowledge base is deliberately tiny.
create index if not exists kb_chunks_embedding_idx
  on public.kb_chunks
  using hnsw (embedding extensions.vector_cosine_ops);

-- --------------------------------------------------------------------------
-- match_kb_chunks — cosine similarity search.
--
-- The threshold is the grounding floor. If nothing clears it the tool returns
-- zero rows, hasGroundingEvidence goes false, and the reply is gated rather
-- than invented.
-- --------------------------------------------------------------------------
create or replace function public.match_kb_chunks (
  query_embedding extensions.vector(384),
  match_threshold double precision default 0.3,
  match_count integer default 5
)
returns table (
  id         uuid,
  source     text,
  content    text,
  similarity double precision
)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select
    c.id,
    c.source,
    c.content,
    1 - (c.embedding <=> query_embedding) as similarity
  from public.kb_chunks c
  where c.embedding is not null
    and 1 - (c.embedding <=> query_embedding) >= match_threshold
  order by c.embedding <=> query_embedding
  limit match_count;
$$;

alter table public.contacts  enable row level security;
alter table public.threads   enable row level security;
alter table public.messages  enable row level security;
alter table public.kb_chunks enable row level security;
