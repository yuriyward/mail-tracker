---
id: ADR-0004
type: decision
status: accepted
domain: system
title: Agent-composed drafts carry tracking
# area.name, e.g. dispatch.queue. One accepted decision per key; replacing one needs `supersedes`.
decision_key: capture.agent-drafts
code_paths:
  - src/cli/**
  - src/**
  - mailspring-plugin/**
  - migrations/**
supersedes: []
superseded_by: null
---

# ADR-0004 — Agent-composed drafts carry tracking

## Question

The owner sends his agent's drafts from Mailspring, Fastmail web or his phone. Under ADR-0002 only a send from Mailspring adds tracking, so the others go out untracked. How does an agent's draft stay tracked wherever he presses Send, without this repository sending mail (N1) or reading his mailbox?

## Outcome

Owner design, approved 2026-11-11. This amends ADR-0002 for agent drafts: they get their tracking when composed, not at send. Tracking is on by default. Mail written in Mailspring is tracked at send as before.

- **`bun run compose`** (`src/cli/compose.ts`) renders the agent's body (plain text or Markdown) into an HTML template's `{{body}}` slot. The default template is in the repository; the owner's own, with his signature, lives outside it. It also makes a text alternative and turns bare https URLs into links with the plugin's own autolinker. It registers the message (`POST /api/messages`, `draftTracked: true`) and puts in the image and redirect URLs with the plugin's own `applyTokenSet`. One recipient gets that recipient's token set; several get one shared set (`shared: true`, recipient unknown). It writes `body.html`, `body.txt` and `receipt.json`. The owner's agent creates the draft with its own mail tools. `--no-track` renders without registering.
- **Draft previews.** A draft that carries the image hits the Worker whenever it is shown: in the composer, in Fastmail's draft list, on the phone. For a message registered with `draftTracked`, an event before `sent_at`, or any event while `sent_at` is unset, is a draft preview. It is labelled "Draft preview", is never counted, and is left out of first open, re-opens, people figures and the forwarding baseline. The rule is applied when data is read; the raw row is unchanged. If `sent_at` is set later, earlier events stay previews. An open that happened after the real send but before `sent_at` was known starts counting once `sent_at` is set. Messages registered by the plugin alone never carry the image before send, so their events count as before, including while a delivery notice is still pending.
- **`bun run sync-sent`** (`src/cli/sync-sent.ts`) marks such emails sent. It takes the emails not marked sent (`GET /api/messages?unsent=1`, with each email's `image_tokens`) and the owner's sent messages as JSON on stdin. It matches a sent message by our image token in its HTML, outside quoted text, and reports `sentAt` (`POST /api/messages/<token>/sent`). It never reads mail; the owner's agent supplies the messages.
- **The plugin** recognises its own image in a draft (same Worker origin, outside `.gmail_quote` and `blockquote`) and registers with `pixelToken`. The Worker then registers under the message that owns that image, not as a new message. It also returns the carried set's redirects (`carried`), so the hook can map each one back to its destination. With several recipients and one body each, every recipient's body gets that recipient's image and redirects in place of the shared ones. With one recipient, or one shared body under Graph, the set is the agent's own, so the tokens are kept. In every case there is one image per body. The plugin marks the email sent on delivery, as before.

## Accepted costs

- Links the owner adds outside Mailspring stay untracked.
- With several recipients, a send from outside Mailspring delivers one shared copy: opens and clicks are not split by recipient. The owner sends those through Mailspring or an agent.
- Sent from Fastmail web or the phone, the owner's Sent copy keeps the image and the redirects. If he opens it after sending, that open counts unless his IP is in `SELF_IPS` or the hit carries his Access token. No Worker change: a hit on the Sent copy is indistinguishable from the recipient's. Sent from Mailspring, the Sent copy is clean (note below).
- Classification uses the registration time as the send time until `sent_at` is known, so the "seconds after send" rules (early opens and clicks) cannot fire for an email sent outside Mailspring before `sync-sent` runs.

## Alternatives

| Alternative | Why it lost |
| --- | --- |
| Keep tracking at send only (ADR-0002) | Drafts sent from Fastmail or the phone go out untracked |
| A compose page in the dashboard | A second place to write mail (ADR-0002); the agent writes, the owner edits in his clients |
| Count every hit while unsent as an open | Every look at the draft would count as the recipient's open |
| Store the preview flag on the event when recorded | An open after the real send but before `sync-sent` ran would stay a preview forever; working it out when read keeps the raw row the only record (ADR-0001) |
| Apply the preview rule to every unsent message | A plugin email whose delivery notice is late or lost would lose real opens |
| `compose` or `sync-sent` creating drafts or reading the Sent folder | Would put mail credentials and mailbox access in this repository; the owner's agent already has mail tools (N1, ADR-0001) |
| Match sent copies by subject and recipients | Ambiguous for repeated subjects; the image token is exact |

## Note 2026-11-11: clean Sent copy from Mailspring

Owner, 2026-11-11: reopening his own Sent mail must not count as the recipient opening it. When the plugin will split the bodies, its `needsPerRecipientBodies` also cleans the draft it is given. Mailspring passes its own clone (`SendDraftTask.forSending`) and reads the `self` body from that clone straight after. The cleaning removes our image outside quoted text and maps every redirect in the registration's `carried` map back to its URL. The per-recipient (or shared Graph) hook then works from the clean body and puts each recipient's tokens back. Nothing is cleaned when the registration no longer fits, since the draft then goes out as the agent wrote it. Limits: if Mailspring's own tracking answers `needsPerRecipientBodies` first, ours is not asked and the Sent copy keeps the agent's tracking. `sync-sent` cannot match a clean Sent copy; the plugin's delivery notice marks those emails sent. Tested in `mailspring-plugin/__tests__/pretracked.test.ts` through the stand-in caller, which now clones the draft like Mailspring.

## Premises

- The owner sends from Mailspring, Fastmail web and his phone (owner, 2026-11-11).
- The owner's agent can create drafts from given HTML and text and list sent messages with their HTML (owner, 2026-11-11; not checked here).
- Mail clients keep the draft's HTML on send. Fastmail and iOS Mail were not checked.

## Revisit if

- A client rewrites or strips the image or the redirects when sending a draft.
- Draft previews turn out to be most hits, so the D1 write budget matters.
- The owner wants per-recipient tracking for sends outside Mailspring.

## Evidence

- reported: owner design, approved 2026-11-11 (ward-assistant chat).
- tested: `src/cli/__tests__/compose.test.ts` (one and several recipients, `--no-track`, autolink, template slot), `src/cli/__tests__/sync-sent.test.ts` (matching by image, quoted images, re-runs), `src/__tests__/draft-preview.test.ts` (labelling, counting, later `sent_at`, forwarding baseline) and `mailspring-plugin/__tests__/pretracked.test.ts` (a pre-tracked draft through the stand-in caller of `send-draft-task.ts`), all against the in-memory Worker.
