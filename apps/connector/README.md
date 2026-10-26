# @opportun/connector

`opportun-connector` reads Apple Mail on your Mac and pushes the messages to your own
Opportun server (FR-M5, design section 6.2, ADR-10). Setup, launchd and troubleshooting are
in [docs/install.md, section 11](../../docs/install.md#11-apple-mail-macos).

```bash
pnpm --filter @opportun/connector build     # -> dist/opportun-connector.js (self-contained)
opportun-connector init                     # server, device token, mailboxes, lookback
opportun-connector sync                     # push new mail once
opportun-connector watch [--interval 15]    # sync every N minutes until Ctrl-C
```

## Security

- **Token scope**: the connector authenticates with a device token that has only the
  `mail:push` scope, created in Settings > Integrations > Devices (password-confirmed and
  shown once). That scope can call exactly one route, `POST /api/v1/connector/mail/batch`;
  it cannot read mail, contacts or anything else back.
- **Revocation**: revoking the token in Settings > Integrations > Devices cuts the
  connector off on its next request. It then exits with code 3 and says to create a new
  token and re-run `init` (under the launchd agent it is restarted and fails the same way
  every 15 minutes until then). Detection has latency: a sync with no new mail sends no
  request at all, so a revoked token is only noticed at the first sync that has mail to
  push. Nothing is sent with it in the meantime, so this is a reporting delay, not a leak.
- **What leaves the Mac**: only messages in the mailboxes you configure, received within
  the lookback window (then only newer ones): message id, sender, To and Cc recipients,
  subject, sent and received dates, and the plain-text body cut at 500,000 characters
  (HTML bodies are converted to text first). Attachments, other mailboxes, and your mail
  account credentials never leave the Mac.
- **Read-only (FR-M7)**: the embedded JXA script only reads. It never changes read status
  or flags, moves, deletes, drafts or sends; `test/mail.test.ts` fails if the script grows a
  write, a shell call or an ObjC bridge.
- **Transport**: https is required, except for a server on `localhost`. The token is sent
  only in the `Authorization` header and is never printed.
- **At rest**: `~/.config/opportun-connector/config.json` holds the token, written 0600 in
  a 0700 directory (atomically, so a looser old file is replaced). `state.json` next to it
  holds only the sync cursor.
- **Hostile mail**: messages are reshaped and capped here, not interpreted; the server
  stores and fences them exactly like Gmail mail before any AI sees them.

## Behaviour

- **Cursor**: the received date of the newest message the server accepted. It moves only
  after a 2xx, batch by batch, oldest first, so an interrupted sync resumes without gaps.
  Each sync re-reads five minutes before the cursor; the server upserts on the external id.
- **Unreadable messages**: when Mail fails to return a message (busy, a timeout), the script
  reports its received date and the cursor stays just before it, so the next sync reads it
  again; after three failed syncs it is given up on with a warning, so newer mail is not
  held back. A message without an id or a usable date is skipped for good, also with a
  warning.
- **Batches**: at most 100 messages, 10MB of UTF-8 bodies and 11MB of JSON (the server
  allows 12MB). A 429 waits for `retry-after` (default 60s) and resumes the same batch; a
  5xx or network failure is retried after 2s, 4s and 8s, then the run exits with code 4. A
  413 (not expected, given the client caps) halves the batch; a single refused message is
  skipped with a note so the sync never wedges.
- **Mapping to the server's InboundMessage**: `externalId` is `apple-mail:<Message-ID>`
  (hashed when over 1024 characters), `threadKey` is the subject without Re:/Fwd: prefixes
  (`apple-mail-subject:<subject>`), falling back to the external id when there is no
  subject.

Exit codes: 0 ok, 1 unexpected, 2 config or usage, 3 token rejected or wrong scope,
4 server unreachable or failing, 5 Apple Mail could not be read.

## Development

All I/O (files, fetch, osascript, clock, terminal) goes through `ConnectorIo`
(`src/types.ts`); only `src/nodeIo.ts` touches the real system, so `pnpm test` runs on any
platform. On macOS two extra tests compile the JXA script with `osacompile` and run it
through `osascript` with no mailboxes (which sends Mail no Apple events).
