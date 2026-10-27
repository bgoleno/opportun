# Demo deployment

How the public demo instance runs (issue #290): a pull-only compose override so the host never
needs a checkout, the publish-and-pull flow that gets an image there, and the `.env` it reads.

This document produces configuration and instructions only, and changes nothing outside this
repository. Everything in #232 that needs
the owner directly — buying the host, DNS records, a certificate, and the decision to publish at
all — is out of scope here.

It assumes #280 (the seeded dataset and
nightly reset) and #284 (the resume
document store the seed needs) are in place; this page covers how the instance those issues
describe is actually stood up and kept reachable.

## Why a separate compose file

`deploy/compose.yml` declares both `build: context: ..` and `image: opportun:local` for the
`opportun` service, because the owner's own deployment builds from a checkout
(`docs/install.md` section 2). The demo host is not that: the decided shape is that builds stay
on the owner's machine and the host only ever pulls a prebuilt image.

`deploy/compose.demo.yml` layers on top of `compose.yml` to change that, the same way the
owner's own local deployment layers its own `compose.override.yml` to move state outside the
repo: the repo stays the single source of truth for the compose file itself, and the override
is the only thing that differs per environment.

```sh
docker compose -f deploy/compose.yml -f deploy/compose.demo.yml --env-file .env up -d
```

It removes the inherited `build:` section outright (`!reset null`, verified with
`docker compose config`: simply omitting or nulling the key without it is not enough and leaves
the original `build:` in the merged result) and points `image:` at a published registry
reference read from `OPPORTUN_DEMO_IMAGE_TAG`, with `pull_policy: always` so each tag is checked
against the registry rather than trusted from whatever is already cached.

That variable is required, with no working default, and is always a specific tag from a single
build — never `latest`. `latest` plus `pull_policy: always` would mean every `up -d` runs
whatever was pushed most recently, with no way to say what that is and no way back to the one
before it. #283 pinned a test fixture's
image to a digest for the same underlying reason — a mutable reference is an untracked input
that can move underneath you — and it matters more here: rollback matters exactly when something
breaks right before a demo, the worst possible moment to find there is no previous version to
name. Rolling back is setting `OPPORTUN_DEMO_IMAGE_TAG` to the previous tag and running `up -d`
again, nothing more.

## What the host actually needs on disk

"The host never needs a checkout" does not mean "nothing from this repository". Four files have
to be there, and the `up -d` command above is relative to where they sit:

```
./.env                        filled in from .env.demo.example, never committed
./deploy/compose.yml
./deploy/compose.demo.yml
./deploy/Caddyfile
```

Copy the three `deploy/` files with `scp` (or any other means) and re-copy them when they
change. Nothing automates that, on purpose: they change rarely, and a puller on the host would
be a second deployment mechanism to reason about.

A host that already runs its own proxy needs a different three: `deploy/compose.yml`,
`deploy/compose.demo.yml` and `deploy/compose.shared-proxy.yml`, and no `Caddyfile`, because
the bundled Caddy never starts there. See the next section.

Verified with `docker compose config` against a directory holding exactly those four files and
no source tree: the configuration resolves, and `build` appears nowhere in the merged result.
That is the `build: !reset null` above doing its job, and it is the whole reason the host can
get away with no checkout.

### Relative paths inside a compose file do not resolve from your shell

This catches people, so it is worth stating plainly. Compose resolves a compose file's own
relative paths against the **project directory**, which defaults to the directory of the
**first** `-f` file, not your current working directory.

So in the command above, `compose.yml`'s `./data` and `./Caddyfile` mean `deploy/data` and
`deploy/Caddyfile`, even though the command was run from their parent. `--env-file .env` is the
exception: that one is resolved relative to the current directory, because compose parses it as
a CLI argument rather than as a value inside the file.

The practical consequence is where the master key goes:

```sh
mkdir -p deploy/data
(umask 077; openssl rand -hex 32 > deploy/data/master.key)
sudo chown -R 10001:10001 deploy/data      # the uid deploy/Dockerfile fixes, for this reason
```

Put it at `./data/master.key` instead, reasoning by analogy with the command you just typed,
and Docker silently creates an empty `deploy/data`, the app finds no master key, and nothing
explains why. `docs/install.md` avoids the trap by having you `cd deploy` first; this page runs
the command from the parent, so the analogy misleads here and not there.

## If the host already runs its own proxy on :443

`compose.yml` bundles a Caddy service and publishes it on `:443`, because its canonical
deployment is a single machine where that Caddy is the only proxy. The demo host is not that
machine: it terminates TLS for the marketing site and the content sites from one Caddy already,
routed by hostname. Two processes cannot hold `:443`, so running the two documented files
unmodified there fails at `up`, with the demo down, rather than at config time.

`deploy/compose.shared-proxy.yml` is the third override for that case:

```sh
docker compose -f deploy/compose.yml -f deploy/compose.demo.yml \
  -f deploy/compose.shared-proxy.yml --env-file .env up -d
```

It gates the bundled Caddy behind a `bundled-proxy` profile, which is how compose makes a
service opt-in without deleting it, and publishes the application on `127.0.0.1:8080` so the
host's own Caddy can reach it. Verified with `docker compose config`: only `opportun` is active,
the port binds to loopback, and `--profile bundled-proxy` brings the bundled Caddy back for a
local test of the whole stack.

The host's Caddy then needs the site block, and nothing else:

```
demo.opportun.app {
	encode zstd gzip
	log {
		output file /var/log/caddy/demo-access.log {
			roll_size 10MiB
			roll_keep 10
		}
		format json
	}
	log_append actor {http.response.header.X-Opportun-Actor}
	reverse_proxy 127.0.0.1:8080
}
```

The `log` and `log_append` lines are the access log; see "Tracking demo visits" below. The log
directory must exist and be writable by the user Caddy runs as, or Caddy refuses to load the
config rather than running without a log.

### Tracking demo visits

The access log above answers who used the demo and when. One JSON line per request, and the
fields to read are:

| Question      | Field                                                                                  |
| ------------- | -------------------------------------------------------------------------------------- |
| When          | `ts` (Unix seconds)                                                                    |
| Which visitor | `actor`, e.g. `demo-user2.3fa91c04d2`: the demo account, a dot, then a per-session key |
| Real IP       | `request.client_ip`                                                                    |
| Click path    | `request.uri`, in order, for one `actor`                                               |

**Which visitor.** The demo accounts are shared logins, so two people can be signed in as
`demo-user2` at once, and Caddy cannot read the session cookie. With `OPPORTUN_DEMO=1` the app
puts `<account>.<session key>` on each signed-in `/api` response as `X-Opportun-Actor`
(`apps/server/src/plugins/session.ts`) and `log_append` copies it into the line. Every sign-in
is its own session, so each concurrent visitor gets a different `actor`, and one value is all an
analysis needs: group by `actor`, no join with the IP. The account part is a seeded label
(`demo-admin`, `demo-user1`..`demo-user4`, or `demo-other`), never an email. The key is a hash of
the session token, so it cannot be turned back into a cookie. It is stable until that session
ends, so a visitor who signs out and back in appears as a new `actor`, and the same person in two
browsers appears as two. The key is not the IP on purpose: visitors behind one office or VPN
address share an IP, and one visitor moving between wifi and cellular changes it. `actor` is
absent before sign-in and on the sign-in request itself, so the first line of a visit has an empty
`actor`; the next request carries it. A real install (`OPPORTUN_DEMO` unset) never sends the
header.

**Real IP.** `client_ip` is the real visitor only while this Caddy faces the internet directly.
If a CDN or load balancer sits in front, set `servers { trusted_proxies ... }` in the global
block, otherwise every line shows that proxy's address. This is not verified for the demo host.

**Click paths.** The web app is a single page: moving between screens makes no page request,
only the `/api` calls that screen needs. So the path is reconstructed from those calls, such as
`/api/v1/opportunities/<id>` for opening an opportunity, and it is the app's data requests, not
literally each click. Page URLs are not logged because the app sends `Referrer-Policy:
no-referrer`; that header is a deliberate security control and was left alone for this.

**What is not logged.** Caddy replaces the `Cookie` and `Authorization` request headers with
`REDACTED` by default (verified against Caddy 2.11), so session tokens do not reach the file.
Request bodies are never logged. The query string is, so do not point an OAuth callback
(`code`, `state`) at the demo without filtering it.

```sh
# Distinct visitors per day
jq -r 'select(.actor != "") | [(.ts|strftime("%Y-%m-%d")), .actor] | @tsv' \
  /var/log/caddy/demo-access.log | sort -u | cut -f1 | uniq -c
# One visitor's path, in order
jq -r 'select(.actor == "demo-user2.3fa91c04d2") | [(.ts|strftime("%H:%M:%S")), .request.uri] | @tsv' \
  /var/log/caddy/demo-access.log
```

`log_append` needs Caddy 2.7 or newer. Static asset requests (`/assets/...`) are in the file
too; filter on `request.uri | startswith("/api/")` to see only activity.

**The loopback bind is a security control, not a tidiness choice.** `0.0.0.0` there would serve
the application directly to the internet on port 8080, bypassing the proxy and everything that
sits in it.

**One link in this is unverified.** `OPPORTUN_TRUSTED_PROXIES` is pinned to the compose subnet
(`OPPORTUN_COMPOSE_SUBNET`, default `172.31.242.0/24`) because the bundled Caddy sits on that
network. A host Caddy reaching the app through a published port instead should arrive from the
bridge gateway address, which is inside that same `/24`, so the trust should hold. That has not
been exercised. Confirm it on the host before concluding the proxy is trusted, because if it is
wrong the symptom is not an error: the app silently falls back to distrusting the proxy, so
rate limits count the proxy's address instead of the client's and the `X-Forwarded-Proto`
Secure-cookie derivation stops working (ADR-14, issue #23).

```sh
# After `up -d`, with a request having gone through the host's Caddy:
docker compose ... logs opportun | grep -iE 'trusted|proxy|forwarded'
docker network inspect <project>_default --format '{{(index .IPAM.Config 0).Gateway}}'
```

If the gateway address falls outside the trusted range, widen `OPPORTUN_TRUSTED_PROXIES` to
include it explicitly rather than turning trust off, and keep it as narrow as the one address.

## The registry

GitHub Container Registry, not DigitalOcean's: the image is roughly 657 MB, over DOCR's 500 MB
free-tier limit, and storage and transfer for a public ghcr package are free.

There are two routes to push to it, below. The workflow is the normal one. The checkout route
is kept because it needs nothing but Docker and a token, which is what you want on the day the
workflow is itself the thing that is broken.

An earlier version of this section said a plain `docker push` from the building machine "uses
no GitHub Actions minutes and needs no workflow in this repository". That was a cost argument,
and it expired: standard-runner minutes are free for a public repository.

### Publishing a new build, from a workflow

Run **Publish image** (`.github/workflows/publish-image.yml`) from the Actions tab. It is
`workflow_dispatch` only, so publishing stays a decision rather than a consequence of merging,
and the run summary prints the exact `OPPORTUN_DEMO_IMAGE_TAG=` line to copy into the host's
`.env`.

It authenticates with the automatically-provided `GITHUB_TOKEN` and `packages: write`, so this
route involves no personal access token at all. It builds on a GitHub runner, which is native
amd64, which is the architecture the host needs.

### Or from a checkout, on `main`

```sh
TAG="sha-$(git rev-parse --short=7 HEAD)"
docker buildx build --platform linux/amd64 \
  -f deploy/Dockerfile -t "ghcr.io/bgoleno/opportun:$TAG" --push .
```

**`--platform linux/amd64` is not optional, and omitting it is the mistake this command exists
to prevent.** `docker build` defaults to the architecture of the machine running it. On an Apple
Silicon Mac that is arm64; the demo host is x86_64, so the pull there either refuses the
manifest ("no matching manifest for linux/amd64") or the container starts and immediately dies
with "exec format error". An image is not just the application's JavaScript: it carries
compiled machine code, including the `node` binary, the native modules for `better-sqlite3` and
`argon2`, and everything `apt-get` installed. None of that is portable between architectures.

Two smaller notes on that command. `--push` rather than a separate `docker push`, because
whether a foreign-platform image can be loaded into the local image store depends on whether
the containerd image store is enabled, and pushing straight to the registry sidesteps the
question. And `--short=7` rather than a bare `--short`, because git picks the abbreviation
length from the repository's object count: the tag gets typed into a file on another machine,
so it has to be predictable and not merely unique. The workflow slices seven characters for the
same reason.

Expect this build to take several times longer than a native one. Every step runs under
emulation, including the dependency install and the web build. Docker Desktop's Rosetta setting
for amd64 emulation helps substantially. That cost is the reason the workflow is the normal
route and this one is the fallback.

Either way, set `OPPORTUN_DEMO_IMAGE_TAG="$TAG"` in the demo host's `.env` and run `up -d`
there.

A `latest` tag is not pushed. It would be a convenience — one less value to update per
build — but it is exactly the mutable reference `deploy/compose.demo.yml`'s own comment and the
section above explain why to avoid: paired with that file's `pull_policy: always`, it removes
the ability to say which build is running or to go back to the one before it. Every build gets
its own tag instead, and `OPPORTUN_DEMO_IMAGE_TAG` is how the host is told to move to a new one
or back to an old one.

On the checkout route, `docker login ghcr.io -u bgoleno` comes first and prompts for a
password; use a GitHub personal access token with the `write:packages` scope, never the account
password. The workflow route needs none of this. The image is built from `main`, so it
carries the clean tree and none of the history concern that keeps this repository private
(`docs/pre-publication-checklist.md`) — nothing here needs the host, or anyone pulling the
image, to have the repository itself.

**The package is public, by the owner's decision on 2026-10-24.** An earlier version of this
page made Private a hard requirement, on the grounds that a public package lets anyone pull and
run the same image the demo runs. That is now the point: anyone should be able to pull the image
and run Opportun without building it (README, "Install"). Two facts made it safe to change:

- The image carries no secrets. `.dockerignore` keeps `.env`, `**/master.key`, `**/*.db`,
  `data/` and `.git` out of the build context entirely, and the runtime stage copies exactly four
  build outputs (the production server tree, the built SPA and the two extension builds). Every
  secret the demo uses arrives at runtime through the host's own `.env` and `deploy/data/`.
- The source is public, so anyone could already build an equivalent image from
  `deploy/Dockerfile`.

A package created by a workflow can inherit the visibility of the repository that pushed it, so
if it is ever recreated, check its settings
(`github.com/users/bgoleno/packages/container/opportun/settings`) rather than assuming.

### Pulling on the demo host

The package is public, so the host pulls with no `docker login` at all. This path was first
exercised end to end on 2026-10-24: `sha-d2872f6`, 12 layers, pulled in under 15 seconds on the
demo droplet.

If the package is ever made private again, the host needs a token with `read:packages` only (a
different, narrower token than the one used to push), via `docker login ghcr.io -u bgoleno`, once
per host before the first `up -d`.

## Keeping the host's disk from filling

Every deploy pulls a new ~657 MB image under its own tag, and nothing in the flow above removes
an old one. Nothing prunes build cache either: there is none to prune here, since the host never
builds, but that is exactly why it is tempting to assume disk use is bounded. It is not. A few
dozen deploys, on a host also holding the `sqlite_data` volume and `data/`, is enough to fill a
typical droplet.

This is not hypothetical. On 2026-10-21, 17.1 GB of accumulated build cache (a different cause,
same shape: Docker disk use with nothing removing old layers) filled the disk on the owner's own
machine and **stopped Docker Desktop outright, taking the live database offline with it.** On an
unattended host the same ending arrives by a different route, possibly while someone is looking
at the demo.

**After confirming a new deployment is healthy, remove images older than the current and
previous one** — keeping two, not one, preserves exactly the rollback capability
`OPPORTUN_DEMO_IMAGE_TAG` exists for:

```sh
docker images 'ghcr.io/bgoleno/opportun' --format '{{.CreatedAt}}\t{{.ID}}' \
  | sort -r | tail -n +3 | cut -f2 | xargs -r docker rmi
```

**Never run `docker volume prune`, `docker system prune --volumes`, or `docker system prune` at
all, in any form — not even its bare, no-flags form.** The `sqlite_data` volume holds the demo's
entire database, and the first two remove it directly. The third is excluded on its own,
harmless-looking form on purpose: its destructive variants are one flag away, and a habit of
reaching for the safe-looking bare command is what makes reaching for the dangerous one, one day
without thinking, easy. `docker image prune` and `docker rmi` of specific ids, as above, never
touch a volume; there is no safe reason to need the wider command at all on this host.

## Backups

No script outside the app itself backs up the demo host, and that is intentional: the demo
wipes and reseeds every account and all of its data at 04:30 server time, right after the app's
own 03:00 nightly job (`docs/install.md`), so nothing accumulates on this host that is worth
preserving from one day to the next. A day's demo activity is gone at the reset regardless of
whether anything backed it up first. **That reasoning is the thing that should stop someone
"fixing" the absence of a backup script here by adding a plain `cp` of `opportun.db` to a cron
job later** — there is nothing on this host worth the risk a `cp` carries.

If you do need a one-off snapshot of this host before touching it (before an upgrade, say, not
as a standing job), the only safe way to take one is the app's own Settings → Import/Export →
**Back up now**. It uses the same `VACUUM INTO` mechanism as the app's nightly backup job and
the `backup.ts` CLI (`docs/install.md`): a transactionally-consistent snapshot taken through
SQLite's own connection, safe to run while the server is up. **Do not instead take a live `cp`
of `opportun.db`.** The database runs in WAL mode: a row the server already told a client was
saved can still be sitting in `opportun.db-wal`, not yet folded into the main file, so a plain
file copy can be missing recent data, and one taken while a write is in progress has no
transactional boundary to land on either side of. This is not a new risk invented for the demo:
it is the same hazard the owner's own separate pre-upgrade script (`opportun.sh`, not part of
this repository) now deliberately refuses to run against a SQLite backend, for exactly this
reason.

## The `.env`

`.env.demo.example`, at the repository root, carries variable names and placeholder values
only — never a real password or key (see the hard constraint below). Copy it to the demo host's
own `.env`, outside this repository, and fill in every blank:

- `COMPOSE_PROJECT_NAME` — required explicitly (issues #203/#208): a compose project name is a
  global namespace on the Docker host, not scoped by directory, and this deployment must not
  land on `compose.yml`'s own deliberately-unsafe fallback name the way an unconfigured checkout
  does.
- `OPPORTUN_DEMO_IMAGE_TAG` — required, no default, always a specific tag from the publish step
  above, never `latest` (see why above). Changing it and running `up -d` again is the whole
  redeploy and rollback procedure.
- `OPPORTUN_DEMO` plus the six credential variables `#280` settled on
  (`OPPORTUN_DEMO_ADMIN_PASSWORD`, `OPPORTUN_DEMO_USER1_PASSWORD` through `USER4`,
  `OPPORTUN_DEMO_AI_KEY`) — read by that issue's seeder once it lands, not by anything in this
  change. The AI key alone also accepts `OPPORTUN_DEMO_AI_KEY_FILE` in its place, following the
  server's own `_FILE` convention (`OPPORTUN_MASTER_KEY_FILE`, `DATABASE_URL_FILE`); see
  **The AI key: file or inline** below. The five passwords stay plain values — they are handed
  to invited visitors by design, so a file does not narrow their exposure the way it does for a
  key nothing else is meant to see.
- `OPPORTUN_PEPPER`, generated fresh for this deployment (`docs/install.md` section 4): the demo
  is a real deployment hashing real passwords, not a special case that can skip it.
- The ordinary domain and port settings `docs/install.md` section 3 already documents for
  exposing any deployment to the internet (`OPPORTUN_DOMAIN`, `OPPORTUN_BASE_URL`,
  `OPPORTUN_BIND_ADDRESS`, `OPPORTUN_HTTP_PORT=80`, `OPPORTUN_HTTPS_PORT`).

## The AI key: file or inline

`OPPORTUN_DEMO_AI_KEY` as a plain environment variable is readable by anything that can run
`docker inspect` on the host, and it surfaces in process listings and crash dumps. This
repository's `_FILE` convention exists specifically to avoid that: `OPPORTUN_MASTER_KEY_FILE`
points at `/data/master.key`, and `DATABASE_URL_FILE` exists alongside `DATABASE_URL`.

Issue #314 extended the same convention to this key: set `OPPORTUN_DEMO_AI_KEY_FILE` to
`/data/demo-ai.key` and put the real value at `./data/demo-ai.key` on the host, next to
`master.key` and with the same restrictive permissions (`docs/install.md` section 4 covers
`/data` generally). `compose.demo.yml` already bind-mounts `./data` to `/data` for `master.key`,
so no further compose change is needed to make a second file in the same directory visible to
the container.

`docker compose up` refuses to start with neither `OPPORTUN_DEMO_AI_KEY_FILE` nor
`OPPORTUN_DEMO_AI_KEY` set, the same fail-fast guarantee #311 gave the single inline variable;
see the `x-opportun-demo-ai-key-required` comment in `compose.demo.yml` for how. If both are
set, the file wins: `cli/seedDemo.ts`'s `credsFromEnv` reads the file first and only falls back
to the inline value when no file variable is present.

The plain env var is kept, not removed: on this single-operator host the AI key's own blast
radius is bounded by the provider-side spend limit below regardless of how it reaches the
container, so `OPPORTUN_DEMO_AI_KEY` is a real convenience, not a mistake to migrate away from
urgently. The file form is simply the narrower exposure, and the one `.env.demo.example`
recommends.

## Before the instance is reachable: a provider-side spend limit

Set a hard spend limit on the Anthropic key in `OPPORTUN_DEMO_AI_KEY` (or the key held by
`OPPORTUN_DEMO_AI_KEY_FILE`), in the [Anthropic console](https://console.anthropic.com),
**before** DNS points at the host. All 13 default task policies are `anthropic`, so this is the
only provider to configure.

This is not optional, and it is not the same protection as `#280`'s in-app per-user
`ai_budget`. That budget stops one visitor's usage from spoiling the demo for the next person,
which is real and worth having, but `#280`'s nightly reset deletes and re-seeds the five demo
users, which erases the ledger that budget is checked against. The reset, not just the
calendar, is what repeatedly hands every account a fresh allowance — a manual reset right before
a demo does the same thing immediately. The provider's bill does not reset with it, so it is the
only backstop on actual spend.

## DNS before the first start, not after

`OPPORTUN_DOMAIN` turns on Caddy's automatic HTTPS, and that means the _first_ `up -d` with it
set triggers an ACME challenge: Let's Encrypt has to reach this host on port 80, by the domain
name, to prove it controls it. That needs two things already true, not merely in progress: DNS
for the domain already resolving to this host, and `OPPORTUN_HTTP_PORT=80` (the example in
`.env.demo.example` already sets this, for exactly this reason, not just to match a household
deployment's port choice).

Starting before DNS has propagated fails issuance in a way that is confusing to diagnose: the
container comes up, the app is healthy on the compose network, and HTTPS simply does not work,
with nothing on the compose side saying why. Worse than a one-time failure: Let's Encrypt
rate-limits failed authorizations, so restarting to "try again" while DNS is still propagating
can turn a five-minute wait into a much longer lockout. Point DNS at the host, confirm it
actually resolves (`dig demo.opportun.app`, from a machine that isn't the host itself, so a
stale local resolver cache can't hide the problem), and only then run `up -d`.

The domain itself is settled, not an example: `demo.opportun.app`, confirmed by the owner on
2026-10-22. The marketing site keeps the apex (`opportun.app`); this subdomain is the demo
instance only, and the two should stay that way — the marketing site should not gain a "try the
demo" link, since the demo is invitation-only with credentials handed out directly, and a public
link to an instance five people have passwords for undoes that the moment someone adds it.

## Seed before the instance is reachable

**The server does not seed the demo accounts when it starts.** With `OPPORTUN_DEMO=1` it only
registers the nightly reset (`app.ts`, the `30 4 * * *` schedule), so a fresh instance has an
empty database until 04:30. An empty database is the dangerous state: the first account on any
instance is always allowed to register and becomes the administrator (`lib/registration.ts`), so
whoever reaches a fresh, routed instance first owns it.

So the first start is three steps, in this order, before the proxy routes the domain here:

```sh
docker compose ... up -d
docker compose ... exec opportun node --import tsx src/cli/seedDemo.ts
curl -s http://127.0.0.1:8080/api/v1/auth/registration     # must print {"open":false}
```

The seed prints `Seeded 5 accounts, ...`. The registration check is the gate: until it reports
`false`, do not enable the site in the host's proxy. Found on the first real deployment
(2026-10-24), where the app was healthy, the logs showed no seeding, and the instance was one
proxy reload away from open registration. The API prefix is `/api/v1`, not `/api`.

Nothing to add for this: `seedDemo.ts` also requires `OPPORTUN_DEMO_SEED_ACK=1`, which
`deploy/compose.demo.yml` sets as a literal in its own `environment:` block (not read from
`.env`), so it is already in the running container's environment by the time you `exec` the
seed. It exists so a stray `OPPORTUN_DEMO=1` on a deployment that never applied this overlay
cannot silently become a self-wiping demo; do not add it to `.env` by hand.

Re-running the seed later is safe: it deletes and recreates only the five pinned demo
accounts. It is also how rotated passwords take effect immediately rather than at 04:30, with
one ordering rule: `up -d` first, so the container is recreated with the new `.env`. `exec`
inherits the environment the container started with, so seeding before recreating would
re-seed the old passwords.

## Hard constraints on anything added to this deployment

**No credentials, keys or passwords in this repository, including in a template.** Variable
names and placeholders only, here and in any future edit to this file or
`.env.demo.example` — this tree ships into a public snapshot
(`docs/pre-publication-checklist.md`), and a real value committed here would be published
alongside a live instance that accepts it.

**No real hostnames, machine names or personal paths**, per that same checklist's identifier
sweep. `opportun.app` and `demo.opportun.app` are already public and are fine to reference
directly.
