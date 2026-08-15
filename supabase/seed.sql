-- Synthetic seed data.
--
-- Every name, address, and company here is invented. `.test` and `.invalid`
-- are RFC 2606 reserved TLDs that can never resolve, so a misconfigured demo
-- cannot email a real person.
--
-- kb_chunks ship with text only. Run `pnpm seed:kb` to fill in the embeddings
-- locally — no vector literals are committed.

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
-- Deliberately small and deliberately incomplete: the gaps are what make the
-- ungrounded_answer risk rule observable in the demo. A question about, say,
-- on-premise deployment finds nothing, clears no similarity floor, and gets
-- routed to a human instead of being invented.
-- --------------------------------------------------------------------------
insert into public.kb_chunks (source, content)
values
  ('pricing.md',
   'Mailroom has three plans. Starter is $0 per month and includes one inbox and 100 tracked conversations. Team is $49 per user per month and adds shared inboxes, approval workflows, and priority routing. Enterprise is custom-priced and adds SSO, audit logs, and a dedicated success manager.'),

  ('pricing.md',
   'Billing is monthly by default. Annual billing is available on Team and Enterprise and saves two months versus paying monthly. Plan changes take effect immediately and are prorated to the day.'),

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

  ('data-retention.md',
   'Message bodies are retained for 24 months by default. Retention is configurable between 1 and 84 months on Enterprise. Deleted conversations are purged from backups within 30 days.')
on conflict do nothing;
