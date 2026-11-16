---
id: ADR-0006
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

# ADR-0006 — Gmail delivery prefetch is not an open

## Question

How should Gmail's automatic delivery fetch be distinguished from a later open?

## Outcome

Owner approved on 2026-11-14 (chat): "Yes, you can do it." Amend ADR-0004 and ADR-0005 at read time, keeping raw rows unchanged. Amended 2026-11-16 after live test 9: per token set, label every on-open Gmail-proxy open within 30 seconds before or after sent_at "Prefetch by Gmail", class proxy, counted 0. Exclude it from first open, re-opens, people figures, preload inputs and forwarding baselines. Hits outside the window retain existing counting and duplicate rules. Shared copies use their shared token set; legacy message-level tokens form one set per message.

Without sent_at this rule does nothing. Draft previews retain precedence (draft_tracked messages before sent_at). Within the window, the prefetch label precedes ADR-0005's Gmail self label; outside it ADR-0005 is unchanged. Gmail reasons use the same shared predicate as eventDisplay's via Gmail, including Google's service-IP classification with desktop user agents. The dashboard label filter uses the shared label list.

## Alternatives

| Alternative | Why it lost |
| --- | --- |
| Count delivery fetches as opens | Reports engagement with the Gmail app closed |
| Suppress only the first post-send fetch | Test 9 showed multiple delivery fetches before the delivery notice; amended 2026-11-16 |
| Rewrite stored events | Loses evidence and prevents reinterpretation after sent_at is reported |

## Premises

- Gmail delivery fetches can use GoogleImageProxy or a Google service IP with a desktop user agent, just like real opens.
- Mailspring delivery notices can arrive after delivery, so sent_at can lag prefetches.
- Thirty seconds is an owner-approved heuristic, not proof that no person opened the email.

## Revisit if

- Gmail changes delivery fetch timing or stops making a later request for real opens.
- Live evidence shows this window regularly hides real first opens or misses delivery fetches.

## Evidence

- reported: owner approval in chat, 2026-11-14.
- reported: test 10 event attachment and probe 0, 2026-11-13: Gmail fetched each Gmail recipient's image 6–7 seconds after sending with the Gmail app closed and nothing opened. Test 10's prefetch was at 22:43:48 UTC; a real open at 23:02:51 UTC generated a later proxy hit. Another proxy request followed the first by about 0.4 seconds. Account, contact and message data are omitted.
- reported: live test 9, 2026-11-16, Mailspring plugin on the owner's Gmail Workspace account: two delivery fetches arrived about 7 and 2 seconds before sent_at (draft_tracked 0). One used a Google-service IP reason and desktop Edge user agent; the other used GoogleImageProxy. Both were incorrectly shown as opens. No account, contact or message data are retained.
- measured: synthetic Worker tests in src/**tests**/gmail-prefetch.test.ts cover the window, subsequent hits, missing sent_at, shared copies, raw row preservation and downstream figures. These tests do not establish live behavior after deployment.
