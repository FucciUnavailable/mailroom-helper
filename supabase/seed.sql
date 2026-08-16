-- Synthetic seed data.
--
-- Every name, address, and company here is invented. `.test` and `.invalid`
-- are RFC 2606 reserved TLDs that can never resolve, so a misconfigured demo
-- cannot email a real person.
--
-- kb_chunks are searchable the moment they land: content_tsv is a generated
-- column, so there is no separate indexing or embedding step to remember.

insert into public.contacts (email, full_name, company, lifecycle_stage, notes)
values
  ('ada.byron@example-corp.test',      'Ada Byron',      'Example Corp',   'customer',    'Pro plan since 2024. Primary technical contact.'),
  ('grace.hopper@sample-industries.test', 'Grace Hopper', 'Sample Industries', 'opportunity', 'Evaluating the Team plan. Asked about SSO twice.'),
  ('alan.turing@testing-ltd.invalid',  'Alan Turing',    'Testing Ltd',    'lead',        'Downloaded the whitepaper, no calls yet.'),
  ('katherine.j@demo-analytics.test',  'Katherine J',    'Demo Analytics', 'churned',     'Cancelled after trial. Cited missing integrations.')
on conflict (email) do nothing;

-- --------------------------------------------------------------------------
-- Knowledge base.
--
-- Deliberately incomplete: the gaps are what make the ungrounded_answer risk
-- rule observable in the demo. Two subjects are held out on purpose and must
-- stay held out — **on-premise / self-hosted deployment** and **HIPAA / BAA**.
-- A question about either finds nothing, clears no relevance floor, and gets
-- routed to a human instead of being invented. Adding a chunk that mentions
-- them, even to say no, removes the only live demonstration of that rule.
--
-- Everything else is covered, and covered in the words a customer would
-- actually use. That is not padding. Retrieval is `ts_rank` over OR-ed
-- lexemes, and RANK_FLOOR sits just above a single-lexeme hit — so a chunk has
-- to match two or more distinct words from the question to count as evidence.
-- A chunk that says "custom-priced" and nothing else does not answer "what
-- does it cost"; one that also says "cost", "price" and "per seat" does. Write
-- these the way the question gets asked, not the way a spec gets written.
--
-- This section is rewritten wholesale on every run. `on conflict do nothing`
-- cannot dedupe here — there is no unique constraint on kb_chunks, and adding
-- one over a long text column is worse than owning the table outright. The
-- seed is the only writer, so re-running the file to pick up new chunks is
-- safe and repeatable rather than a silent way to double the corpus.
-- --------------------------------------------------------------------------
delete from public.kb_chunks;

insert into public.kb_chunks (source, content)
values
  ('overview.md',
   'Mailroom is a shared inbox assistant for sales and support teams. It reads every email that arrives in a shared mailbox, works out what the sender wants, and either answers the question automatically, drafts a reply and holds it for a human to approve, or hands the whole conversation to a person. It is aimed at teams who get more inbound email than they can answer quickly but who are not willing to let a bot reply unsupervised.'),

  ('overview.md',
   'What Mailroom does with a message depends on how risky the reply would be. Routine product questions are answered from your knowledge base and sent automatically. Anything touching a specific customer account, anything the assistant is unsure about, and anything it cannot find a source for is drafted and queued for human approval instead of being sent. Spam and automated mail are logged and never answered, because replying confirms the address is real and monitored.'),

  ('pricing.md',
   'Mailroom has three plans. Starter is $0 per month and includes one inbox and 100 tracked conversations. Team is $49 per user per month and adds shared inboxes, approval workflows, and priority routing. Enterprise is custom-priced and adds SSO, audit logs, and a dedicated success manager.'),

  ('pricing.md',
   'Billing is monthly by default. Annual billing is available on Team and Enterprise and saves two months versus paying monthly. Plan changes take effect immediately and are prorated to the day.'),

  ('pricing.md',
   'How much Mailroom costs depends on the plan and the number of seats. Starter is free forever and costs nothing. Team costs 49 dollars per user per month, so a team of five pays 245 dollars a month. Enterprise pricing is quoted per customer and depends on seat count and retention requirements. There is no setup fee, no charge per email, and no minimum contract on Starter or Team.'),

  ('pricing.md',
   'Every paid plan has a 14 day free trial with no credit card required. The trial includes the full Team feature set so you can test shared inboxes and approval workflows before you buy. If you do nothing at the end of the trial the account drops back to Starter rather than being suspended, and nothing is deleted.'),

  ('billing.md',
   'You can cancel at any time from the billing settings and the plan stays active until the end of the period you already paid for. There is no cancellation fee and no notice period. Refunds are issued for annual plans cancelled within 30 days of renewal, prorated for unused months. Invoices, receipts and VAT details are available for download in the billing settings, and Enterprise customers can pay by invoice and purchase order instead of card.'),

  ('api.md',
   'Mailroom has a REST API and outbound webhooks on every paid plan. The API covers reading conversations, sending replies, and managing contacts, and it authenticates with a bearer API key you create in settings. Rate limits are 100 requests per minute on Team and 1000 requests per minute on Enterprise. Webhooks are signed so you can verify they came from us, and failed deliveries are retried for 24 hours.'),

  ('reliability.md',
   'Mailroom targets 99.9 percent uptime and Enterprise plans include a 99.9 percent uptime SLA with service credits when it is missed. Current and historical availability is published on the public status page. Infrastructure runs in AWS with data stored in either the United States or the European Union, chosen per account when it is created and not moved afterwards.'),

  ('privacy.md',
   'Mailroom is GDPR compliant and will sign a data processing agreement with any paying customer. The list of subprocessors is published and customers on Enterprise are notified 30 days before it changes. Customer data is never used to train any machine learning model. You can request export or deletion of all data for an account at any time and it is completed within 30 days.'),

  ('limits.md',
   'There is no hard limit on how many emails Mailroom will process on a paid plan. Starter is capped at 100 tracked conversations per month. Individual messages are accepted up to 25 megabytes including attachments, which is the limit most mail providers enforce anyway. A single account can have up to 25 shared inboxes on Team and an unlimited number on Enterprise.'),

  ('security.md',
   'All data is encrypted in transit with TLS 1.3 and at rest with AES-256. Mailroom is SOC 2 Type II certified. Penetration tests are run annually by an external firm and a summary report is available to Enterprise customers under NDA.'),

  ('security.md',
   'Single sign-on via SAML 2.0 and SCIM user provisioning are available on the Enterprise plan. Okta, Entra ID, and Google Workspace are supported identity providers.'),

  ('support.md',
   'Starter includes community support. Team includes email support with a one business day response target. Enterprise includes a shared Slack channel and a four hour response target for issues marked urgent.'),

  ('integrations.md',
   'Mailroom connects to Gmail and Microsoft 365 for mailbox access. Outbound activity can be logged to HubSpot or Salesforce. A webhook API is available on all paid plans for custom integrations.'),

  ('onboarding.md',
   'A standard onboarding takes about two weeks. Week one covers mailbox connection and routing rules. Week two covers approval workflows and team training. Enterprise onboarding includes a migration review for existing ticket history.'),

  ('onboarding.md',
   'Getting started takes about ten minutes on your own: connect a mailbox, import your existing help documents, and send a test email. Migrating from another help desk is supported for Zendesk, Front and Help Scout, and imports historical conversations and contacts so your team keeps its history. Setup and migration assistance is included with Enterprise at no extra cost.'),

  ('support.md',
   'You can reach the Mailroom team by email at support, through the in-app chat on paid plans, or through your shared Slack channel on Enterprise. Support is staffed weekdays across European and North American business hours. There is no phone support on any plan.'),

  ('data-retention.md',
   'Message bodies are retained for 24 months by default. Retention is configurable between 1 and 84 months on Enterprise. Deleted conversations are purged from backups within 30 days.');
