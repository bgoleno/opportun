# Security Policy

Opportun is designed to hold sensitive personal data (resumes, communications, API
keys) on user-operated servers, so security reports are taken seriously at every
stage of the project, including the current beta.

## Supported versions

| Version                                                                   | Supported                                     |
| ------------------------------------------------------------------------- | --------------------------------------------- |
| The [latest release](https://github.com/bgoleno/opportun/releases/latest) | Yes: it gets security fixes                   |
| `main` (beta)                                                             | Where fixes land first, then in a new release |
| Any older release, commit or fork                                         | No: update to the latest release              |

Only the latest release is supported. When a new release comes out, the one before it stops
getting security fixes. The table names "the latest release" rather than a number, so it does
not change with each release.

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
  the capture extension (what each scope can read is listed under
  [What a device token can read](#what-a-device-token-can-read) below); a strict Content
  Security Policy; AES-256-GCM encryption of
  stored secrets under a master key kept outside the database; untrusted content fenced in
  AI prompts, including model output derived from it (the tailoring match report is fenced
  as `match_report_untrusted` before it reenters a later prompt), with no AI output
  able to send an application, email or message without your click; an SSRF-safe fetch
  layer (`lib/safeFetch.ts`) for adapter HTTP to job sites, ATS APIs and captured links,
  which refuses two lists of hosts whatever a caller asks: LinkedIn (`PROHIBITED_HOSTS`,
  C-1: no automated retrieval at all) and Indeed (`PAGE_FETCH_PROHIBITED_HOSTS`, C-2:
  its pages come only from the user's browser or pasted text); the
  AI provider's `openai_compatible` base URL path goes through its own guarded fetch
  (`lib/aiProviderFetch.ts`) instead, checking the same C-1 prohibited-host and
  private-range rules `safeFetch` enforces (not the Indeed list, which covers only the
  server fetching pages, so an MCP connector or AI endpoint the user configures on an
  Indeed host stays their choice), but without connection pinning -- the same
  documented residual as the MCP DNS-rebinding case covered separately below; filesystem
  access confined to the data directory; rate limits on sign-in, password re-confirmation
  and device-token routes, a per-user share of each job site's request queue (see
  [Requests to job sites, shared fairly](#requests-to-job-sites-shared-fairly)), and a per-user
  AI budget.
- **Assumed trusted**: the host, and whoever administers it. Anyone who controls the
  server process, the `data/` directory and `master.key` can read everything on the
  instance.

### What a device token can read

A device token works only on the routes for its scopes, only on its owner's data, and never
on a route that needs a signed-in session. This is what someone holding a stolen token can
read. A token can hold more than one scope: the extension's Set up flow can create one token
with both `capture:push` and `apply:assist`.

- **`mail:push`** (the Apple Mail connector): nothing stored. It submits messages, and its
  response gives only how many were stored and how many were new. A pushed message can also
  change one record, the same way a message synced from Gmail can: if it matches an application
  the user said they submitted, within 14 days after the submission, and the application is
  marked submitted or has no confirmation seen, that application is marked confirmed by email.
  This belongs to mail ingest and not to the token's scope. The match can rest on the sender's
  address, which Opportun does not verify: it checks no SPF, DKIM or DMARC result. So a forged
  message inside that window can mark an application confirmed if it links the application's job,
  or comes from an address at the company's domain and names the role and company. The message
  itself is stored as a communication, as any ingested message is. The confirmation changes no
  stage and keeps only the message's id and the names of the signals that matched on the
  application, and the user can undo it with **Not this application (unlink)** on the
  application's evidence card, which returns it to submitted.
- **`capture:push`** (the capture extension): no stored content. It submits a captured page,
  and its response says what happened: whether a record was created, the ids of the records
  involved, whether AI refined the capture, and the stage the capture moved an opportunity
  to, if any. It cannot enumerate or fetch records.
- **`apply:assist`** (the capture extension, for assisted apply): stored application data.
  This is the only scope that reads stored records. It is available unless the operator turns
  assisted apply off with `OPPORTUN_SUBMISSIONS=0`. On the demo it is on as well; the
  operator can turn it off for the shared accounts alone with
  `OPPORTUN_DEMO_SHARED_ASSISTED_APPLY=0` (see the deviation on the demo's shared accounts
  below). With it off, this
  scope cannot be created and its routes answer 404 whatever a token's scopes, so the two
  scopes above are all a device token can do. With it on, a token with this scope can:
  - read the application handed off to a posting it names: the field values and answers the
    user reviewed, the role title, company and destination, and the resume copy;
  - look up an application from a page on the same ATS board: the id, role title and company
    of one the user said they submitted, or otherwise a reason code, which can show that an
    application exists there (10 lookups per token per 15 minutes);
  - record a confirmation page for an application the user said they submitted, which adds
    the page's text to the timeline and marks the application confirmed.

  It cannot list applications, and it cannot start, review or hand off an application or
  record "I submitted it". Its routes share a limit of 60 requests per token per 15 minutes.

### Passwords, sessions and linked sign-in providers

A password change and a password reset are how a user, or the administrator, cuts off someone
who has a credential they should not have.

- **A password change** ends every session of the account, the device it was made on included,
  which gets a fresh session in the same step. Settings also offers to revoke every device token
  at once, checked by default. The revocation commits together with the new password, or not at
  all.
- **A password reset** (the administrator's Settings > Users, or the command-line reset) sets a
  temporary password and shows it once. It also ends every session, revokes every device token,
  unlinks every sign-in provider (Google, GitHub, LinkedIn) and turns two-factor sign-in off. The
  provider unlinking includes one that someone else linked, since a reset is also compromise
  recovery. The user links their providers again afterwards.
- **A credential that rests on a check made a moment earlier** is written only if that check
  still holds when the credential is written:
  - a session or pending two-factor token after a password sign-in;
  - a session after the two-factor code;
  - a device token after its password re-confirmation;
  - a session after a provider sign-in;
  - a new provider link.

  Each is written under a per-user lock that a change and a reset also take, and only while the
  password hash it was checked against, the pending token, the provider link or the session it
  started from is still there. So a change or reset that lands during the check wins and nothing
  is written, and one that starts just after removes what was written along with everything else
  (`apps/server/src/lib/passwordLock.ts`).

What this does not do: it cannot undo what a credential was used for before the change or
reset, and it does not sign anyone out of the Google, GitHub or LinkedIn account itself. Those are
the user's to secure with that provider.

### Requests to job sites, shared fairly

Requests the server makes through its fetch layer (`apps/server/src/lib/safeFetch.ts`) to a job
board, an ATS or any other site go through one queue per host, at most one request per second.

- **Each user gets a share.** A user's requests may hold at most `RATE_KEY_SLOTS` (3) of a host's
  slots ahead at once, and their other requests wait for one of their own to free up. So one
  user's large discovery run cannot push everyone else's requests to that host far behind.
  Requests made for the server itself, not for one user, share a key of their own.
- **A local wait is not the vendor's answer.** A request whose deadline passes while it waits in
  that queue fails as `rate_wait`, which is never counted as the vendor failing or asking to slow
  down.
- **One user cannot stop a vendor for everyone indefinitely.** In the nightly check of a network's
  boards, one user's failing companies can stop a vendor for every user at most once in
  `NETWORK_PROBE_USER_STOP_NIGHTS` (7) nights (`apps/server/src/jobs/networkBoardProbe.ts`). Past
  that, such a failure ends only that user's night.

This is fairness between the users of one instance, not a protection against the vendor's own
limits. The queue is per process, like the rest of the instance (one server process per
database, as [docs/install.md](docs/install.md) requires).

### What your AI provider keeps: ranking batches

Batch ranking sends postings to the AI provider's batch service many at a time, instead of one
live call each. It is off unless the user's own setting turns it on, and Settings does not offer
that setting yet (`apps/server/src/repos/rankBatches.ts`).

- **What it sends** is what a live ranking call sends: each posting's text, and the ranking
  prompt with the user's role target.
- **How it is sent:** with the AI key that user's ranking uses, through the same checked
  provider path as every AI call (`apps/server/src/lib/aiProviderFetch.ts`, described under the
  deviations below). The key goes only in its request header, never in an error, log or trace.
- **Which providers:** Anthropic's Message Batches, and OpenAI's Batch API with its files.
  OpenAI batches are made only against OpenAI's own API. With an operator's `OPENAI_BASE_URL`
  pointing elsewhere, ranking stays live (`packages/ai/src/openaiBatch.ts`).
- **What the provider keeps:** the batch and its results, until Opportun has applied the results.
  Then a job of its own deletes the provider's copy: the Anthropic batch, or the OpenAI files of
  requests and results. If the provider refuses, the job tries again for a while.
- **When that delete never runs,** the copy stays until the provider's own retention ends.
  [docs/guide/discovery.md](docs/guide/discovery.md#where-a-ranking-batchs-text-sits) gives the
  figures; cases where the delete can be lost are tracked in
  [#686](https://github.com/bgoleno/opportun/issues/686).

The provider's own policy for data sent through its API applies as it does to every AI call.

### Kept AI results: the referral ranking

The Referrals tab's ranking of who could refer the user, with the AI's one-line reason for each
contact, is kept per user and opportunity, so reopening the tab does not make another AI call
(`apps/server/src/routes/referrals.ts`, table `referral_rankings`).

- It is read only for its owner, and only for an opportunity that is theirs.
- It is reused only while the AI's input is exactly the same: a hash of the contacts' lines and
  the opportunity text. Any change to either means a fresh ranking, which replaces the kept one.
  **Re-rank** asks for one at any time.
- A kept ranking is filtered to the contacts in the current set before it is shown.
- It is deleted with the user or the opportunity, and it is left out of exports as derived data
  (`apps/server/src/lib/exporter.ts`).

What this does not do yet: when a contact is deleted, the kept row for an opportunity still holds
that contact's reason until the opportunity is ranked again. It is never shown, but it is still
stored. That is tracked in [#694](https://github.com/bgoleno/opportun/issues/694).

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
  over https (`apps/server/src/lib/mcpClient.ts`'s `checkMcpUrl`), and every AI provider
  request reached over https, an `openai_compatible` policy's `baseUrl` as well as Anthropic
  and OpenAI (`apps/server/src/lib/aiProviderFetch.ts`'s `checkProviderUrl`), each check the same
  two things before fetching: the host is not on the C-1 prohibited list (`isProhibitedHost`,
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
- **The operator's own AI provider base URL.** The origin of `ANTHROPIC_BASE_URL` or
  `OPENAI_BASE_URL`, when the operator sets one, skips the https and public-address checks of
  the AI provider path, so a proxy on the compose network or a private gateway keeps working
  (https://github.com/bgoleno/opportun/issues/344, decision 40). Both are environment
  variables of the server process, which no user can set, and the server sends every Anthropic
  or OpenAI call, key checks included, there. A URL with credentials in it is still refused, and redirects are
  still not followed. Any other origin, a user's own `openai_compatible` `baseUrl` among them,
  is checked as before.
- **Assisted apply on the demo's shared accounts.** The public demo runs assisted apply on
  its five shared logins (`demo-admin`, `demo-user1` to `demo-user4`), so everyone the owner
  invites signs in to the same accounts, and visitors on one account can see and disturb each
  other's applications until the nightly reset. The owner accepted this, with these limits
  enforced by the server
  ([#542](https://github.com/bgoleno/opportun/issues/542), [#545](https://github.com/bgoleno/opportun/issues/545)): a draft starts empty, and nothing is saved to the shared
  profile, an application carries no resume (the visitor attaches their own on the employer's
  form), and a value that came with the demo is refused. Each application is bound to the
  visitor (the session) that started it. Everyone on the account can read it, and any visitor
  can cancel it. Only that visitor can change, review or hand it off, and only that visitor's
  device token is given it. What stays shared: editing an opportunity's posting address sends
  a reviewed application on it back to draft, deleting the opportunity removes its
  applications, and a `mail:push` confirmation can match any application on the account. A
  shared account keeps at most 20 active device tokens (`OPPORTUN_DEMO_TOKEN_CAP`), the
  oldest revoked when another is made, which can sign another visitor's extension out. Every
  scope can be minted there, `mail:push` included, so mail one visitor connects can be read by
  everyone on the account, behind the same warning as everything else entered there. Any
  visitor can also revoke any of the account's device tokens from Settings, not only through
  the cap, and can change the account's password, which ends every visitor's session. The
  nightly reset removes the accounts' tokens, applications and stored files. Opportun still
  never submits an application. An account made for one person on a demo server behaves as on
  any other instance, and `OPPORTUN_DEMO_SHARED_ASSISTED_APPLY=0` turns the feature off for
  the shared accounts only. The operator's settings are in
  [docs/demo-deployment.md](docs/demo-deployment.md#device-tokens-and-assisted-apply-on-the-demo).

  The nightly reset deletes the shared accounts and reseeds them under the same ids, so a write
  that began before it could land in the fresh accounts. A gate keeps the two apart
  (`apps/server/src/lib/demoResetGate.ts`, `apps/server/src/plugins/demoResetHold.ts`):

  - every signed-in request, and every job that may reach those accounts, holds it while it runs;
  - the reset waits for them, at most a minute, and resets nothing if some are still in;
  - a request that arrives meanwhile waits, and then finds its session or token gone.

  So that no single request or job holds the reset off:

  - a request's body must arrive within 20 seconds;
  - an AI call ends after 40 seconds;
  - no hold lasts more than 50 seconds.

  What it does not close: work that keeps running past its hold, such as a handler whose AI call
  is still in flight when its request is ended, can still write after the reset into the
  reseeded account. That write is the visitor's own, into an account every visitor can write to
  anyway. It is tracked in [#684](https://github.com/bgoleno/opportun/issues/684). A seed run by
  hand, and more than one server process on the database, are outside the gate. The details are
  in docs/demo-deployment.md, under "Nothing that began before the reset writes after it".

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
  revoke its token under Settings > Integrations > Extensions and Connectors; it is refused
  from its next request.
- Feedback on the security design is welcome via normal issues as long as no concrete
  exploitable deployment is involved.
