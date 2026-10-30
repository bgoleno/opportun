# Security Policy

Opportun is designed to hold sensitive personal data (resumes, communications, API
keys) on user-operated servers, so security reports are taken seriously at every
stage of the project, including the current beta.

## Supported versions

| Version                  | Supported                       |
| ------------------------ | ------------------------------- |
| `main` (beta)            | Yes: fixes land on `main`       |
| Any older commit or fork | No: update to the latest `main` |

There are no tagged releases yet. Once releases begin, the latest minor release will
receive security fixes and this table will list it.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub Security Advisories
("Report a vulnerability" on the
[Security tab](https://github.com/bgoleno/opportun/security/advisories/new) of this
repository). Do not open public issues for security problems.

You can expect an acknowledgment within 72 hours. Coordinated disclosure is
appreciated; credit is given in release notes unless you prefer otherwise.

## What the threat model covers

The full security design is [docs/design.md](docs/design.md), section 7. In short:

- **Assets**: credentials and session tokens; AI keys and OAuth tokens; resume content
  and private resume rules; communications; the aggregate picture of a user's search.
- **Adversaries**: internet scanners hitting an exposed instance; a malicious or
  compromised job posting or email (prompt injection, SSRF lures); a stolen database
  file; a careless co-user on a shared install; and, for the device clients, a stolen
  device token.
- **Controls**: Argon2id passwords with an optional pepper; optional TOTP two-factor
  sign-in; hashed, expiring sessions; every query scoped to its user; CSRF tokens for
  the browser and scoped, revocable bearer device tokens for the Apple Mail connector and
  the capture extension (a device token can submit data but cannot enumerate or fetch
  stored records; its responses only acknowledge what was submitted and whether it
  matched an existing record); a strict Content Security Policy; AES-256-GCM encryption of
  stored secrets under a master key kept outside the database; untrusted content fenced in
  AI prompts, including model output derived from it (the tailoring match report is fenced
  as `match_report_untrusted` before it reenters a later prompt), with no AI output
  able to send an application, email or message without your click; an SSRF-safe fetch
  layer (`lib/safeFetch.ts`) for adapter HTTP to job sites, ATS APIs and captured links; the
  AI provider's `openai_compatible` base URL path goes through its own guarded fetch
  (`lib/aiProviderFetch.ts`) instead, checking the same prohibited-host (C-1) and
  private-range rules `safeFetch` enforces, but without connection pinning -- the same
  documented residual as the MCP DNS-rebinding case covered separately below; filesystem
  access confined to the data directory; rate limits on sign-in, password re-confirmation
  and device-token routes, and a per-user AI budget.
- **Assumed trusted**: the host, and whoever administers it. Anyone who controls the
  server process, the `data/` directory and `master.key` can read everything on the
  instance.

## Deliberate deviations

These are known, intentional departures from the requirements' strictest reading, kept
here so a reviewer does not have to rediscover them. (This list covers deliberate
trade-offs only: an unintended gap is tracked as an issue instead, not listed here
since it was not a deliberate choice.)

- **Google Drive scope (NFR-SEC10).** Resume flows request the full
  `https://www.googleapis.com/auth/drive` scope rather than `drive.file`: copying a base
  resume the user created outside the app needs it, and the Content Security Policy rules
  out the Google Picker that `drive.file` would require. Gmail stays read-only
  (`gmail.readonly`). The app explains the Drive request before sending you to Google.
- **LinkedIn official-API carve-out (C-1).** The server never fetches linkedin.com: its
  fetch layer refuses LinkedIn hosts whatever a caller asks. The one exception is sign-in
  with LinkedIn, which calls exactly two official endpoints after the user consents on
  LinkedIn, the token URL (`https://www.linkedin.com/oauth/v2/accessToken`) and the OpenID
  Connect userinfo URL (`https://api.linkedin.com/v2/userinfo`). They are pinned in
  `apps/server/src/lib/safeFetch.ts` (`OFFICIAL_API_URLS`), no redirect is followed, and a
  test pins the list. LinkedIn content otherwise arrives only from the user: their data
  export, or a page they capture with the browser extension.
- **Google OAuth clients in Testing status.** Each instance uses its own Google OAuth
  client, which a self-hoster typically leaves unverified. In Testing status only listed
  test users can consent and Google expires the Drive and Gmail grant after about 7 days
  (the app asks to reconnect); published without verification, consent shows an
  "unverified app" warning. Both are expected for a personal self-hosted client and are
  described in [docs/install.md](docs/install.md#2-quick-start-docker-compose).
- **One Content Security Policy loosening.** The policy is `default-src 'self'` plus
  `img-src 'self' data:`, the latter only so the TOTP enrollment QR code renders.
- **HTTP MCP sources, the AI provider path, and DNS rebinding.** An MCP source reached
  over https (`apps/server/src/lib/mcpClient.ts`'s `checkMcpUrl`), and an
  `openai_compatible` AI provider policy's `baseUrl` reached over https
  (`apps/server/src/lib/aiProviderFetch.ts`'s `checkProviderUrl`), each check the same
  two things before fetching: the host is not on the prohibited list (`isProhibitedHost`,
  which is what keeps the LinkedIn carve-out above intact on both paths), and every
  address its hostname resolves to is public (`isPrivateAddress`). Neither check is
  pinned to the connection, so DNS rebinding past that point is not fully prevented on
  either path: that is the one protection the general-purpose fetch layer has that these
  two paths lack, not an absence of the prohibited-host or private-address checks
  themselves. Both are streaming fetches driven by a third-party client (the MCP SDK's
  transport; the Vercel AI SDK's chat completion), which cannot be handed a pre-resolved,
  pinned address the way the buffered general-purpose fetch layer is. Point an MCP
  source, or an `openai_compatible` endpoint, only at hosts you trust (MCP sources:
  [docs/install.md](docs/install.md#7-configuring-discovery-sources)).
- **AI provider loopback http.** An `openai_compatible` policy's `baseUrl` may use plain
  http to `localhost`, `127.0.0.1` or `[::1]`, a relaxation of the https-only posture
  every other host must meet, for an operator's own local model runtime (Ollama, LM
  Studio). Off by default; an operator turns it on for their own deployment with
  `OPPORTUN_AI_ALLOW_LOOPBACK_HTTP=1`. That allowance matches one of those three literal
  strings an operator typed themselves, never a resolved address, so it carries none of
  the DNS-rebinding exposure described above.
- **Postgres TLS is encrypted but not verified by default.** For a Postgres host that is not
  loopback, `DB_SSL` defaults to `require`: the connection is encrypted, but the server
  certificate chain and hostname are not checked. An attacker positioned on the network
  path to the database could terminate TLS with any certificate and read the credentials
  and every row. `require` is the default because it works against a managed or remote
  database without the operator first provisioning a certificate authority; the strict
  mode would fail to connect to one using a self-signed or private-CA certificate. Set
  `DB_SSL=verify-full` (a private CA goes in `NODE_EXTRA_CA_CERTS`) for any database
  reached over a network you do not control. The shipped `deploy/compose.yml` keeps
  Postgres on the internal compose network, and SQLite has no network database, so
  neither is affected. Loopback and unix-socket hosts default to `disable`.

## Scope notes for self-hosters

- Opportun stores AI provider keys and OAuth tokens encrypted at rest; the master
  key lives outside the database. Protect your `data/` volume and `master.key`.
- Never write an account password to a file for safekeeping, during development or
  otherwise: a note like that tends to outlive the phase that justified it, since
  nobody remembers to go back and delete it once the password it holds is the real
  one in daily use. If you forget a password, including the instance's only
  administrator, the command-line reset
  ([docs/install.md section 6](docs/install.md#6-upgrades-and-backups)) is the
  recovery path: it is the only way to self-reset an administrator account (the
  in-app Settings > Users flow deliberately refuses to), and it prints the new
  password once rather than storing it anywhere.
- The application is designed to sit behind a TLS-terminating reverse proxy. Running
  it in plain HTTP on the public internet is unsupported.
- A lost or stolen device (a Mac running the connector, a browser with the extension):
  revoke its token under Settings > Integrations > Devices; it is refused from its next
  request.
- Feedback on the security design is welcome via normal issues as long as no concrete
  exploitable deployment is involved.
