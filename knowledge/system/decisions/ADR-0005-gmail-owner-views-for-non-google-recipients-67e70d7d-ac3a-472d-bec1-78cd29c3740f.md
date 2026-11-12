---
id: ADR-0005
type: decision
status: accepted
domain: system
title: Gmail owner views for non-Google recipients
# area.name, e.g. dispatch.queue. One accepted decision per key; replacing one needs `supersedes`.
decision_key: capture.gmail-self
code_paths:
  - src/**
  - migrations/**
supersedes: []
superseded_by: null
---

# ADR-0005 — Gmail owner views for non-Google recipients

## Question

How can the owner's own Gmail Sent views stop counting as recipient opens when the image proxy looks identical?

## Outcome

Owner approved this design on 2026-11-12. This amends ADR-0004's Sent-copy limitation now that the owner sends from Google Workspace Gmail. Registration resolves each recipient domain's MX through Cloudflare's JSON DNS-over-HTTPS API with a two-second timeout. Store google / other / unknown on each recipient token set (migration 0006); a shared copy is other only if every recipient is other. Missing, failed or malformed answers are unknown. Existing sets remain unknown without a backfill.

At read time, an on-open Gmail-proxy open at or after sent_at on an other set becomes class self, label "You (Gmail)", never counted. Leave it out of first open, re-opens, people figures, preload inputs and forwarding baselines. Draft previews retain precedence; raw event rows remain unchanged. Google and unknown keep existing behavior. Message-level tokens without recipient metadata stay unchanged. Sending, cleaning the owner's Sent copy and deployment remain outside this change.

## Alternatives

| Alternative | Why it lost |
| --- | --- |
| Suppress every Gmail proxy | Would hide Gmail recipients' real opens |
| Use proxy IP or user agent to identify the owner | Owner and recipient fetches share both signals |
| Rewrite raw event rows | Loses original classification and prevents read-time interpretation like ADR-0004 |
| Backfill existing messages | Historical hosting cannot be established from today's MX; keep unknown |

## Premises

- The owner's mailbox moved to Google Workspace Gmail on 2026-11-12.
- A recipient whose mail is hosted elsewhere does not normally open through Gmail's image proxy. A forward or imported mailbox can still do so: this rule deliberately suppresses those ambiguous opens.
- MX is a registration-time hosting hint; gateways and later migrations can make it incomplete.

## Revisit if

- Non-Google MX recipients regularly read their mail through Gmail or forwarding opens need separate treatment.
- The owner changes mail provider, or Google changes its proxy signals.

## Evidence

- reported: owner approval (chat, 2026-11-12).
- reported: live test 8, 2026-11-12: viewing the owner's Sent copy in Gmail web and app produced two post-send GoogleImageProxy opens for a non-Google recipient. They shared the Gmail-recipient proxy signature and were shown as Gmail opens. A pre-send proxy fetch was correctly Draft preview. A later direct mobile-browser open was also recorded. No real addresses, IPs or message content are retained here.
- measured: synthetic in-memory Worker tests in src/**tests**/mail-host.test.ts cover mocked DoH answers and timeout, google / other / unknown, shared sets, preview precedence, raw row preservation and summary exclusions. This does not establish live behavior after deployment.
