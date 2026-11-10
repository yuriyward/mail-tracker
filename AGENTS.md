# mail-tracker

Instructions for agents working in this repository. Product intent and its Never list: `PRODUCT.md`; decisions: `knowledge/INDEX.md`.

## Privacy

- Use synthetic names, ids and message text in source, tests, examples, docs and commit messages. Never copy real account, contact or message data into tracked files.
- Keep exports under `exports/`, private state under `state/` and temporary helpers under `.tmp/`; all three are ignored.
- Never commit credentials, session data, exports or fixtures derived from real data.

## Uses

- <system>: contract `<command or path>`; classify by its status fields, never by output text.

## Maintenance

- Run `bun run check` after changes.
- End every report with `## Not verified`; a result proven only on recorded samples starts with "unproven live".
