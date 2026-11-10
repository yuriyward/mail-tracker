---
id: ADR-0001
type: decision
status: accepted
domain: system
title: Product scope and boundaries
# area.name, e.g. dispatch.queue. One accepted decision per key; replacing one needs `supersedes`.
decision_key: product.scope
code_paths:
  - src/**
supersedes: []
superseded_by: null
---

# ADR-0001 — Product scope and boundaries

## Question

What should a personal open and click tracker for one-to-one email be, given that Mailspring Pro (about $8/month) already works for the owner but is a closed hosted service?

## Outcome

A single Cloudflare Worker on a subdomain of the owner's zone, built with Hono, storing links and events in a D1 database created in the EU jurisdiction. Public routes are only the tracking image and the link redirect; creating tracked links and the per-email dashboard require authentication (an API token for the agent, Cloudflare Access for the dashboard). Every event is kept raw and classified (probable human, proxy or prefetch, scanner, self, unknown). It never sends mail: tracked HTML drafts go to the owner's mailbox and he sends them himself, and mail he writes by hand can be tracked too. No notifications in v1.

## Alternatives

| Alternative | Why it lost |
| --- | --- |
| Keep Mailspring Pro | Closed, per-month fee, tied to one client; the owner wants his own and agent access |
| Service on the owner's server | Needs a public port, TLS and upkeep; the Worker gets DNS and TLS from the zone |
| Existing open-source trackers (Pixletter, pixel-track, Shlink, Mautic, listmonk, Postal) | Tiny unaudited projects or bulk-mail systems; the Worker is about 150 lines |
| Elysia or plain fetch handlers | Elysia's Cloudflare adapter is documented as experimental; plain handlers need hand-built routing and auth |
| KV or Analytics Engine for events | KV is eventually consistent and write-limited per key; Analytics Engine is aggregate, not per message |

## Premises

- Volume is a few dozen one-to-one emails a month, far under the Workers free tier (100,000 requests a day).
- The owner's domain is already on Cloudflare.
- Opens and clicks are hints, not proof: Apple Mail Privacy Protection prefetches, Gmail proxies images, link scanners click.

## Revisit if

- A crawler or scanner exhausts the free daily request cap (then move to the $5 paid plan).
- Recipients' clients block the image or links so often that the signal is useless.
- The owner wants tracking for bulk mail.

## Evidence

- reported: research jobs on 2026-11-10 comparing Mailspring's mechanism, self-hosted trackers, Cloudflare Workers and D1 limits and prices, blocking behaviour of mail clients and filter lists, and Hono vs Elysia (two model families; their reports are kept by the owner, not in this repository).
- reported: owner decisions 2026-11-10: own tracker on a Worker, Hono, a dashboard per email, tracking also for hand-written mail, no Telegram notifications in v1.
