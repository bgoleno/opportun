# Installing Opportun

Opportun runs as one container (Node.js, SQLite) behind a Caddy reverse proxy. The quick
start in section 2 is exercised by CI against `deploy/compose.yml`. Postgres 16 is an
optional, beta alternative to SQLite ([section 15](#15-postgres-optional-beta)).

Contents:

1. [Requirements](#1-requirements)
2. [Quick start (Docker Compose)](#2-quick-start-docker-compose)
   - [2.1 Reaching it from another device](#21-reaching-it-from-another-device)
3. [Exposing to the internet](#3-exposing-to-the-internet)
4. [Configuration reference](#4-configuration-reference)
5. [Running from source (development)](#5-running-from-source-development)
6. [Upgrades and backups](#6-upgrades-and-backups)
7. [Configuring discovery sources](#7-configuring-discovery-sources)
8. [Attaching a posting to an opportunity](#8-attaching-a-posting-to-an-opportunity)
9. [Reactive Resume (optional, instead of Google Docs)](#9-reactive-resume-optional-instead-of-google-docs)
10. [Capture extension (LinkedIn)](#10-capture-extension-linkedin)
11. [Apple Mail (macOS)](#11-apple-mail-macos)
12. [Users and registration](#12-users-and-registration)
13. [Two-factor sign-in](#13-two-factor-sign-in)
14. [Sign-in with Google, GitHub or LinkedIn](#14-sign-in-with-google-github-or-linkedin)
15. [Postgres (optional, beta)](#15-postgres-optional-beta)

## 1. Requirements

- A Linux server or a Mac, with Docker and Docker Compose v2.20 or newer (recommended), or
  bare Node.js 22+ with pnpm 9.
- 1 vCPU and 512 MB RAM are enough for a single user.
- A domain name if you expose the app to the internet (HTTPS is required then).

## 2. Quick start (Docker Compose)

By default the image is built locally from the repository. A prebuilt image is also published
at `ghcr.io/bgoleno/opportun` (public, no login, `linux/amd64` only): to use it instead, add
`OPPORTUN_IMAGE=ghcr.io/bgoleno/opportun:latest` to `.env` and replace the last command below
with `docker compose up -d`, without `--build`, which would force a local build regardless.
Compose then pulls the image and builds nothing. `latest` follows `main`; pin a `sha-...` tag
from the [package page](https://github.com/users/bgoleno/packages/container/package/opportun)
to upgrade only when you choose. On Apple Silicon the published image runs under emulation, so
building locally is faster there.

```bash
git clone https://github.com/bgoleno/opportun.git
cd opportun/deploy
cp ../.env.example .env
# Uncomment and set COMPOSE_PROJECT_NAME in .env before going further. A compose project
# name is a global namespace on the Docker host: every container, network and named volume
# this deployment creates is reachable by that name alone, from any other checkout or
# directory on the same machine, with no flag required. Leaving it commented out still
# works (compose.yml's own fallback name is used), but setting it here is what makes this
# deployment's containers and volumes identifiable as yours, rather than a generic unnamed
# checkout, and is required if this is a deployment that already existed before
# COMPOSE_PROJECT_NAME did: see .env.example's own comment above that setting (issue #203).
# The master key encrypts stored secrets (AI keys, OAuth tokens). Keep a copy somewhere
# safe: losing it makes those secrets unreadable.
mkdir -p data && (umask 077; openssl rand -hex 32 > data/master.key)
# Linux only: the container runs as uid 10001 and must own its data directory.
# (Docker Desktop on a Mac maps ownership for you; skip this there.)
sudo chown -R 10001:10001 data
docker compose up -d --build
```

Then open `http://localhost:8080` (from another device on your network, see
[section 2.1](#21-reaching-it-from-another-device)), create the first account (it becomes the admin;
registration closes automatically afterward, and an admin can reopen it, see
[section 12](#12-users-and-registration)), and walk through setup:

1. **AI provider**: paste an Anthropic or OpenAI API key (or point at any
   OpenAI-compatible endpoint, such as a local Ollama server). Keys are encrypted at
   rest with your master key. An Anthropic key must be scoped to a workspace, or be a
   user key mapped to a default workspace: an organization-scoped key authenticates but
   every model call fails with a workspace error. Each key is validated when you add it,
   and the per-model results on the key row explain any failure.
2. **Google** (for resume and Gmail flows): create your own Google Cloud OAuth client,
   so no third party ever holds your tokens. Google offers no API for this, so
   Settings > Integrations has a guided setup that deep-links each page of the
   [Google Cloud console](https://console.cloud.google.com/auth/clients/create) (see also
   [Google's help](https://support.google.com/cloud/answer/6158849)) and shows the exact
   values to copy. The same steps:

   0. **Account**: sign in with the Google account whose Drive holds your resumes and
      whose Gmail you will connect. With several accounts signed in, check the avatar on
      every console page; use the same account throughout, including at consent.
   1. **Project**: create one, or use an existing one. At the project limit, pick an
      existing one in the
      [project selector](https://console.cloud.google.com/projectselector2/home/dashboard).
   2. **APIs**: enable the
      [Drive](https://console.cloud.google.com/apis/library/drive.googleapis.com) and
      [Docs](https://console.cloud.google.com/apis/library/docs.googleapis.com) APIs for
      resumes, and the [Gmail API](https://console.cloud.google.com/apis/library/gmail.googleapis.com)
      for inbox sync (it can wait). Skipping this fails later with 403 accessNotConfigured.
   3. **Branding**: App name (Opportun or anything), User support email and Developer
      contact email (yours). Everything else stays default.
   4. **Audience**: when Google's setup wizard asks (right after App Information), choose
      External and Next (Internal only works inside a Google Workspace organization). The
      Test users list is not in that wizard: after finishing it, open
      [Audience](https://console.cloud.google.com/auth/audience) again from the left menu
      to reach the full page with Publishing status and Test users. Stay in Testing, and
      add yourself (the step 0 account) as a test
      user, or consent fails with access_denied. In Testing, Google expires the grant after
      about 7 days and the app asks you to reconnect; once everything works, set Publish
      status to In production. Consent then shows an "unverified app" warning (Advanced,
      then Continue), expected for a personal self-hosted app, and the grant stops expiring.
   5. **Client**: first check the project chip at the top of the console matches the step 1
      project; the console links open in whatever project was last selected, and a client
      created in the wrong project validates and connects but fails later with disabled-API
      errors. Then: type Web application, with the JavaScript origin the app shows and BOTH
      redirect URIs it shows: the Connect one (`/api/v1/integrations/google/callback`) and
      the sign-in one (`/api/v1/auth/oauth/google/callback`). Sign in with Google and account
      linking reuse this client and fail with redirect_uri_mismatch without the second. Leave "Use this client for an AI-powered agent" unchecked if offered: Opportun
      is a standard web app client (its AI never calls Google APIs directly) and the
      designation cannot be changed after creation. If you also browse the app at another
      address (like http://localhost:8080), you may add that origin and its
      /api/v1/integrations/google/callback as extra entries; Google matches them exactly,
      port included. The Connect flow always uses the base-URL values the app shows,
      whatever address your browser is on, so run Connect from that base URL.
      Google shows the Client ID and secret once: copy both (or download the JSON).
      A lost secret is replaced by adding a new one on the client's page.
   6. **Save** both in the app. They are checked with Google immediately: Valid, Invalid
      (with the fix) or Unverified (retry later).
   7. **Connect**: pick the step 0 account, click Advanced, then Go to Opportun on the
      unverified-app screen, and allow the permissions.

   Troubleshooting: redirect_uri_mismatch means the console URI differs from the copy
   value (scheme and path included); access_denied means you are not a test user or chose
   another account; accessNotConfigured means an API from step 2 is not enabled;
   invalid_client means re-copy both values from the same client.

   Each feature asks for its own grant when you first use it: Drive and Docs for
   resumes (Drive is broad because copying a base resume made outside the app needs
   it; the screen explains this), Gmail read-only for the inbox.

3. **Profile and role targets**: who you are and what you are looking for.
4. **Import** (optional): bring existing activity in from a CSV or a zip pack (CSV plus
   Markdown notes) under Settings > Import/Export.

Durable state lives in two places: `deploy/data` (mounted at `/data`), holding
`attachments/`, `backups/`, `exports/` and `master.key`, and a separate named volume
holding `opportun.db` alone (see [section 6](#6-upgrades-and-backups) for why). Copying
`deploy/data` directly is safe; the database is backed up separately, via automatic
nightly snapshots (SQLite `VACUUM INTO`, see below).

The container runs as a non-root user with a read-only root filesystem, no Linux
capabilities and `no-new-privileges`; only `/data` and a `/tmp` tmpfs are writable. Its
health is reported by `GET /healthz`
(`{"status":"ok","db":"ok","queueLagMs":0,"databaseIntegrity":null}`), which the image's
`HEALTHCHECK` and `docker compose ps` use — but only the HTTP status code: both only see
"healthy" or not, never the body. `status` is `"degraded"` (HTTP 503) when the database
itself cannot be reached, the one case restarting the container could plausibly help.
`databaseIntegrity` carries the most recent scheduled integrity check (SQLite; see
[section 6](#6-upgrades-and-backups) and section 15's engine comparison below for why
Postgres has none), `null` before the first one has run. A known-corrupt database reports
`status: "corrupted"` here — deliberately still HTTP 200, since restarting does not repair
a corrupt file on disk and the server keeps answering most requests correctly regardless
(only the specific damaged rows are affected). `docker compose ps` and the image's own
`HEALTHCHECK` will show this instance as healthy throughout: checking for `"corrupted"`
needs reading the response body, which is also what `GET /api/v1/backups` (Settings >
Import/Export) shows on the same information. Point an external monitor at the body, not
just the status code, if you want to be paged for this.

## 2.1 Reaching it from another device

The common setup is one machine running Opportun and everyone else using it from a phone,
a tablet or their own computer on the same network. Which of the two sections below applies
depends on which path you installed with.

**Docker Compose** works out of the box: Caddy answers on every interface of the host, so
from any device on your network open

```
http://<the-machine>:8080
```

where `<the-machine>` is the host's name on your network, or its IP address. On a Mac that
name is `<hostname>.local` (Bonjour); on Linux the same `.local` form works only if the
distribution runs Avahi (common on desktop installs, not guaranteed on a minimal server), so
no single name is guaranteed to work on every router. The IP address always works: find it
with `ip addr` or `hostname -I` on the host, or in your router's list of connected devices.
The machine running Opportun can also use `http://localhost:8080`.

If a device cannot connect:

- Check `OPPORTUN_BIND_ADDRESS` in `deploy/.env`. `0.0.0.0` answers on every interface;
  `127.0.0.1` answers only on the machine itself. After changing it run
  `docker compose up -d` (not `restart`: published ports are fixed when a container is
  created).
- Check the host's firewall. On macOS, allow incoming connections for Docker; on Linux,
  open the port in `ufw` or `firewalld`.

**Running from source** ([section 5](#5-running-from-source-development)) needs one step
Compose does not, because nothing sits in front of the server process here: `OPPORTUN_HOST`
defaults to `127.0.0.1`, loopback only, so it has to be widened before any other device can
reach it at all.

```
OPPORTUN_HOST=0.0.0.0 OPPORTUN_MASTER_KEY=... OPPORTUN_BASE_URL=http://localhost:3000 pnpm start
```

`0.0.0.0` answers on every interface the machine has, not just the LAN (VM bridges and VPN
interfaces included); a specific LAN or Tailscale address is narrower if that distinction
matters to you. Once it is listening, reach it the same way as Compose, on the server's own
port (`3000` by default, not `8080`): `http://<the-machine>.local:3000` or the machine's LAN
IP from another device, `http://localhost:3000` on the host itself. The server logs which
address it bound to at startup, and says so plainly when that address is loopback-only
("listening on localhost only: this instance cannot be reached from another device").

If a device still cannot connect once `OPPORTUN_HOST` is set, check the host's firewall:
macOS's own Application Firewall asks the first time `node` tries to accept an incoming
connection ("Do you want the application `node` to accept incoming network connections?").
Allow it, or allow it ahead of time under System Settings, Network, Firewall, Options.

Whichever path you installed with, `OPPORTUN_BASE_URL` stays `http://localhost:<port>` even
when you browse from another device. It is what Google's OAuth redirect is built from, and
Google rejects every non-HTTPS address except localhost, so changing it to the machine's
name would break connecting Google. One consequence, not a limitation Opportun can remove:
connect Google once from a browser on the machine running Opportun.

What a plain-HTTP network setup costs, stated plainly: session cookies and device tokens
travel your network unencrypted, so anyone on it could read them. On a home network that is
usually an acceptable trade for not having to run a certificate authority. On a shared,
public or office network, give it a domain and TLS (section 3) instead.

**TLS on your LAN, if you want it anyway.** A `.local` name can never hold a
publicly-trusted certificate: `.local` is a reserved mDNS namespace and public certificate
authorities may not issue for it, so `https://<the-machine>.local` does not exist at any
price, on either deployment path. The realistic routes to real TLS on a private network are
a VPN that provisions certificates for its own namespace (Tailscale's `*.ts.net` is the
common case), or a domain you own, validated by a DNS-01 challenge: a Caddy build carrying
that DNS provider's plugin plus an API token, not the default Caddy image this repo ships.
Each excludes someone: a VPN needs an account and its client installed on every device; a
domain costs money and setup. For a household network with nothing exposed beyond it,
plain HTTP has no cheaper equivalent.

## 3. Exposing to the internet

Caddy (in the same compose file) terminates TLS and obtains certificates automatically
once you give it a domain. Point the domain's DNS at the host, then in `deploy/.env`:

```
OPPORTUN_DOMAIN=jobs.example.com
OPPORTUN_BASE_URL=https://jobs.example.com
OPPORTUN_BIND_ADDRESS=0.0.0.0
OPPORTUN_HTTP_PORT=80
```

and run `docker compose up -d` again. Without `OPPORTUN_DOMAIN` Caddy serves plain HTTP,
on every interface of the host by default, which is what lets other devices on your own
network reach it (see [section 2.1](#21-reaching-it-from-another-device)); it is not on the
internet until you point a domain at it. A server run directly (outside Docker) is
different: it binds `127.0.0.1` by default, so exposure there is opt-in through
`OPPORTUN_HOST`, ideally behind Caddy for HTTPS. Opportun sets HSTS (over HTTPS), a strict Content Security
Policy, and rate limits on authentication routes; registration is closed after the
first account by default. Still, treat it like any personal service: keep the host
patched and prefer a VPN or IP allowlist when you do not need public reachability.

When Opportun runs behind a reverse proxy, it reads the client's real address and scheme from
`X-Forwarded-For` / `X-Forwarded-Proto` only for the proxies you list in
`OPPORTUN_TRUSTED_PROXIES` (issue #333); it trusts none by default, so an install reached
directly cannot be handed a false client address. The Compose deployment sets this for you to
cover Caddy (the pinned compose subnet in `deploy/compose.yml`), so you need it only when
you put your own proxy in front of a from-source run: set it to that proxy's IP or CIDR. Leaving
it unset behind a proxy is safe but degraded: every request appears to come from the proxy, so
the per-IP rate limits collapse to one bucket and, over HTTPS, cookies are not marked Secure.

## 4. Configuration reference

Application settings (read by the server process):

| Variable                                           | Default                                        | Purpose                                                                                                                                                                        |
| -------------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `OPPORTUN_MASTER_KEY` / `OPPORTUN_MASTER_KEY_FILE` | (required)                                     | 32-byte key as 64 hex characters, inline or in a file; compose uses `/data/master.key`                                                                                         |
| `OPPORTUN_BASE_URL`                                | (required)                                     | Public URL, used for cookies (Secure over HTTPS) and OAuth callbacks; compose defaults it to `http://localhost:8080`                                                           |
| `PORT`                                             | `3000` (`8080` in the image)                   | HTTP listen port                                                                                                                                                               |
| `OPPORTUN_HOST`                                    | `127.0.0.1` (`0.0.0.0` in the image)           | Interface to listen on; loopback by default, set `0.0.0.0` or an interface IP to expose a bare run on the network                                                              |
| `OPPORTUN_TRUSTED_PROXIES`                         | (empty: trust no proxy)                        | Reverse proxies whose `X-Forwarded-For`/`-Proto` are trusted (comma-separated IPs, CIDRs, or loopback/linklocal/uniquelocal); compose sets it to the Caddy subnet (issue #333) |
| `DATA_DIR`                                         | `./data` (`/data` in the image)                | Attachments, backups, exports, `master.key`                                                                                                                                    |
| `SQLITE_DIR`                                       | `DATA_DIR` (`/sqlite` in the image)            | `opportun.db` alone, on SQLite; see [section 6](#6-upgrades-and-backups) for why it is separate and how moving to it is handled                                                |
| `LOG_LEVEL`                                        | `info`                                         | pino log level                                                                                                                                                                 |
| `WEB_DIR`                                          | `apps/web/dist` (`/app/web/dist` in the image) | Built web app to serve; the API runs alone when it is missing                                                                                                                  |
| `SMTP_URL`                                         | (unset)                                        | Reserved for email password reset, which is not implemented yet                                                                                                                |
| `OPPORTUN_PEPPER`                                  | (unset)                                        | Optional password pepper, at least 16 characters; rotatable, see below                                                                                                         |
| `DB_DIALECT`                                       | `sqlite`                                       | Database engine: `sqlite` (in `SQLITE_DIR`) or `postgres` (beta, [section 15](#15-postgres-optional-beta))                                                                     |
| `DATABASE_URL` / `DATABASE_URL_FILE`               | (required for `postgres`)                      | `postgres://user:password@host:5432/db`, inline or in a file; never logged                                                                                                     |
| `DB_POOL_MAX`                                      | `10`                                           | Postgres connection pool size                                                                                                                                                  |
| `DB_SSL`                                           | `disable` for localhost, else `require`        | Postgres TLS: `disable`, `require` (encrypted) or `verify-full` (certificate and host checked); `sslmode` in the URL is honored when unset                                     |
| `OPPORTUN_DEMO`                                    | (unset)                                        | `1` declares this deployment the invitation-only demo instance; see **Demo mode** below                                                                                        |

**Password pepper.** `OPPORTUN_PEPPER` is an extra secret mixed into every password hash
(Argon2id's keyed `secret` input), so a stolen database file alone cannot be used to
guess passwords. Keep it outside the database, like the master key (for example
`openssl rand -hex 32` into the server's environment). Accounts created before you set
it keep working: each one is re-hashed with the pepper the next time its owner signs in.
**Removing the pepper still breaks every peppered hash**, and the only way back in is a
password reset per account. Pass the same value to the reset CLI (it reads
`OPPORTUN_PEPPER` from its environment). On a Compose deployment, set it in `deploy/.env`,
which is outside the `data/` volume; make sure every later `docker compose up -d` runs
against a compose file that passes it through, or the server comes back up with no pepper
and the peppered hashes stop verifying.

**Rotating the pepper.** Each hash records which pepper version made it, so a pepper can be
replaced without locking anyone out:

1. Keep the old secret under its version number: `OPPORTUN_PEPPER_V1=<the old pepper>`.
2. Put the new secret in `OPPORTUN_PEPPER` and bump `OPPORTUN_PEPPER_VERSION=2`.
3. Restart. Existing accounts verify against the old pepper and are re-hashed with the new
   one the next time each owner signs in.
4. Check Settings, Users (as an admin): a "Password pepper" card names any account that has
   not signed in since the rotation. Once it reports none, `OPPORTUN_PEPPER_V1` can be
   dropped. Until then, removing it locks out whoever is still listed there.

An account that is never signing in again (someone who left, or one used only once) will sit
on that list forever if you just wait. Two ways to actually resolve it: reset its password
from that same page, which rehashes it onto the current version immediately, without the
owner signing in (hand over the new temporary password to pull the account forward, or do not
hand it over to retire it); or drop `OPPORTUN_PEPPER_V1` anyway and accept that it locks that
account out, an explicit choice instead of carrying both secrets indefinitely.

The server refuses to start if you bump the version without supplying the previous secret,
because that would strand every existing hash. Hashes written before version stamping
existed carry no version; they are tried against each known pepper and then against none,
and are stamped on the first successful sign-in.

**Postgres (beta).** SQLite is the default and needs nothing else. Postgres 16 is
supported as an alternative (search, backups and every server test run on both engines in
CI); see [section 15](#15-postgres-optional-beta) for when it is worth it, the compose
profile, and moving existing data. `DATA_DIR` stays required on Postgres: attachments,
backups, exports and `master.key` live on disk.

**Demo mode (issue #280).** `OPPORTUN_DEMO=1` is only a declaration of intent; it does not
by itself seed or reset anything. The actual data comes from `cli/seedDemo.ts`, run once by
hand to create the five invitation-only accounts, after setting
`OPPORTUN_DEMO_ADMIN_PASSWORD`, `OPPORTUN_DEMO_USER1_PASSWORD` through `..._USER4_PASSWORD`,
and `OPPORTUN_DEMO_AI_KEY` (the AI provider key installed for each of the five accounts) in
the deployment's own `.env`, never in the repository. With `OPPORTUN_DEMO=1` set, the server
also schedules a nightly job at 04:30 that re-runs the same seeder, discarding whatever the
day's visitors changed. What actually bounds that job to the demo's own five accounts is not
the flag: it is that those five account ids are fixed and do not exist on a real database, so
the same job registered on a real deployment by mistake would find nothing to delete. The
flag only decides whether the job is scheduled at all, so a real deployment's Settings, Jobs
page has no reason to show it.

Compose settings (`deploy/.env`, see `.env.example`):

| Variable                                     | Default        | Purpose                                                                   |
| -------------------------------------------- | -------------- | ------------------------------------------------------------------------- |
| `OPPORTUN_DOMAIN`                            | (empty)        | Domain for automatic HTTPS; empty serves plain HTTP                       |
| `OPPORTUN_BIND_ADDRESS`                      | `0.0.0.0`      | Host addresses Caddy answers on; `127.0.0.1` restricts it to this machine |
| `OPPORTUN_HTTP_PORT` / `OPPORTUN_HTTPS_PORT` | `8080` / `443` | Host ports for Caddy                                                      |
| `COMPOSE_PROFILES`                           | (empty)        | `postgres` starts the bundled Postgres 16 service                         |
| `POSTGRES_PASSWORD`                          | (empty)        | Password of the bundled Postgres service                                  |

## 5. Running from source (development)

```bash
git clone https://github.com/bgoleno/opportun.git
cd opportun
corepack enable && pnpm install
pnpm dev        # API on :8080, web app with hot reload on http://localhost:5173
pnpm test       # unit and integration tests
pnpm --filter @opportun/web exec playwright install chromium   # once
pnpm --filter @opportun/web e2e   # end-to-end tests (builds the web app; AI and Google are faked)
```

`pnpm dev` generates a development master key under `apps/server/data/dev`. To run the
production server without Docker: `pnpm --filter @opportun/web build`, then
`OPPORTUN_MASTER_KEY=... OPPORTUN_BASE_URL=http://localhost:3000 pnpm start`. Never rebuild
the web app under a running server without restarting it afterwards (see the bare-node
upgrade in [section 6](#6-upgrades-and-backups)).

## 6. Upgrades and backups

### CLI tools at a glance

Four small CLI tools exist for this. Each is documented in full where the scenario it
belongs to is explained, but that means finding the right one requires already knowing
which situation you are in, which is usually the moment something has gone wrong. This is
the whole list, for when you just need the name:

| Tool                | Use it to                                                    | Explained in                             |
| ------------------- | ------------------------------------------------------------ | ---------------------------------------- |
| `backup.ts`         | Take a snapshot by hand, for example right before an upgrade | "Back up first," below                   |
| `restore.ts`        | Replace the live database with a snapshot                    | "Restore," below                         |
| `resetPassword.ts`  | Recover an account whose password or two-factor is lost      | "Lost password," below                   |
| `copyToPostgres.ts` | Move an existing SQLite installation onto Postgres           | [section 15](#15-postgres-optional-beta) |

All four are run the same way: `docker compose exec opportun node --import tsx
src/cli/<tool>.ts ...` under compose, or `node --import tsx src/cli/<tool>.ts ...` from
source in `apps/server`, each with the same environment (`DATA_DIR`, `SQLITE_DIR`, and
either SQLite or `DB_DIALECT=postgres` plus `DATABASE_URL`) as the server itself uses.

Which of the bullets below apply to your own deployment depends on that same `DB_DIALECT`
([section 4](#4-configuration-reference)): unset or `sqlite` is the default engine and the
plain **Backup** and **Restore** bullets cover it; `postgres` is covered by the bullets
marked **on Postgres** instead.

- **Back up first.** Take a snapshot you know is good before every upgrade, not one
  assumed to be: `docker compose exec opportun node --import tsx src/cli/backup.ts` (from
  source, in `apps/server`: `node --import tsx src/cli/backup.ts`, with the same
  `DATA_DIR` and `SQLITE_DIR`, or `DB_DIALECT=postgres` plus `DATABASE_URL`, as the server
  itself uses). It
  calls the same mechanism as the nightly job and **Back up now** under Settings →
  Import/Export (`VACUUM INTO` on SQLite, `pg_dump` on Postgres), prints the snapshot it
  wrote, and exits nonzero if the backup itself failed, so a pre-upgrade script can check
  rather than assume it worked. **Do not substitute a plain file copy of a live database
  for this**: see "Backup," below, for exactly why that fails silently.
- **Upgrade**: `git pull && docker compose up -d --build` (in `deploy/`). Database
  migrations run automatically on boot under a database-wide lock, so an overlapping
  old and new container cannot both apply them; the app refuses to start against a
  database migrated by a newer release than itself.
- **Upgrade without Docker** (bare Node.js, section 5): `git pull`, `pnpm install`,
  `pnpm --filter @opportun/web build`, and then **restart the server**. The restart is
  part of the upgrade, not a precaution. The server routes the files it finds in the web
  build once, at startup, and never consults the filesystem for a request path after
  that. A rebuild gives every bundle a new content-hashed name, so a server still running
  from before it serves the new `index.html` (which is read from disk per request) naming
  bundles it never routed: every script comes back as a JSON 404, nothing runs, and the
  page is blank with no error on screen. The server log is the one place it shows, as
  `no route for this asset ... restart the server`. Restart it however you started it: stop
  and rerun `pnpm start`, or for a launchd agent
  `launchctl kickstart -k gui/$(id -u)/<its label>`. Compose is immune to this, because
  the image carries its own copy of `apps/web/dist` and nothing can replace it under the
  running container.
- **Known risk: SQLite on a Docker Desktop for Mac bind mount.** A bind mount of a host
  directory (`./data:/data`, `deploy/compose.yml`) is how the database has been served so
  far. On Docker Desktop for macOS, that host-to-container bridge (osxfs, gRPC-FUSE or
  VirtioFS, depending on your Docker Desktop version) has a documented history of not
  reliably implementing the file locking and shared-memory coordination SQLite's WAL mode
  depends on across processes, which can corrupt the database file over time. This is
  invisible by default: SQLite only reads the pages a query actually touches, so a damaged
  file keeps answering requests normally until a request happens to need the damaged part.
  A daily integrity check now surfaces it automatically (see the nightly job's own
  schedule); to ask by hand at any time, `sqlite3 <wherever opportun.db lives>
'PRAGMA integrity_check;'` should print exactly `ok`, and the same command against any
  backup file is how you check whether that copy is trustworthy.

  The database's home has moved to a named Docker volume (below), which keeps SQLite off
  the specific filesystem bridge implicated and removes the risk rather than only watching
  for it. Attachments, backups, exports and the master key stay on the host bind mount
  (NFR-OPS3): they carry no equivalent locking requirement, so the "it's just a directory
  on the host" convenience still applies to them. Running on Linux, where this filesystem
  bridge is not involved at all, removed the risk even before that move.

- **Backup**: every night at 03:00 server time (cron `0 3 * * *`, stored in the
  `schedule:backup` setting) the server writes a consistent SQLite snapshot to
  `data/backups/opportun-YYYYMMDD-HHmm.db` (UTC timestamp) and, next to it,
  `opportun-YYYYMMDD-HHmm.attachments.json`, a manifest of the attachment files that
  snapshot refers to. The 14 newest snapshots are kept. Attachments are not copied
  into the snapshot: they live in `data/attachments/`, are content-addressed and never
  modified, so back that directory up alongside `data/backups/` (the whole `data/`
  directory, copied while the server is **stopped**, also works for these; `opportun.db`
  itself lives in its own named volume, below, not under `data/`, so this copy does not
  include it; see the next paragraph for the database itself). Admins can take one on
  demand under Settings → Import/Export (**Back up now**), or script it with the CLI in
  "Back up first," above.

  **Do not copy `opportun.db` directly while the server is running, as a substitute for
  either of those.** The database runs in WAL mode: a row the server already told a
  client was saved can still be sitting in `opportun.db-wal`, not yet folded into the
  main file, so a copy of `opportun.db` alone can be missing recent data. A plain file
  copy also has no transactional boundary: if it happens to run while a write is in
  progress, the copy itself can be torn mid-page. Neither failure announces itself; the
  copy opens normally and looks fine until a query reaches the missing or damaged part.
  `VACUUM INTO` (what the nightly job, **Back up now** and the CLI all use) is SQLite's
  own transactionally-consistent snapshot: it reads through SQLite's API, including
  whatever is still in the WAL, so this specific hazard does not apply to a backup taken
  that way. `sqlite3 <file> 'PRAGMA integrity_check;'` (see the risk above) is how to
  check a backup you are not certain was taken that way.

- **Restore**: pick which snapshot first. Settings → Import/Export lists every snapshot
  with its own **Verified** badge; use that, not just the newest file on disk, since an
  unverified or failed one is a worse bet than an older verified one. Then **stop the
  server** and run
  `docker compose exec opportun node --import tsx src/cli/restore.ts opportun-YYYYMMDD-HHmm.db`
  (from source, in `apps/server`: `node --import tsx src/cli/restore.ts
opportun-YYYYMMDD-HHmm.db`, with the same `DATA_DIR` and `SQLITE_DIR` as the server). It
  refuses to run while anything still holds the live database open, rather than trusting you
  to have stopped it; verifies the snapshot (the integrity check described under "Backup,"
  above) before touching anything, refusing a corrupt one outright; copies whatever is
  currently the live database (`opportun.db` and its `-wal` / `-shm` siblings, if present, in
  its own volume, below) to an obvious, timestamped `data/pre-restore-<time>/` directory
  before overwriting anything, so what it replaces is never simply gone; and prints exactly
  which snapshot it restored and when that snapshot finished. It does not touch
  `data/attachments/` or `master.key`: the snapshot's own manifest,
  `data/backups/opportun-YYYYMMDD-HHmm.attachments.json`, lists every attachment it expects
  by its stored path, so check against that rather than eyeballing the directory --
  `jq -r '.attachments[].storedPath' data/backups/opportun-YYYYMMDD-HHmm.attachments.json |
while read -r f; do [ -f "data/$f" ] || echo "missing: $f"; done` prints nothing when
  every file the manifest names is actually there. Then
  start the server; migrations bring an older snapshot up to date on boot. Restoring a
  snapshot into a fresh data directory is exercised in CI.
- **Backup on Postgres** (`DB_DIALECT=postgres`): the same job, schedule, retention and
  manifest, but each snapshot is a `pg_dump` custom-format archive,
  `data/backups/opportun-YYYYMMDD-HHmm.dump`, still written under `DATA_DIR` (the
  attachments live there too). The server runs
  `pg_dump --format=custom --no-owner --no-privileges` with the connection passed in
  libpq environment variables (never on its command line), so it needs `pg_dump` of
  the server's major version on its `PATH`: the Docker image ships
  `postgresql-client-16`; from source, install the client tools that match your server. A `pg_dump` failure fails the backup job (retried, then
  kept as a failed job with `pg_dump`'s error) and leaves no partial file.
- **Restore on Postgres**: pick which snapshot the same way as the SQLite Restore bullet
  above (Settings → Import/Export, by **Verified** status, not just the newest file). Then
  **stop the server first**, and run
  `DB_DIALECT=postgres DATABASE_URL=... node --import tsx src/cli/restore.ts
opportun-YYYYMMDD-HHmm.dump` (the same `DATABASE_URL` as the server). Same guarantees as
  the SQLite restore above, adapted to Postgres: refuses while another connection is open
  against the target database; verifies the archive with `pg_restore --list` before trusting
  it; and restores into a new database, `opportun_restored_<time>`, never the existing one,
  which is how it preserves what it is not overwriting, since there is nothing in place to
  copy aside the way the SQLite leg does. It needs `pg_restore` and `createdb` of the
  server's major version on its `PATH` (the Docker image ships `postgresql-client-16`; from
  source, install the client tools that match your server), and prints the database it
  created and the snapshot it came from. Point `DATABASE_URL` at that new database, and
  check `data/attachments/` against the snapshot's own manifest the same way as the SQLite
  Restore bullet above (`data/backups/opportun-YYYYMMDD-HHmm.attachments.json`, same
  `jq`/`storedPath` check, same `data/` root: attachments are not a Postgres concept and
  live in the one place regardless of dialect). Then start the
  server with the same `OPPORTUN_MASTER_KEY` (the vault's secrets are restored encrypted);
  migrations bring an older archive up to date on boot. To restore over the existing
  database instead, run the equivalent steps by hand with `--clean --if-exists`:

  ```sh
  createdb --template=template0 --locale-provider=libc --lc-collate=C --lc-ctype=C \
    --encoding=UTF8 opportun_restored
  pg_restore --no-owner --no-privileges --single-transaction --exit-on-error \
    --dbname=opportun_restored data/backups/opportun-YYYYMMDD-HHmm.dump
  ```

  (connection settings come from `PGHOST`, `PGPORT`, `PGUSER` and `PGPASSWORD`, or a
  `~/.pgpass` file). The command above does not offer this option; a fresh database is
  safer, since the old one stays intact until you switch, so that stays the only path the
  command itself takes. `--single-transaction` makes a failed restore leave the target
  empty. A dump restored into a fresh database, then read back through the app (vault
  secret and search included), is exercised in CI.

- **Export**: Settings → Import/Export gives a complete JSON + Markdown export of
  your data at any time.
- **Lost password**: from `deploy/`, run
  `docker compose exec opportun node --import tsx src/cli/resetPassword.ts you@example.com`
  (from source: `DATA_DIR=... SQLITE_DIR=... node --import tsx src/cli/resetPassword.ts
you@example.com` in `apps/server`, with the same values as the server). It sets a new
  random temporary password, signs that user out
  everywhere, and prints the password once to your terminal; it is not logged or stored
  anywhere else. Sign in with it and change it under Settings. An unknown email changes
  nothing and exits with an error. The reset also revokes every device token the account
  has (connectors and the capture extension need a new one), since a reset is also how you
  recover from a compromised account, and it turns off two-factor sign-in for that
  account: it is the recovery of last resort for someone who lost both their
  authenticator and their recovery codes, who then re-enrolls under Settings → Security.
  An administrator can do the same from Settings → Users (Reset password), which shows
  the temporary password once; administrators cannot reset their own account this way
  (see [section 12](#12-users-and-registration)).

### Deleting everything (teardown)

NFR-PRV4 asks for account deletion. On a single-user self-hosted instance there is no
multi-tenant row to remove and no support team to action a request, so "delete the
account" means erasing everything on the local system and starting over, not an in-app
route (issue #139). From `deploy/`:

```bash
deploy/destroy.sh -p <project> --dry-run   # see exactly what this would remove, first
deploy/destroy.sh -p <project>             # then the real thing
```

`<project>` is whatever this deployment's `COMPOSE_PROJECT_NAME` is set to (see above):
the script refuses to run without an explicit one, by design. A compose project name is a
global namespace on the Docker host (issue #203); guessing at one, or falling back to
`compose.yml`'s own name or the current directory, is exactly how a teardown reaches a
deployment it did not mean to touch. It also refuses a `--data-dir` or auto-detected path
it cannot itself see as a real directory on disk, rather than silently doing nothing to a
path that turned out to be wrong (seen directly: Docker Desktop for Mac can report a bind
mount's source through its own VM-internal `/host_mnt` addressing, which the script
recovers by stripping that documented prefix, refusing outright if that still doesn't
resolve to something real). And existing is not the same as safe: the path is normalized
(`cd -P`, collapsing `..` and `.` and resolving symlinks, so a string like
`/a/b/c/../../..` is judged by what it actually resolves to, `/`, not by how many
components the literal string happens to have) before checking whether it is `/`, `$HOME`,
relative, contains a newline, or is fewer than 3 components deep -- any of which is refused
outright rather than handed to `rm -rf`, whether it came from detection or a typo'd
`--data-dir`.

`--dry-run` prints the project, every container, network and volume compose created for
it, and the resolved data directory (read from the running container's own mount, so it
reflects whatever override is in effect, never a hardcoded `./data`), then exits without
touching anything. A real run prints the same summary and requires typing the project
name back, not a `y`/`n` or a flag, before doing anything: `docker compose -p <project>
down -v --remove-orphans`, then removing the resolved data directory (attachments,
backups, exports, `master.key`). If there is a `.env` right here, and `docker compose`
confirms this directory actually resolves as `<project>` (not just a literal `compose.yml`
by name, since a deployment can hold only a `compose.override.yml` with the base file
elsewhere), that `.env` is removed too; if it doesn't resolve, the script says so and
leaves it, rather than silently skip it or guess.

**Backups die with the data directory, on purpose**: a deletion that empties the database
but leaves every nightly snapshot behind has not done what it says. If you want a way
back, copy the data directory somewhere outside this host before confirming; the script
will not do that for you, since "somewhere safe" is yours to decide, not its to guess at.

**What this cannot do: revoke the Google OAuth grant.** That lives on Google's side, not
this machine's, so removing local tokens does not touch it. The script's last line is the
reminder to do it by hand at
[myaccount.google.com/permissions](https://myaccount.google.com/permissions); skipping it
leaves a live grant on an account for a deployment that no longer exists.

Running from source (no Docker, section 5): there is no compose project or named volume
to remove. Stop the server, then remove whatever `DATA_DIR` points at (and `SQLITE_DIR`
if set separately) and this checkout's `.env`, and revoke the Google grant the same way.

### Moving opportun.db to its own volume

The known risk above is why: `opportun.db` now lives in `SQLITE_DIR` (`SQLITE_DIR`
defaults to `DATA_DIR`, so a deployment that never sets it sees no change), a separate
named Docker volume in compose (`sqlite_data`, mounted at `/sqlite`), rather than the
`./data` bind mount. Attachments, backups, exports and `master.key` stay exactly where
they were, in `DATA_DIR`.

Upgrading a compose installation picks up `sqlite_data` automatically (it is declared in
`deploy/compose.yml`, which `git pull` brings in); there is nothing to configure. On first
boot after the upgrade, if `DATA_DIR` holds an `opportun.db` from before this release and
`SQLITE_DIR` does not yet have one, the server migrates it automatically:

1. The original is preserved by a true byte copy to `DATA_DIR`, as
   `opportun.db.pre-volume-migration` (plus `-wal` / `-shm`, if present), before anything,
   including the next step, opens it. Opening a database whose WAL a crash left
   un-checkpointed can itself trigger WAL recovery, which is a write, so this has to happen
   first, not after.
2. `VACUUM INTO` writes the database into `SQLITE_DIR`. Like the nightly backup (above),
   this reads through SQLite's own connection, including whatever is still in the WAL, so a
   database that was live moments before migrating is captured correctly, unlike a plain
   file copy.
3. The copy is verified with `PRAGMA integrity_check` before anything is removed; a copy
   that fails is deleted and the server refuses to start, naming the untouched preserved
   original from step 1.
4. Once verified, the original's own name in `DATA_DIR` is freed (the preserved copy from
   step 1 already holds everything, so this is redundant, not a loss).

If `DATA_DIR` and `SQLITE_DIR` both already hold a database (for example, one was copied
into the new volume by hand before upgrading), the server refuses to start with an error
naming both paths, rather than silently picking one: move or remove whichever one is
stale, then restart.

Running from source (section 5), nothing changes unless you want the split there too:
`SQLITE_DIR` defaults to `DATA_DIR`, exactly as it does in the image, and the same
automatic migration applies. The CLIs above (`resetPassword.ts`, `backup.ts`,
`restore.ts`, and `copyToPostgres.ts` in [section 15](#15-postgres-optional-beta)) all
resolve `SQLITE_DIR` the same way the server does, so running any of them with the
server's own environment always points at the same file.

### Naming an existing deployment's compose project

**If you deployed before `COMPOSE_PROJECT_NAME` existed, do this before your next
`docker compose up`, not after.** `deploy/compose.yml` used to set a fixed project name
(`opportun`); it now leaves that to `COMPOSE_PROJECT_NAME` in your `.env`, falling back to a
name deliberately unlike any real deployment's when it is unset (issue #203: a fixed name is
a global namespace on the Docker host, reachable from any other checkout with no flag
required, which is how a test run elsewhere destroyed a live deployment once already). Your
existing containers and volumes are already named for the old value. Add
`COMPOSE_PROJECT_NAME=opportun` to your `.env` (matching the old default exactly, not a name
of your choosing) before upgrading, or compose stops recognizing them as the same project:
`docker compose up` then creates a second, empty stack beside the real one instead of
reusing it, which looks like nothing is wrong until you notice your data is gone. Check
`docker compose ps` names the containers you expect (`opportun-opportun-1` and so on) before
and after making this change, as confirmation.

A fresh deployment started after this landed never had the old fixed name and does not need
this step; set `COMPOSE_PROJECT_NAME` to whatever you like instead (section 2).

**If you run compose through your own wrapper script** rather than invoking `docker compose`
directly from `deploy/` (for example, one that passes `--env-file` pointing somewhere other
than `deploy/.env`), set `COMPOSE_PROJECT_NAME` in whatever env file that wrapper actually
reads, not `deploy/.env`: compose project resolution honors `COMPOSE_PROJECT_NAME` from
whichever env file is in effect for that invocation, by the same precedence either way
(above `compose.yml`'s own `name:`), so the setting has to live where the wrapper looks for
it, which is the whole point of keeping it outside this repo in the first place.

## 7. Configuring discovery sources

Discovery sources live under Discovery > Sources. Each run adds new postings to the review
queue (Discovery > Review queue), where the AI ranks them against your role targets. A
source with a schedule runs on its cron (at most hourly); one without runs only when you
press Run now.

- **Company job boards (Greenhouse, Lever, Ashby)**: enter the board's org slug, the part
  of the public board URL after the host: `boards.greenhouse.io/<slug>`,
  `jobs.lever.co/<slug>` or `jobs.ashbyhq.com/<slug>`. Slugs are lowercase letters,
  digits and hyphens. Opportun reads only each provider's public job board API. You
  rarely need to add these by hand: following a company under Discovery > Companies
  detects its board and creates the source for you, polled daily at 07:00 by default
  (change that default with `PATCH /api/v1/settings/discovery`, body
  `{"cron": "0 7 * * *"}`).
- **MCP sources**: Opportun ships no scrapers (ADR-12). If you want postings from a
  community tool such as JobSpy, you run it yourself as an MCP server and register it
  here; you are responsible for that tool and for respecting the terms of the sites it
  reads. The config is JSON in one of two shapes:

  ```json
  {
    "transport": "stdio",
    "command": "/usr/local/bin/my-jobs-mcp",
    "args": ["--quiet"],
    "tool": "search_jobs",
    "queryArgs": { "query": "platform engineer", "location": "remote" },
    "itemsPath": "results",
    "mapping": { "company": "company.name", "title": "title", "postingUrl": "url" }
  }
  ```

  or `"transport": "http"` with `"url": "https://..."` in place of `command` and
  `args`. `tool` is called with `queryArgs`; `itemsPath` is the dot path to the list of
  results (empty when the output is the list itself); `mapping` gives a dot path per
  posting field (`company` and `title` required; `descriptionMd`, `postingUrl`,
  `location` and `externalId` optional). Tool output is treated as untrusted text.
  - **stdio sources are admin-only**, because a stdio command executes on the server
    (without a shell, with an environment of `PATH` only). Other users can add http
    sources.
  - **Point an http source only at a host you trust.** The URL must be https, and
    Opportun refuses hosts that resolve to loopback or private addresses, but that check
    is not pinned to the connection it makes, so DNS rebinding is not fully prevented on
    this path. For a server on the same machine, use stdio.

- **Workday**: Workday boards are addressed by tenant and site on the company's own host
  (`https://<company>.wd5.myworkdayjobs.com/<site>`), so there is no slug to type. Choose
  the Workday kind and paste the career site URL, or any posting link on that site; the
  datacenter part of the host (`wd1`, `wd5`, `wd12`) is kept as given, never guessed.
  Following a company detects a Workday board only from a URL (a careers URL that is itself
  a Workday site, or Workday links on the company's careers page), never by guessing from
  its name. Opportun reads the same public candidate-experience endpoints the careers site
  itself uses. Each posting's description costs one extra request, so a run describes at
  most 200 new postings and leaves the rest for the next run; postings already stored are
  not fetched again. Workday takes its sites down for a weekly service window: a run during
  it fails with "Workday board `<tenant>/<site>` unreachable (service window or unknown
  tenant/site)" and succeeds on a later run. A site that does not exist can answer the same
  way, so if the message persists for days, check the career site URL.
- **Job alert emails**: LinkedIn (`jobalerts-noreply@linkedin.com`) and Indeed
  (`alert@indeed.com`) job alert digests become leads in the review queue, through an
  always-on "Job alert email" source. Alert-email leads require Gmail to be connected
  (Settings > Integrations): they arrive with Gmail sync. The sender list is a per-user
  setting (`alert_senders`) that defaults to those two addresses; the app has no editor
  for it yet. The match needs a From header holding exactly one mailbox: a header listing
  several (one of them an alert sender) is ordinary mail and goes to the classifier.

## 8. Attaching a posting to an opportunity

An opportunity tracked without its job description (imported, or created from a message)
can get one from its company's job board: open it, go to Details, and use **Find posting**.
Opportun looks for an ATS job link in the messages already linked to that opportunity, then
falls back to the company's board, detecting it first if the company has none recorded. One
confident match is attached straight away; several are listed for you to choose from, with a
search box over the whole board; a company with no reachable board leaves you the paste
paths (a link, or the description text). LinkedIn links are never fetched (see
[section 10](#10-capture-extension-linkedin)); paste the text, or capture the job with the
extension, instead. Workday links work too: the posting the link names is read directly.

The description is stored as text, so it survives the posting being taken down, and an
existing description is never overwritten: edit it in place instead.

## 9. Reactive Resume (optional, instead of Google Docs)

Resumes can live in your own [Reactive Resume](https://github.com/reactive-resume/reactive-resume)
instead of Google Docs, so Opportun works without a Google account (FR-R7).

- **Supported versions**: Reactive Resume 6.0.x (written against its OpenAPI document
  6.0.3). Earlier versions have no API keys or other routes, and are not supported. Opportun
  uses only: `GET /api/health`, and under `/api/openapi`: list resumes, get a resume,
  duplicate a resume (`POST /resumes/{id}/copies`) and JSON Patch a resume
  (`PATCH /resumes/{id}`).
- **Reachability**: the instance must be served over **https** at a **public** address.
  Like every outbound fetch, the call is refused for private, loopback and link-local
  addresses (NFR-SEC6), so a Reactive Resume reachable only on your LAN or on localhost
  will not work. The official hosted service at `https://rxresu.me` serves the same API
  (not verified live from Opportun).
- **Setup**: in Reactive Resume, create an API key (Settings, API keys). In Opportun, go to
  Settings > Integrations > Reactive Resume, enter the instance address and the key, save,
  then press **Validate**. The key is stored encrypted in the vault and is only ever sent to
  the address it was saved with: changing the address requires entering the key again.
- **Choosing the store**: the same card picks where _new_ base resumes are registered
  (Google Docs by default). Existing resumes keep their store, and tailored copies are made
  next to their base, so switching never strands a Google resume. Disconnecting deletes the
  key and address and sets the choice back to Google Docs; Reactive Resume resumes stay
  listed and work again after reconnecting.
- **Registering a resume**: on the Resumes page, paste the resume's builder link
  (`https://<your instance>/builder/<id>`) or its id.
- **What is lossy compared with Google Docs**: Opportun reads the visible text fields of
  the resume (name, headline, contact lines, summary, section titles and entries, keywords,
  custom sections), one line per field or paragraph; hidden entries, dates, links and
  layout are not read. An accepted edit replaces text inside one field; an edit that
  crosses bold, italic or link formatting is refused and must be made by hand in Reactive
  Resume. Edits are guarded by the resume's last-updated time, so a change made in the
  builder meanwhile is never overwritten (retry the edit). PDF export stays in Reactive
  Resume.

## 10. Capture extension (LinkedIn)

Opportun never fetches LinkedIn itself (C-1). To add a LinkedIn profile as a contact or a
LinkedIn job as an opportunity, use the **Opportun Capture** browser extension (Chrome,
Chromium browsers and Firefox 128+): open the profile or job in your browser, click the
extension, and click **Capture this page**. It sends only that tab's visible text, only when
you click, and only to your own server.

A captured job becomes an opportunity at Interested rather than a review-queue card, and
Opportun then looks the same posting up on the company's own ATS board in the background,
making the employer's copy the description and keeping what only the captured page carried.
When it cannot settle that, it changes nothing and flags the opportunity for you. See
[the guide](guide/browser-extension.md).

- **Token**: the setup dialog creates one for you, with the **Browser capture** permission
  only. It can only push captures; revoke it under Settings > Integrations > Extensions and
  Connectors at any time.
- **Install**: open **Settings > Integrations > Extensions and Connectors**, find
  **Browser extension** and press **Set up**. The dialog creates the token, hands over the
  download for your browser and walks through installing it; the server's address is already
  filled in, so the token is the only thing you paste. No checkout, Node or terminal needed.
- **From source instead** (contributors, or a server with no built extension): build it with
  `pnpm --filter @opportun/extension build` and load `packages/extension/dist/chrome`
  (Chrome: `chrome://extensions`, Developer mode, Load unpacked) or
  `packages/extension/dist/firefox/manifest.json` (Firefox: `about:debugging`, Load Temporary
  Add-on). The build emits unpacked directories, not zips; the zip exists only on the download
  path. A build made this way has no address baked in, so enter the server address by hand.
- **Configure**: downloads arrive knowing this server's address. For a build made from
  source, enter it in the extension's Settings: https anywhere, or plain http on a private
  network (localhost, a `.local`, `.lan` or `.home.arpa` name, a name with no dots, or a
  private address such as `192.168.x.x`). Add the token, Save, allow the access prompt for your
  server, then **Test connection**.
- **Limits**: profiles (`/in/<name>`) and job pages (`/jobs/view/<id>`, or the jobs search
  view with a job selected) only; feeds, search results and company pages are refused. Each
  token may capture 30 pages per 15 minutes.

What it does and how to use it day to day is in the user guide:
[Browser extension](guide/browser-extension.md). The compliance rationale and a manual QA
checklist are in [packages/extension/README.md](../packages/extension/README.md).

## 11. Apple Mail (macOS)

Apple Mail has no server-side API, so Opportun reads it through a small command-line
connector, `opportun-connector`, that runs on your Mac (FR-M5, ADR-10). It reads the
mailboxes you name with Apple's scripting bridge (JXA via `osascript`) and pushes the
messages to your server over HTTPS with a device token. Your mail account password never
reaches Opportun; the token can only send mail in, never read anything back.

Requirements: macOS with Apple Mail set up, and Node.js 22 or later on the Mac
(`brew install node`). The Opportun server must be reachable from the Mac over **https**
(plain http is accepted only for a server on the same Mac, at `localhost`).

**1. Create a device token.** In Opportun, open Settings > Integrations > Extensions and Connectors and press
**Create token**. Name it after the Mac (for example "MacBook Air"), tick only **Apple Mail
connector (mail:push)**, enter your current password and create it. The token (`odt_...`)
is shown once: copy it now. The server keeps only a hash, so a lost token cannot be shown
again; create another instead.

**2. Build and install the connector** (from a checkout of this repository; the package is
not published to npm):

```bash
corepack enable && pnpm install
pnpm --filter @opportun/connector build
mkdir -p ~/.local/bin
install -m 755 apps/connector/dist/opportun-connector.js ~/.local/bin/opportun-connector
```

The build is one self-contained file that needs only `node`. Make sure `~/.local/bin` is
on your `PATH` (or call it by its full path).

**3. Configure it.**

```bash
opportun-connector init
```

It asks for the server address (`https://jobs.example.com`), the device token (typed
input is hidden), the mailboxes to read and how far back the first sync reaches (default
180 days). Mailboxes are comma-separated: `Inbox` means every account's inbox, a plain
name (`Recruiting`) matches that mailbox in every account and On My Mac, and
`Account/Mailbox` (`iCloud/Recruiting`) picks one account's mailbox. The answers go to
`~/.config/opportun-connector/config.json`, readable only by you (0600). `init` then sends
an empty batch to check the token and prints the server's answer. Re-run `init` at any
time; it offers your current answers as defaults and keeps the token if you press Enter.
Every answer can also be given as a flag (`opportun-connector --help`); prefer the prompt
for the token, since a flag can end up in your shell history.

**4. Sync.**

```bash
opportun-connector sync     # push new mail once
opportun-connector watch    # sync every 15 minutes until Ctrl-C (--interval 5 for 5)
```

The first `sync` triggers a macOS prompt asking to let your terminal control Mail: allow
it. If you declined, enable it later in System Settings > Privacy & Security > Automation.
Pushed messages appear in the Inbox with the Apple Mail channel, and Settings >
Integrations > Extensions and Connectors shows when the connector last pushed. The connector remembers the
received date of the newest accepted message in `~/.config/opportun-connector/state.json`
and only moves it forward after the server accepts a batch; it re-reads the last five
minutes each time to catch late-filed mail (the server ignores duplicates). Because that
position only covers what was already read, re-running `init` with an added mailbox or a
longer lookback window resets it (and says so), and the next sync re-reads the whole
window; the server skips what it already has. Removing a mailbox or shortening the window
keeps it. Delete `state.json` to force the same full re-read.

**5. Run it in the background with launchd.** The template
[`deploy/opportun-connector.plist`](../deploy/opportun-connector.plist) runs `watch` at
login and restarts it after a failure, like the server's `restart: unless-stopped`:

```bash
sed -e "s#/Users/YOU#$HOME#g" -e "s#/opt/homebrew/bin/node#$(command -v node)#" \
  deploy/opportun-connector.plist > ~/Library/LaunchAgents/org.opportun.connector.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/org.opportun.connector.plist
tail -f ~/Library/Logs/opportun-connector.log
```

Stop it with `launchctl bootout gui/$(id -u)/org.opportun.connector`. Run `sync` once from
Terminal before loading the agent so the configuration is known to work. Under launchd,
macOS may ask again for the Automation permission, this time for `node`; if the log shows a
permission error, allow it in System Settings > Privacy & Security > Automation and the
agent picks it up at its next sync (`watch` keeps running through this error).

The connector rotates `opportun-connector.log` itself (not launchd, and not `newsyslog`:
`watch` runs for weeks without exiting, so an external rotator renaming the file out from
under launchd's redirected file descriptor would not stop it growing, it would just keep
growing under its new, hidden name): once it passes 5MB it is moved to
`opportun-connector.log.1` and a fresh file starts, with up to 5 numbered backups kept and
the oldest dropped. `tail -f` keeps following the live file across a rotation; `ls
~/Library/Logs/opportun-connector.log*` shows the backups if you need older history.
Upgrading from a version without rotation does not touch an existing, already-unbounded log:
the first write after upgrading finds it over the cap and rotates it whole into `.1`, so
nothing already on disk is lost, it just stops growing from there.

**Exit codes** (for scripts and the launchd log): 0 success, 2 configuration or usage
problem, 3 token rejected or missing the `mail:push` scope, 4 server unreachable or failing
after retries, 5 Apple Mail could not be read, 1 anything else. `watch` keeps running
through server and Mail failures (logging each one) and exits on 2 or 3. Under launchd
that exit is not final: the agent restarts any nonzero exit (`KeepAlive` with
`SuccessfulExit` false), throttled to once every 15 minutes, so a revoked token or broken
config shows up in the log every 15 minutes until you fix it (re-run `init`) or stop the
agent.

**Security notes.**

- **What leaves the Mac**: only messages in the mailboxes you name, received within the
  lookback window: sender, recipients, subject, dates and the plain-text body (cut at
  500,000 characters; HTML is converted to text). Attachments are never read or sent.
- **Read-only (FR-M7)**: the connector never marks messages read, flags, moves, deletes or
  sends mail; its Mail script only reads, and its tests enforce that.
- **Token scope**: a `mail:push` token can only push mail. Every read route refuses it, so
  a stolen token cannot read your data. Revoke a token in Settings > Integrations > Extensions and Connectors
  and it stops working on its next request; then create a new one and re-run `init`.
- **On the Mac**: the token sits in `~/.config/opportun-connector/config.json` (0600 in a
  0700 directory). Anyone who can read your user's files can read it, as with any CLI
  credential; revoke it if the Mac is lost.
- **Limits**: the server accepts at most 30 batches of up to 100 messages per token per 15
  minutes. A large first sync simply waits out the limit and continues.

**Behind your own reverse proxy.** A batch request can be up to 12 MB. The bundled Caddy
has no body limit, but nginx refuses anything over 1 MB by default, which makes most
batches fail with HTTP 413. Raise it for the Opportun site:

```nginx
client_max_body_size 12m;
```

The connector splits a refused batch in half until it fits; a single message the proxy
still refuses is skipped with a `WARNING` naming its subject and date.

## 12. Users and registration

The first account created on an instance is its administrator, and registration closes
right after it. Administrators manage the instance under **Settings > Users**:

- **Registration**: Open registration to let someone create an account (on the register
  page, or with a sign-in provider from [section 14](#14-sign-in-with-google-github-or-linkedin)),
  then close it again. Every account sees only its own data.
  Opening or closing registration, like resetting a password below, asks for your own
  password: a stolen session cookie alone cannot let someone create an account or take one
  over. An administrator who signed in only through a provider sets a password first, under
  Settings → Security.
- **Users**: every account on the instance. **Reset password** gives a member a new random
  temporary password, shown once for you to hand over on a channel you trust. It signs that
  member out everywhere, revokes their device tokens and turns off their two-factor sign-in,
  so it is also the recovery path for someone who lost both their authenticator and their
  recovery codes. An administrator cannot reset their own account here; use the command-line
  reset in [section 6](#6-upgrades-and-backups) instead.
- **Sign-in providers**: see [section 14](#14-sign-in-with-google-github-or-linkedin).

## 13. Two-factor sign-in

Each user can turn on two-factor sign-in under **Settings > Security**: after the password
(or a provider sign-in), sign-in asks for a 6-digit code from an authenticator app
(1Password, Google Authenticator, Authy and similar).

1. Press **Enable two-factor** and confirm your current password. An account created
   through a sign-in provider has no password yet: set one first, on the same page.
2. Scan the QR code, or type the setup key into the app, then enter the code it shows and
   press **Turn on**.
3. Save the 10 recovery codes shown next. Each one signs you in once in place of a code;
   they are not shown again. The Security page shows how many are left.

Turning it off asks for your password and a current code or a recovery code. If you lose
both the authenticator and every recovery code, an administrator resets your password
(Settings > Users, or the command-line reset in [section 6](#6-upgrades-and-backups)),
which also turns two-factor sign-in off; then enroll again. Codes depend on the clock, so
keep the server's time synchronized (NTP).

## 14. Sign-in with Google, GitHub or LinkedIn

Besides a password, people can sign in with a Google, GitHub or LinkedIn account
(FR-S4). Each provider needs an OAuth client that you register for this instance; nothing
is shared with a third party. Sign-in can reuse the Google client used for resumes and
Gmail in [section 2](#2-quick-start-docker-compose) (the card offers **Use that client**) or
use its own. Either way it has its own callback, which must be registered on whichever
client it uses, and its own permissions (only `openid email profile` for Google, `read:user user:email` for GitHub,
`openid profile email` for LinkedIn).

1. **Register the client.** As an administrator, open **Settings > Users > Sign-in
   providers**. Each provider shows the **Redirect URI** to register, which is
   `<OPPORTUN_BASE_URL>/api/v1/auth/oauth/<google|github|linkedin>/callback`, so set
   `OPPORTUN_BASE_URL` to the address people actually use first.
   - **Google**: Google Cloud console, APIs & Services > Credentials, an OAuth client of
     type Web application with that redirect URI.
   - **GitHub**: GitHub > Settings > Developer settings > OAuth Apps, a new OAuth App with
     that URI as its authorization callback URL.
   - **LinkedIn**: LinkedIn Developer portal > My apps, an app with the "Sign In with
     LinkedIn using OpenID Connect" product, and the URI under Auth > Authorized redirect
     URLs. The server calls only LinkedIn's official token and userinfo endpoints, and
     only during a sign-in the user started (see [SECURITY.md](../SECURITY.md)).
2. **Save** the client ID and secret on the provider's card. The secret is stored
   encrypted with the master key; saving again replaces it, and **Remove** turns the
   provider off.
3. **Link an account.** Each user links their own provider account under **Settings >
   Security > Linked accounts** (Link, then confirm the current password). From then on
   **Continue with ...** on the sign-in page signs them in.

How accounts are matched:

- Only a **linked** provider account signs in to an existing account. A provider email
  that matches an existing account never links or signs in by itself, even when the
  provider says it is verified: the sign-in page asks the person to sign in with their
  password and link the provider from Settings.
- While registration is open, a provider account with a **verified** email that matches
  no account creates a new account (without a password; set one under Settings >
  Security to enable two-factor sign-in or link other providers). While it is closed,
  unknown provider accounts are refused.
- Two-factor sign-in still applies: a provider sign-in replaces only the password step.
- Opportun keeps no provider token after sign-in; it reads the identity once.

A Google OAuth client left in **Testing** publishing status accepts consent only from the
test users listed on its Audience page, so other people's sign-in fails with
`access_denied` until you add them there or publish the app.

## 15. Postgres (optional, beta)

**Do you need it?** Probably not. SQLite is the default, is what Opportun is built and
tuned around, and is plenty for one person or a household: one file, nothing to run or
patch, backups that are a file copy. Choose Postgres only if you already operate one you
trust (a managed service with point-in-time recovery, or a database host you back up
anyway) and want Opportun's data there, or want the database on a different machine or
volume than the app. It brings no feature SQLite lacks and is not faster at this scale.
Postgres support is **beta** in this release: the whole server test suite, search and
backups run on Postgres 16 in CI, but it has had less real-world use than SQLite.

**A real, non-obvious trade between the two engines if a database is ever damaged**
(corrupt storage, failing hardware, a filesystem bug): SQLite can absorb it silently.
SQLite only reads the pages a query actually touches, so a damaged file can keep answering
most requests correctly for a long time, with no error anywhere, until something happens
to need the damaged part; this is exactly what a scheduled integrity check
([section 6](#6-upgrades-and-backups), `GET /healthz`'s `databaseIntegrity`) exists to
catch in between. Postgres does not get that same page-by-page scan, and the reason is not
an oversight: the same kind of damage does not sit quietly there, and reading every page on
a schedule to look for it would mean causing the problem below on a schedule instead of
only when something else does. A page Postgres cannot make sense of crashes the backend
process trying to read it, immediately, including `pg_dump` itself when a nightly backup
reaches it, rather than being found later by a separate scan. In practice this means
Postgres cannot silently hand you a bad backup the way SQLite's `VACUUM INTO` can (it would
have already crashed something first), but the price of that guarantee is a brief,
full-instance outage: every session dropped and the server restarted, the moment anything
touches the damage, rather than a quiet, timed report. Neither is strictly safer: SQLite
trades a detection delay for continuity; Postgres trades continuity for immediate,
unmissable failure. Both still need the same answer once damage is found: restore from a
verified backup ([section 6](#6-upgrades-and-backups)).

What Postgres's scheduled check does instead of a page scan (issue #241): it records the
backend's own start time and compares it against the last check, which costs nothing
because it never reads a page. A changed value means the backend has restarted since the
last check, which is what the crash above looks like from here, surfaced through
`GET /healthz`'s `databaseIntegrity` the same way SQLite's page scan is, and from the same
place on the Backups page under Settings -> Import/Export. It cannot, by itself, tell that
crash apart from an entirely ordinary restart (an upgrade, a host reboot): Settings -> Jobs
is the other half, where a backup attempt that failed with "server closed the connection
unexpectedly" around the same time is the sign that this specific restart was the crash,
not routine maintenance.

Requirements: Postgres 16, a database created with the C collation (so names and titles
sort exactly as on SQLite; the server warns at boot otherwise), and a role that owns it.
`DATA_DIR` is still required and still holds `attachments/`, `backups/` (as `.dump`
files), `exports/` and `master.key`: only the database moves.

### New installation on Postgres (compose)

The bundled `postgres` profile runs `postgres:16` on the compose network (not published on
the host), initialized with `--locale=C`, with its data in the `pg_data` volume (Docker
Compose v2.20 or newer, as in section 1). In `deploy/.env`:

```bash
COMPOSE_PROFILES=postgres
POSTGRES_PASSWORD=<openssl rand -hex 24>
DB_DIALECT=postgres
DATABASE_URL=postgres://opportun:<the same password>@db:5432/opportun
# The bundled service has no TLS on the compose network (host `db` would default to require):
DB_SSL=disable
```

then `docker compose up -d --build` as in section 2. The server migrates the empty
database on first boot.

`deploy/.env` now holds the database password: keep it private (`chmod 600 deploy/.env`)
and out of version control. Compose passes `DATABASE_URL` to the container as an
environment variable, so anyone who can run `docker inspect` on the host can read it; that
is already root-equivalent access to the host (and to `data/`), which is why the bundled
setup accepts it. To keep the password out of the container's environment, put the URL in a
file and set `DATABASE_URL_FILE` instead of `DATABASE_URL`: make it readable only by the
server (`chmod 600`; in compose, owned by uid 10001 like `data/`, for example a file in
`data/` referenced as `/data/database_url`). The same applies to a bare run: a
`DATABASE_URL_FILE` with mode 0600, owned by the user the server runs as. For a managed or remote database, leave `COMPOSE_PROFILES` and
`POSTGRES_PASSWORD` unset, create the database yourself
(`CREATE DATABASE opportun TEMPLATE template0 LOCALE_PROVIDER libc LC_COLLATE 'C' LC_CTYPE 'C' ENCODING 'UTF8'`),
point `DATABASE_URL` (or `DATABASE_URL_FILE`) at it and keep `DB_SSL=require` or
`verify-full`.

### Moving an existing SQLite installation to Postgres

The copy tool (`src/cli/copyToPostgres.ts`) copies `SQLITE_DIR/opportun.db` (defaulting the
same way the server does, section 4; `--from` overrides it) into a new, empty Postgres
database and proves the copy before committing it: per-table row counts
and SHA-256 checksums over every row (decoded values, compared identically on both
sides), the search index rebuilt for the same entities, and every vault secret decrypted
again with your master key and compared with the source. Any difference rolls the whole
copy back and names the table; the tool exits nonzero. It never writes to the SQLite file
and refuses a target that holds any data, or tables that are not Opportun's (there is no
overwrite option: to retry, drop and recreate the target database). It inspects the
target before writing anything to it, migrations included. Text containing NUL characters, which Postgres cannot
store, is cleaned and reported per column, never dropped silently. It copies the database
only: `attachments/` and `master.key` stay where they are, in `DATA_DIR`, which the
Postgres deployment keeps using (the tool checks that the attachment files the rows point
at are there). It also refuses a master key that opens none of the source's vault values,
and any single value that does not decrypt, unless you pass `--allow-undecryptable` (those
values are then copied byte for byte, warned about one by one, and the vault line reads
NOT VERIFIED). JSON values are compared by Postgres itself (`jsonb` equality), so a number
too large or too precise for a JavaScript double still has to match exactly. The tool holds
the whole source database in memory while it works: fine for a personal database (the
owner's is a few MB), but give it memory comparable to the database's size.

1. **Upgrade first, on SQLite.** Run this release on SQLite once (`docker compose up -d --build`
   with your current `.env`), so the SQLite database is at this release's migrations. The
   tool refuses a database from an older or newer release.
2. **Stop the server and keep a backup.** This step is load-bearing: the copy is a snapshot,
   and anything written to SQLite while or after it runs is not in Postgres (the tool warns
   if it notices the source change, but cannot see every case). `docker compose stop opportun`,
   then keep the latest nightly snapshot from `data/backups/` (or take one first: section 6).
   The tool also refuses to run while `opportun.db-wal` is not empty, which means a server is
   still running or did not stop cleanly (start and stop it once).
3. **Configure Postgres** in `deploy/.env` as above (`COMPOSE_PROFILES`, `POSTGRES_PASSWORD`,
   `DB_DIALECT=postgres`, `DATABASE_URL`, `DB_SSL=disable`) and start only the database:
   `docker compose up -d db`.
4. **Dry run.** Checks the source (migration head, integrity, foreign keys, vault
   decryptability, attachment files) and the target (collation, emptiness) and prints the
   plan, writing nothing, not even migrations:

   ```bash
   docker compose run --rm opportun node --import tsx src/cli/copyToPostgres.ts --from /sqlite --dry-run
   ```

5. **Copy.** The same command without `--dry-run`. It migrates the target to head, copies
   in one transaction, verifies, commits, verifies again, and prints a table of every
   table's source and target row counts and checksums, then the cutover checklist. Exit
   code 0 means copied and verified. 2 means it refused: "Refused before any changes"
   (nothing was written) or "Refused after migrating the empty target" (it holds only the
   schema and seeded rows; nothing was copied). 1 means verification failed or an error
   occurred: "rolled back, the target holds only its migrations" (safe to fix and rerun), or
   "COMMIT outcome unknown: verify the target before trusting either side" (drop and
   recreate the target before another attempt; the SQLite file is untouched either way).
6. **Start on Postgres.** `docker compose up -d`, then check `GET /healthz`
   (`"db":"ok"`), sign in, run a search and open an attachment.

From source, run the tool in `apps/server` with the server's environment:
`DB_DIALECT=postgres DATABASE_URL=... OPPORTUN_MASTER_KEY_FILE=... node --import tsx src/cli/copyToPostgres.ts`
(`--from` to override where it reads `opportun.db`, instead of `SQLITE_DIR`/`DATA_DIR`).
The connection URL is read from `DATABASE_URL` or `DATABASE_URL_FILE`, never from the
command line, where other local users could read the password. Options: `--batch <rows>`
(rows per insert, default 500), `--attachment-sample <n>` (attachment files verified by
hash, default 500, `0` for all) and `--allow-undecryptable` (see above).

### Rollback

The SQLite file is not touched by the copy, so it stays a complete rollback point as of the
moment you stopped the server:

1. Stop the server: `docker compose stop opportun`.
2. In `deploy/.env`, set `DB_DIALECT=sqlite` (or remove it); `COMPOSE_PROFILES` may stay.
3. Start: `docker compose up -d`. The app runs on the SQLite database again.

**Writes made on Postgres after the cutover do not flow back.** There is no reverse copy:
anything added or changed while running on Postgres exists only there. Before rolling back
after real use, take a full export (Settings → Import/Export) to keep a record of it, and
re-enter what you need on SQLite by hand. The Postgres database is left as it was; drop it
once you no longer need it, or keep it to switch again later (a second copy needs a new,
empty database).

## 16. Demo deployment

A separate kind of deployment, not covered by the sections above: a public instance that pulls
a prebuilt image rather than building from a checkout, runs a seeded, nightly-reset dataset, and
needs its own `.env`. See [docs/demo-deployment.md](demo-deployment.md) for the pull-only
compose override, the publish-and-pull flow (GitHub Container Registry), and the full `.env`
reference (`.env.demo.example`).
