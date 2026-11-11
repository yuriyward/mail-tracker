# mail-tracker

**Job:** "When I send a one-to-one email that matters (a client, a recruiter), I want to see whether and when it was opened and which links were clicked, so that I know when to follow up and what caught interest."

## Users

| Who | Uses it to |
| --- | --- |
| The owner, one person | See opens and clicks per sent email, for mail drafted by an agent or written by hand |
| The owner's agent | Create tracked HTML drafts and answer questions about engagement through a read-only API |

Not a user: anyone sending newsletters, campaigns or bulk mail. Recipients never interact with it beyond loading an image or following a link.

## Direction

Mailspring Pro's tracking is the baseline, not the ceiling: match it, then do better (owner, 2026-11-11). Per-recipient tracking: ADR-0003.

## Never

- **N1** Send mail. Drafts only; the owner sends from his own client (ADR-0001).
- **N2** Put a destination URL or a recipient address in a tracking URL; destinations live server-side (ADR-0001).
- **N3** Expose anything but the image and redirect routes without authentication (ADR-0001).
