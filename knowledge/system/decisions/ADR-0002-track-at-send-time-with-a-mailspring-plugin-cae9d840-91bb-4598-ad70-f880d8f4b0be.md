---
id: ADR-0002
type: decision
status: accepted
domain: system
title: Track at send time with a Mailspring plugin
# area.name, e.g. dispatch.queue. One accepted decision per key; replacing one needs `supersedes`.
decision_key: capture.send-time
code_paths:
  - mailspring-plugin/**
  - src/**
supersedes: []
superseded_by: null
---

# ADR-0002 — Track at send time with a Mailspring plugin

## Question

How does a sent email get its tracking image and tracked links, for mail drafted by the owner's agent and for mail the owner writes by hand?

## Outcome

The owner writes and sends all mail in Mailspring. A Mailspring plugin in this repository rewrites the outgoing HTML at send time: it asks the Worker's authenticated API for a message token and one token per link, replaces each link with its redirect URL and appends the tracking image. Agent drafts are ordinary HTML drafts placed in the owner's mailboxes (outside this repository); they get tracking the same way when he sends them, after any edits. There is no compose page in the dashboard. Mailspring Pro's own tracking is turned off once this works.

## Alternatives

| Alternative | Why it lost |
| --- | --- |
| A compose page in the dashboard that creates pre-tracked drafts | A second place to write mail; the owner writes in Mailspring |
| Rewriting saved drafts on the mail server | Whether Mailspring keeps a server-side edit of its draft is unconfirmed; previews can fire the image |
| A full mail client of our own | Months of sync, search and HTML-safety work before tracking exists |
| Another client (Thunderbird, Inbox Zero, Zero, Roundcube, SnappyMail, Cypht) | None tracks to a self-run server out of the box; the owner likes Mailspring |
| The community mailspring-api backend | Needs a modified client; maintenance status unclear |

## Premises

- Mailspring's composer plugins can transform the outgoing message body (reported by two research jobs, 2026-11-10).
- Mailspring Pro's tracking points at its own servers and cannot be repointed by configuration.
- Mailspring ships releases often (three between 2026-09-12 and 2026-10-22), so the plugin is rechecked per release.

## Revisit if

- A Mailspring release breaks the plugin hook.
- The owner moves to another mail client.
- Mailspring's built-in local MCP server can create drafts and that changes how agent drafts are made.

## Evidence

- reported: research jobs on 2026-11-10 (two model families) comparing open-source mail clients, Mailspring's plugin API and tracking packages, and the effort of a custom client; reports kept by the owner, not in this repository.
- reported: owner decision 2026-11-10: write mail only in Mailspring or through agents; no compose UI; plugin at send time; Worker, D1 and a separate dashboard per email.
