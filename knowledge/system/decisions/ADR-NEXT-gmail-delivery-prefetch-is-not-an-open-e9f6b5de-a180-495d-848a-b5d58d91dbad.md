---
id: ADR-NEXT-gmail-delivery-prefetch-is-not-an-open-e9f6b5de-a180-495d-848a-b5d58d91dbad
type: decision
status: accepted
domain: system
title: Gmail delivery prefetch is not an open
# area.name, e.g. dispatch.queue. One accepted decision per key; replacing one needs `supersedes`.
decision_key: capture.gmail-delivery-prefetch
code_paths:
  - src/**
  - web/**
supersedes: []
superseded_by: null
---

# ADR-NEXT-gmail-delivery-prefetch-is-not-an-open-e9f6b5de-a180-495d-848a-b5d58d91dbad — Gmail delivery prefetch is not an open

## Question

How should Gmail's automatic delivery fetch be distinguished from a later open?

## Outcome

Owner approved on 2026-11-14 (chat): "Yes, you can do it." Amend ADR-0004 and ADR-0005 at read time, keeping raw rows unchanged. Per token set, label the first post-send on-open Gmail-proxy open within 30 seconds of sent_at "Prefetch by Gmail", class proxy, counted 0. Exclude it from first open, re-opens, people figures, preload inputs and forwarding baselines. Later hits retain existing counting and duplicate rules. Shared copies use their shared token set; legacy message-level tokens form one set per message.

Without sent_at this rule does nothing. Draft previews retain precedence, as does ADR-0005's Gmail self classification for non-Google sets. Pre-send fetches do not consume the first post-send slot. The dashboard label filter uses the shared label list.

## Alternatives

| Alternative | Why it lost |
| --- | --- |
| Count delivery fetches as opens | Reports engagement with the Gmail app closed |
| Suppress all Gmail fetches within 30 seconds | Hides a second hit that may represent an actual open |
| Rewrite stored events | Loses evidence and prevents reinterpretation after sent_at is reported |

## Premises

- Gmail's delivery fetch uses the same GoogleImageProxy signature as a real open.
- Thirty seconds is an owner-approved heuristic, not proof that no person opened the email.

## Revisit if

- Gmail changes delivery fetch timing or stops making a later request for real opens.
- Live evidence shows this window regularly hides real first opens or misses delivery fetches.

## Evidence

- reported: owner approval in chat, 2026-11-14.
- reported: test 10 event attachment and probe 0, 2026-11-13: Gmail fetched each Gmail recipient's image 6–7 seconds after sending with the Gmail app closed and nothing opened. Test 10's prefetch was at 22:43:48 UTC; a real open at 23:02:51 UTC generated a later proxy hit. Another proxy request followed the first by about 0.4 seconds. Account, contact and message data are omitted.
- measured: synthetic Worker tests in src/**tests**/gmail-prefetch.test.ts cover the window, subsequent hits, missing sent_at, shared copies, raw row preservation and downstream figures. These tests do not establish live behavior after deployment.
