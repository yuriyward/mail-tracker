# mail-tracker

Open and click tracking for personal 1:1 email, on a Cloudflare Worker.

## About this repository

This repository is the public part of a private agent harness. It carries the product intent, decisions and code; the tooling that writes, checks and reviews them stays private, so the method can be used here without disclosing private data. Agent configuration such as `CLAUDE.md`, `.claude/`, hooks and CI workflows is left out on purpose; please do not open pull requests adding it.

## How it works

- `src/` is a Cloudflare Worker (Hono on workerd) with a D1 database (`migrations/`).
  - `GET /i/<token>.png`: a transparent 1x1 PNG (`Cache-Control: no-store`) and one event row. Image URLs from older emails, without a suffix or ending in `.gif`, still work.
  - `GET /l/<token>`: a 302 to the https URL stored for that token, plus one event row. Destinations live only in D1 and are checked again on redirect (https, public host name, no credentials). A tracking URL never carries a destination or a recipient, and it can't be used as an open redirect.
  - Recording happens after the response, via `waitUntil`. A failing D1 write is logged and never breaks the image or the redirect. Every hit gets a row. A repeat by the same IP, user agent and HTTP method on the same image or link within 30s is flagged `duplicate` and left out of the counts, so a HEAD followed by a GET still counts the GET.
  - `POST /api/messages` (bearer `API_TOKEN`, the write token for the plugin) takes `{ "draftId", "subject", "recipient", "recipients": [addresses], "shared", "links": [https URLs] }` and returns `{ token, shared, recipients: [{ address, imageUrl, links: [{ url, redirectUrl }] }], imageUrl, links }`. Each address (compared case-insensitively) gets its own image and redirect tokens (ADR-0003). With `shared: true` (an account that sends one body to all, i.e. Microsoft Graph) there is one set: the recipient's own if there is one recipient, otherwise one with the address `""` (recipient unknown). The top-level `imageUrl` and `links` are message-level tokens for callers that send no `recipients`. It is idempotent per `draftId` (the draft's `headerMessageId`): calling it again updates the subject and recipients, reuses the tokens of known URLs and addresses, and adds tokens for new ones. Recipients that are no longer on the draft are kept but marked not current. It answers 201 the first time and 200 after that.
  - `POST /api/messages/<token>/sent` (bearer `API_TOKEN`) takes `{ "sentAt" }` and records the delivery time once. A reported time before registration, or more than 5 minutes ahead of the Worker's clock, is replaced by the Worker's clock.
  - `GET /api/messages` and `GET /api/messages/<token>` (bearer `API_READ_TOKEN`, the read-only token for the owner's agent) are read-only summaries and per-email links and events, for the owner's agent. The list shows emails that were sent or have events, with `recipients` and `opened_by` (current recipients with a counted open or click). Recipients removed from the draft are left out of both; the email page lists any that still have activity separately. The detail adds `recipients` (opens, clicks, first and last open and forwarding hints per recipient) and a `hint` on each event (see the forwarding hint below).
  - `/app` is the dashboard: a list of emails (with how many recipients opened), and a page per email with its totals (opens split into probable human and on-open proxy, clicks per link, first and last open), a row per recipient, and the full timeline with the recipient of each event. Both refresh every 15s while the tab is visible. Cloudflare Access protects it. The Worker verifies the `Cf-Access-Jwt-Assertion` header against the team's keys, issuer and audience, and requires `exp`. If `ALLOWED_EMAILS` is set, the token's email must be one of them. An unknown key id triggers a refetch of the keys, for key rotation, at most once a minute, so made-up key ids sent to `/i/` and `/l/` cannot make the Worker fetch keys on every hit.
  - The dashboard is a React app in `web/` (Vite, Tailwind), built into `web/dist/app` and bound as Workers Static Assets (`ASSETS`). `run_worker_first` sends every request, assets included, through the Worker, so the page, its script, styles and fonts are only served after the Access check. The app reads JSON from `/app/data` and `/app/messages/<token>/data` (shapes and the counting rule: `src/dashboard-data.ts`). All of it is served with a strict CSP: same-origin script, styles, fonts and images only, no inline script, no third-party origins.
  - The app uses the LittleBit Bauhaus design system ([yuriyward/bauhaus-design-system](https://github.com/yuriyward/bauhaus-design-system)). The copied files are listed with their source in `.ward/design-system-copies.tsv`, and the design-system commit they match is in `.ward/design-system-base`. They are left exactly as copied and are excluded from lint and format.
  - There are no CORS headers. `/api` is for the plugin (Node `https`) and agents, not for browsers.
- Every event is kept raw and classed `human` (probable human), `proxy` (proxy or prefetch), `scanner`, `self` or `unknown`, with the reason stored (`src/classify.ts`):
  - **self**: an IP in `SELF_IPS`, or a valid Access token of the owner (header or `CF_Authorization` cookie, verified like `/app`). A cookie that is merely present, or a Mailspring user agent, does not count.
  - **scanner**: HEAD requests, bot user agents, hits from a security gateway's published ranges (below), clicks within 10s of sending, clicks from data-centre networks, and the same IP and user agent clicking two links of the email within 3s. Your own clicks are left out of that check.
  - **proxy**: on-open image proxies (Gmail's `GoogleImageProxy`, Yahoo's, or an open from Google's published service ranges), and prefetches (Apple's bare `Mozilla/5.0`, an open from Apple's Private Relay or Microsoft's Exchange Online ranges, mail-provider networks, opens within 30s of sending).
  - **Published network ranges** (`src/networks.ts`): the hit's IP is looked up in the vendors' own lists, and the reason names the list that matched, e.g. `prefetch: IP in the Apple iCloud Private Relay egress list`. The first list that holds the IP decides:

    | List | Source | Open | Click |
    | --- | --- | --- | --- |
    | Apple iCloud Private Relay egress (Mail Privacy Protection loads images through it) | [egress-ip-ranges.csv](https://mask-api.icloud.com/egress-ip-ranges.csv) ([docs](https://developer.apple.com/support/prepare-your-network-for-icloud-private-relay/)) | prefetch | other rules (people browse in Safari through the same relay) |
    | Google services, Gmail's image proxy among them | [goog.json](https://www.gstatic.com/ipranges/goog.json) minus [cloud.json](https://www.gstatic.com/ipranges/cloud.json), Google Cloud customers ([docs](https://support.google.com/a/answer/10026322)) | on-open proxy (counted) | scanner |
    | Microsoft 365 Exchange Online and Exchange Online Protection, where Defender for Office 365 Safe Links runs | [endpoints.office.com](https://endpoints.office.com/endpoints/worldwide?clientrequestid=b10c5ed1-bad1-445f-b386-b919946339a7), service area Exchange ([docs](https://learn.microsoft.com/en-us/microsoft-365/enterprise/urls-and-ip-address-ranges)) | prefetch (Outlook's image proxy is still counted by its user agent) | scanner |
    | Mimecast | SPF records under `_netblocks.mimecast.com` ([Data Centers & URLs](https://mimecastsupport.zendesk.com/hc/en-us/articles/34000362728979-Administration-Data-Centers-URLs)) | scanner | scanner |
    | Proofpoint Essentials | [Connection Details](https://help.proofpoint.com/Proofpoint_Essentials/Email_Security/Administrator_Topics/000_gettingstarted/020_connectiondetails), copied into `scripts/refresh-networks.ts` | scanner | scanner |

    The ranges are a committed data file, `src/networks.json`, that `bun run refresh:networks` regenerates from these sources. Review the diff, commit, deploy. A file was chosen over a cron trigger that writes them to D1 or KV because it needs no binding, migration or per-hit query, keeps classification a pure function that tests can pin down, and the lists change slowly. Apple's 285k prefixes collapse to about 14k blocks (450 KB, about 200 KB gzipped in the bundle). The cost is that new ranges only apply after a refresh and deploy.

  - **Counting:** opens and clicks in the list count only probable humans and on-open proxies, without duplicates, so an Apple prefetch is never shown as the first open. The timeline shows every event.
  - **Forwarding hint** (`src/forwarding.ts`): within one recipient's tokens, a later probable-human event from a different network, country or kind of device (phone, tablet, computer) than that recipient's first one is marked "possibly forwarded or opened by someone else", with what differed. It is worked out when the data is read and does not change any count. It is a hint, not proof: the same person on mobile data or a second device looks the same. Shared copies to several recipients and emails from before per-recipient tokens get no hint.
- `mailspring-plugin/` tracks at send time, in two steps, because Mailspring calls `applyTransformsForSending` synchronously and serialises the body right after (`app/src/flux/tasks/send-draft-task.ts`):
  1. **While you compose:** an invisible `Composer:Footer` component sees each edit of a draft that is open in a composer. Drafts that only arrive by sync are never registered. The window showing the composer registers the draft with the Worker 2s after the last edit, keyed by its `headerMessageId`, and again right when you press Send. Only https links outside quoted text (`.gmail_quote`) are sent. Bare `https://` URLs typed as plain text are first turned into links (both here and at send), so their clicks go through the Worker too. Without this, the recipient's client (Gmail, iOS Mail) makes them clickable itself and the click bypasses tracking. Text inside existing links, quoted text (`.gmail_quote`, `blockquote`), `code` and `pre` is left alone. Trailing punctuation (`.,;:!?)]` and quotes) is not part of the URL. Only URLs the redirect allow-list accepts become links. Your Sent copy keeps the text as you typed it. The tokens are stored in Mailspring's local config, one key per draft (`mail-tracker-registrations.<draft>`). Each write touches only its own key, so windows never overwrite each other, and every window can read them, so it also works with undo send and send later.
  2. **At send:** `needsPerRecipientBodies` makes Mailspring file the untransformed body as your Sent copy, so it has no image and no rewritten links, and run the hook once per recipient. Each run uses that recipient's tokens: it rewrites only the links already registered and adds the image before any quoted text, marked up like Mailspring's own (`<img alt="" src="….png">`, no size, style or class, which blockers look for). It replaces tracking images quoted from earlier emails. Links added after the last registration, and drafts never registered, go out as written. The tokens are used only if the registration covers exactly the draft's current recipients (compared case-insensitively, in any order) and the same delivery mode (one shared body under Graph, or one body each). Otherwise the whole email goes out untracked and the console logs why once, so no one gets another recipient's tokens. It is still one message row per draft. If the draft as sent has links or a subject or recipients that the registration doesn't cover, it logs a warning once (`mail-tracker: sending with an older registration: …` in the console).
  3. **After delivery:** only when Mailspring reports delivery (`draftDeliverySucceeded`, in the main window) does the plugin mark the email sent, with the delivery time. A failed delivery never sets the send time. The notice is kept in config (`mail-tracker-pending-sent`) and retried after 10s, 1min, 5min, 30min and 2h, including after a restart. After that it is dropped and logged.
  - **Never blocks a send:** plaintext drafts, a disabled or unconfigured plugin, and any error inside the hook all mean the mail goes out untracked.
  - Requests go through Node's `https`, not `fetch`. Mailspring windows load from `file://` with web security on, so a `fetch` with an `Authorization` header would need a CORS preflight.

## Quick start

Requires [Bun](https://bun.sh) and a Cloudflare account with your domain on it.

```bash
bun install
bun run check
```

1. **Create the database** in the EU jurisdiction and paste the printed `database_id` into `wrangler.toml`:

   ```bash
   bun x wrangler d1 create mail-tracker --jurisdiction eu
   bun x wrangler d1 migrations apply mail-tracker --remote
   ```

2. **Choose the host.** In `wrangler.toml`, uncomment `routes` and set your subdomain, e.g. `track.example.com`. `workers_dev` stays off.

3. **Protect the dashboard.** In Cloudflare Zero Trust, add a self-hosted Access application for `track.example.com/app` with a policy that lets only you in (the Worker refuses any `/app` request without a valid Access assertion, so a path Access misses fails closed). Put the team domain (`<team>.cloudflareaccess.com`) in `ACCESS_TEAM_DOMAIN` and the application's AUD tag in `ACCESS_AUD` in `wrangler.toml`. Do not put `/i/` or `/l/` behind Access.

4. **Set the API tokens** (long random strings): `API_TOKEN` is the write token for the plugin, and `API_READ_TOKEN` is the read-only token for your agent. Neither works for the other's routes.

   ```bash
   openssl rand -base64 32 | bun x wrangler secret put API_TOKEN
   openssl rand -base64 32 | bun x wrangler secret put API_READ_TOKEN
   ```

   Optionally list your own IPs in `SELF_IPS` so your hits are classed self, and your Access email in `ALLOWED_EMAILS`.

5. **Deploy:** `bun run deploy` (wrangler builds the dashboard app first, `bun run build:web`).

6. **Install the Mailspring plugin:**

   ```bash
   bun run build:plugin   # writes mailspring-plugin/lib/main.js
   ```

   In Mailspring choose _Developer → Install a Plugin…_ and select the `mailspring-plugin` folder (or link it into Mailspring's `packages` directory). Open _Preferences → Mail Tracker_, enter the Worker URL (`https://track.example.com`) and the API token, and keep _Track opens and clicks_ on. Turn off Mailspring Pro's own read receipts and link tracking so a message is not tracked twice.

To run the Worker locally: `bun x wrangler d1 migrations apply mail-tracker --local`, put `API_TOKEN=...` and `API_READ_TOKEN=...` in `.dev.vars` (ignored by git), then `bun run dev`. Locally there is no Access in front, so `/app` answers 401 unless you send a valid assertion. `bun run build:web` rebuilds the app, and `bun run check` builds it before the tests that inspect the build.

## Limits

- Opens and clicks are hints, not proof: Apple Mail Privacy Protection prefetches images, Gmail proxies them, and security gateways follow links. Check the class and reason of each event.
- Classification happens once, when the event arrives; a later burst does not reclassify earlier clicks.
- **Published ranges go stale** between refreshes (`bun run refresh:networks`), and they only cover what each vendor publishes. Microsoft does not publish separate ranges for Safe Links detonation, which can run from wider Azure space. Mimecast's and Proofpoint's lists are their mail-server ranges, so their link scanners may use other addresses. Proofpoint Enterprise (Proofpoint on Demand) publishes no general list. Proofpoint's page is not machine-readable, so its ranges are copied by hand.
- The plugin stores the API token in Mailspring's config file in plain text.
- Links in quoted text are left as they are, so tracked links quoted from an earlier email keep crediting that email.
- A link added, or a draft written, in the last moment before Send may go out untracked if its registration has not finished. Mailspring does not wait for it.
- Registrations are kept in Mailspring's config for 30 days; the main window prunes older ones on start-up.
- **Graph accounts** (Microsoft accounts that Mailspring sends through Microsoft Graph, detected with `account.sendsViaGraph()`): Mailspring sends one tracked body to all recipients, so the plugin registers one shared token set. With several recipients the dashboard shows "shared copy, recipient unknown". If the delivery mode at send differs from the registration's (an account switch that has not re-registered yet), the email goes out untracked rather than credit one person for everyone. Treat the Sent copy as tracked: it may keep the image and rewritten links, and opening it records events, classed self only if your IP is in `SELF_IPS`. Mailspring's source says its untracked `self` body is still filed as the Sent copy for these accounts, but this is unverified, and Microsoft may file the tracked message as well.
- Drafts registered by the plugin before per-recipient tokens register again the next time a composer shows them. One sent without being opened in a composer again goes out untracked.
- **Scanners that rotate IPs** still create one row per hit. Duplicates are only recognised for the same IP, user agent and method. Scanner rows are classed but not counted, and they count towards D1's write limits.
