---
id: ADR-0003
type: decision
status: accepted
domain: system
title: Per-recipient tracking tokens
# area.name, e.g. dispatch.queue. One accepted decision per key; replacing one needs `supersedes`.
decision_key: capture.per-recipient
code_paths:
  - mailspring-plugin/**
  - src/**
  - migrations/**
supersedes: []
superseded_by: null
---

# ADR-0003 — Per-recipient tracking tokens

## Question

When an email goes to several people (To, Cc, Bcc), how does the owner see which of them opened it and clicked which link, without putting an address in a tracking URL (N2) and without waiting on the network inside Mailspring's synchronous send hook (ADR-0002)?

## Outcome

Each recipient gets their own token set: one image token and one redirect token per link. The Worker stores the address against the set (`recipients`, `recipient_links`) and records every event against the set it came through, so opens and clicks are attributed per recipient. Tracking URLs carry only random tokens.

- **While composing** the plugin registers the draft with all its recipients (normalised to lower case), and the Worker answers with one set per address. Registering again keeps each address's tokens, adds tokens for new links and recipients, and marks recipients no longer on the draft as not current.
- **At send** Mailspring calls the hook once per recipient (`needsPerRecipientBodies`). The hook rewrites that body with that recipient's set, which it looks up synchronously in local config. Cached tokens are used only when the registration covers exactly the draft's current recipients (normalised, in any order) and was made for the same delivery mode; otherwise the whole email goes out untracked and the plugin logs why once, so no body carries another recipient's tokens.
- **Microsoft Graph accounts** get one body for every recipient (Mailspring calls the hook once with a null recipient). The plugin registers these with `shared: true` and the Worker mints one set: with one recipient it is that recipient's set, otherwise its address is empty and the dashboard shows "shared copy, recipient unknown". A Graph registration is never reused for one-body-each sending, or the reverse, and a shared set registered for one person is never sent to a different set of recipients.
- **"Opened by"** counts only current recipients, in both the numerator and the denominator; removed recipients with activity are shown apart on the email page.
- **Forwarding hint**: within one recipient's set, a later probable-human event whose network, country or kind of device (phone, tablet, computer) differs from that recipient's first probable-human event is flagged "possibly forwarded or opened by someone else", with the differences as the reason. The hint is worked out when the data is read and never changes counts. It is not computed for shared sets or for message-level tokens from before this ADR.
- **Pixel markup** follows Mailspring's own: `<img alt="" src="…/i/<token>.png">`, with no size attributes, style or class, placed before `.gmail_quote`. The Worker serves a transparent 1x1 PNG.
- Message-level tokens (minted before this change, or by callers that send no `recipients`) keep working.

## Alternatives

| Alternative | Why it lost |
| --- | --- |
| One token set per message (before this ADR) | Cannot tell recipients apart; the owner's direction is to match Mailspring Pro, which tracks per recipient |
| Encode the recipient in the URL, as Mailspring does (base64 JSON of message, account and address) | Breaks N2: anyone holding the email can read the address, and blockers can match the pattern |
| Mint tokens at send time | Mailspring's send hook is synchronous and does not wait; anything after an `await` is lost (ADR-0002) |
| Store the forwarding hint on the event when recorded | Freezes a judgement that depends on later events; computing it when read keeps raw events the only record (ADR-0001) |

## Premises

- Mailspring master a8c31c1 (`app/src/flux/tasks/send-draft-task.ts`): with `needsPerRecipientBodies`, `self` is the untransformed body and each participant (To, Cc, Bcc) gets its own transform. With `account.sendsViaGraph()` true there is one transform with a null recipient.
- Mailspring's open-tracking plugin (`open-tracking-composer-extension.ts`) uses `<img alt="" src="${PLUGIN_URL}/o/${token}.png">` and says the omitted dimensions, class and branded alt are what blockers look for.
- `AccountStore.accountForId(id).sendsViaGraph()` is reachable from `mailspring-exports`; the account model itself was not read (partial checkout).

## Revisit if

- Mailspring changes how it builds per-recipient bodies or detects Graph accounts.
- The forwarding hint flags the same person often enough to be noise (for example on mobile networks).
- The owner starts sending to large lists (Never: bulk mail).

## Evidence

- reported: owner direction 2026-11-11: Mailspring Pro is the baseline, not the ceiling; match it, then do better.
- read: Mailspring master a8c31c1 `send-draft-task.ts` and `open-tracking-composer-extension.ts`, 2026-11-11.
- tested: `mailspring-plugin/__tests__/send.test.ts` (per-recipient bodies through the stand-in caller, Graph shared path, pixel markup), `src/__tests__/recipients.test.ts` and `src/__tests__/unit.test.ts` (minting, attribution, forwarding hint).
