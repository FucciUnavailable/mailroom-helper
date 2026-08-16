-- Measure the grounding floor instead of reasoning about it.
--
-- RANK_FLOOR in src/tools/kb-search.ts (and the match_threshold default in
-- 0001_init.sql) decides when the agent is allowed to answer from the
-- knowledge base and when the reply gets held for a human. It was originally
-- derived from how ts_rank scales with matched lexemes, not measured. This
-- file measures it.
--
-- Run the whole thing in the Supabase SQL Editor after seed.sql. It is
-- read-only — no writes, no cost, safe to re-run.
--
-- The probes below are split into two groups and the split is the point:
--   grounded   — questions the knowledge base genuinely answers. These must
--                clear the floor, or a real customer question gets held for
--                approval and the reply says "I don't have that" about
--                something we wrote down.
--   ungrounded — on-premise deployment and HIPAA, held out of the seed on
--                purpose. These must NOT clear the floor, or the
--                ungrounded_answer rule stops being demonstrable.
--
-- A floor is correct when every 'grounded' row has hits > 0 and every
-- 'ungrounded' row has hits = 0. Query 2 finds that range for you.
--
-- Last run 2026-08-16, against the nineteen-chunk seed. The two groups are not
-- fully separable: the HIPAA probe scores 0.0304 because "sign" and "compliant"
-- both land in the GDPR/DPA chunk, and eight grounded probes score at or below
-- that. The floor is therefore set at 0.035 — above every held-out probe, which
-- is the constraint that cannot be traded away — and the eight grounded probes
-- underneath it are held for human approval rather than answered. That is the
-- safe direction, and it is a corpus gap, not a threshold to lower: closing it
-- means chunks that use those questions' words, and re-running this file.

-- --------------------------------------------------------------------------
-- The probe set. Phrased the way a person types, not the way the seed is
-- written — matching the seed's own wording would only prove the seed matches
-- itself.
-- --------------------------------------------------------------------------
create or replace view public.kb_probes as
select * from (values
  -- Should retrieve something.
  ('grounded',   'what it is',        'What does your product actually do?'),
  ('grounded',   'cost, short',       'How much does it cost?'),
  ('grounded',   'cost, seats',       'What would this run us for 20 people?'),
  ('grounded',   'free trial',        'Do you offer a free trial?'),
  ('grounded',   'plan difference',   'What is the difference between Team and Enterprise?'),
  ('grounded',   'sso',               'Do you support SAML single sign-on?'),
  -- Verbatim from the first live test email, which was held for approval under
  -- ungrounded_answer at the old 0.08 floor while the SSO chunk sat at the top
  -- of the result set scoring 0.0405. Kept as a probe so that regression is
  -- caught here rather than in someone's inbox.
  ('grounded',   'live email 1',      'What is the difference between your Team and Enterprise plans, and do you support SAML single sign-on?'),
  ('grounded',   'security',          'How is our data encrypted and are you SOC 2?'),
  ('grounded',   'cancel',            'Can we cancel any time or is there a contract?'),
  ('grounded',   'refund',            'Do you give refunds?'),
  ('grounded',   'api',               'Is there an API and what are the rate limits?'),
  ('grounded',   'uptime',            'What uptime do you guarantee?'),
  ('grounded',   'gdpr',              'Are you GDPR compliant and will you sign a DPA?'),
  ('grounded',   'data residency',    'Can our data stay in the EU?'),
  ('grounded',   'training data',     'Do you train models on customer email?'),
  ('grounded',   'migration',         'Can we import our history from Zendesk?'),
  ('grounded',   'setup time',        'How long does it take to get set up?'),
  ('grounded',   'support hours',     'What are your support hours?'),
  ('grounded',   'integrations',      'Do you connect to Salesforce?'),
  ('grounded',   'retention',         'How long do you keep message bodies?'),
  ('grounded',   'attachment size',   'What is the maximum attachment size?'),

  -- Must retrieve nothing. These are the held-out subjects.
  ('ungrounded', 'on-prem',           'Can we run this on-premise in our own datacenter?'),
  ('ungrounded', 'self-host',         'Is there a self-hosted version we can install?'),
  ('ungrounded', 'hipaa',             'Are you HIPAA compliant and will you sign a BAA?'),
  ('ungrounded', 'unrelated',         'Do you sell replacement bicycle tyres?')
) as t(expectation, label, query_text);

-- --------------------------------------------------------------------------
-- Query 1 — what each probe retrieves, and at what rank.
--
-- Calls the real search_kb_chunks with the floor forced to 0, so this reports
-- what retrieval *found* rather than what the current floor let through. The
-- floor is then applied here, in SQL you can edit, instead of in the function.
--
-- Change :floor to try a different value.
-- --------------------------------------------------------------------------
with settings as (select 0.035::double precision as floor),
     scored as (
       select p.expectation,
              p.label,
              p.query_text,
              m.source,
              m.rank
       from public.kb_probes p
       left join lateral public.search_kb_chunks(p.query_text, 0, 5) m on true
     )
select
  s.expectation,
  s.label,
  round(coalesce(max(s.rank), 0)::numeric, 5)                as best_rank,
  count(*) filter (where s.rank >= (select floor from settings)) as hits_at_floor,
  case
    when s.expectation = 'grounded'
     and count(*) filter (where s.rank >= (select floor from settings)) > 0
      then 'ok'
    when s.expectation = 'ungrounded'
     and count(*) filter (where s.rank >= (select floor from settings)) = 0
      then 'ok'
    else '>>> WRONG'
  end                                                        as verdict,
  string_agg(distinct s.source, ', ' order by s.source)
    filter (where s.rank >= (select floor from settings))    as matched_sources
from scored s
group by s.expectation, s.label, s.query_text
order by s.expectation, best_rank desc;

-- --------------------------------------------------------------------------
-- Query 2 — the floor's working range.
--
-- The floor must sit strictly above the best rank any 'ungrounded' probe
-- achieves, and at or below the worst best-rank across the 'grounded' probes.
-- If lower_bound >= upper_bound the two groups overlap and no single floor
-- separates them — that is a knowledge base problem, not a threshold problem:
-- either a held-out subject is being partially matched by a chunk that should
-- not mention it, or a grounded question has no chunk written in its words.
-- --------------------------------------------------------------------------
with best as (
  select p.expectation,
         p.label,
         coalesce((select max(m.rank)
                   from public.search_kb_chunks(p.query_text, 0, 5) m), 0) as best_rank
  from public.kb_probes p
)
select
  round(max(best_rank) filter (where expectation = 'ungrounded')::numeric, 5)
    as lower_bound_exclusive,
  round(min(best_rank) filter (where expectation = 'grounded')::numeric, 5)
    as upper_bound_inclusive,
  round((
      (max(best_rank) filter (where expectation = 'ungrounded')
       + min(best_rank) filter (where expectation = 'grounded')) / 2
  )::numeric, 5) as suggested_rank_floor,
  case
    when max(best_rank) filter (where expectation = 'ungrounded')
       < min(best_rank) filter (where expectation = 'grounded')
      then 'separable — use suggested_rank_floor'
    else 'OVERLAP — fix the knowledge base, not the floor'
  end as status
from best;

-- --------------------------------------------------------------------------
-- Cleanup. The view exists only for the two queries above.
-- --------------------------------------------------------------------------
drop view public.kb_probes;
