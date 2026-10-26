# Contributing to Opportun

Thanks for your interest. The project is currently in its design phase (milestone
M0), which shapes what contributions are useful right now.

## Now (design phase)

- **Review the docs.** [docs/requirements.md](docs/requirements.md) and
  [docs/design.md](docs/design.md) are the product. Open an issue for anything that
  seems wrong, missing, unclear, or over-engineered. Reference requirement IDs
  (FR-xx, NFR-xx) or decision log entries (ADR-x) where possible.
- **Integration knowledge welcome.** Practical experience with ATS posting APIs,
  Gmail API quotas, LinkedIn data exports, or MCP servers is especially valuable;
  the adapter designs will be revised against real-world constraints.

## Later (once M1 lands)

- Standard flow: issue first for anything non-trivial, then a focused PR.
- TypeScript, strict mode; tests accompany behavior changes; CI must be green
  (tests, typecheck, lint, security scans).
- Security-sensitive areas (auth, crypto, adapters, fetchers) get extra review;
  see [SECURITY.md](SECURITY.md) for how to report vulnerabilities privately.

## Merging

`main` is protected, and these are enforced by GitHub rather than being conventions you
have to remember:

- **Every check must pass before a merge.** Eleven checks are required: `check` and `e2e`
  on sqlite and postgres, `docker` on sqlite, postgres and sqlite-to-postgres, plus
  `Repository visibility`, `OSV vulnerability scan` and both CodeQL legs. Administrators
  are included, so there is no bypass.
- **Squash merges only.** Merge commits and rebase merges are disabled, and linear history
  is required. This is not a style preference: a feature branch's own commits can carry
  content that the branch tip no longer has, and a squash merge keeps those commits from
  ever becoming ancestors of `main`. See
  [docs/pre-publication-checklist.md](docs/pre-publication-checklist.md).
- **Branches are deleted on merge**, for the same reason: a merged branch's ref is the only
  thing keeping its own history reachable.
- **No force pushes and no deletion of `main`.**

`Dependency review` is deliberately _not_ required, because its job only runs when the
repository is public (`needs.visibility.outputs.public == 'true'`) and a required check that
never reports would make every pull request unmergeable. It is worth requiring on the day
the public repository exists.

Two ways to merge, both of which respect the required checks:

```sh
scripts/merge-when-green.sh <pr-number>   # waits for the checks, then squash merges
gh pr merge <pr-number> --squash --auto   # lets GitHub merge it when they pass
```

Either way the merged branch is deleted on the remote by a repository setting, and your local
branch is left alone, since it is usually still checked out in the worktree you worked in.

Prefer the script when you want to know the outcome in the terminal, and `--auto` when you
are leaving it unattended.

## Before pushing

`check (sqlite)` and `check (postgres)` are required checks, and between them they run four
independent gates: `lint`, `typecheck`, `format:check` and `test`. None of them implies any
other. Lint says nothing about formatting, formatting says nothing about unused imports,
typecheck says nothing about either, and the test suite says nothing about all three. Run
all four before you push, not whichever subset is top of mind:

```sh
pnpm verify
```

This runs `format:check`, `lint`, `typecheck` and `test`, in that order (fastest first), so
a formatting slip fails in seconds rather than after the suite finishes. It is a convenience
script, not a different set of checks: CI runs exactly these same four, nothing more and
nothing substituting for another (issue #318).

## Running the server tests on Postgres

CI runs the server suite twice: on SQLite (the default, needs nothing) and on Postgres 16.
To run the Postgres leg locally you need a Postgres 16 server you may create and drop
databases on (a throwaway `docker run -e POSTGRES_PASSWORD=postgres -p 5432:5432
postgres:16` works; any superuser or `CREATEDB` role does), then, in `apps/server`:

```sh
DB_DIALECT=postgres TEST_DB_DIALECT=postgres \
  TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres \
  npx vitest run
```

All three variables are needed (`DB_DIALECT` picks the schema at load time, the other two
switch the test harness). Each run migrates one template database (`opportun_tpl_*`) and
gives every test app a copy named after its test file (`opportun_t_<file>_*`), dropped
when the app closes. A failing test prints the names of its databases; set
`PG_KEEP_DATABASES=1` to keep them for inspection (drop them yourself afterwards). The
backup test also needs `pg_dump` and `pg_restore` of the server's major version on `PATH`.

## Testing `deploy/compose.yml` locally

A compose project name is a global namespace on the Docker host: every container, network
and named volume a `docker compose` invocation creates is reachable by any other checkout,
worktree or shell on the same machine that addresses the same name, regardless of
directory (issue #203, which destroyed a live deployment this way). `deploy/compose.yml`'s
own fallback name protects a real, correctly configured deployment unconditionally, but it
is shared by every unconfigured checkout, so two people (or two of your own sessions)
testing it on the same host at the same time can still collide with each other.

**Always pass an explicit `-p <something-unique>` to every `docker compose` invocation
against this file during local testing, including read-only ones** (`config`, `ps`,
`exec`), and never rely on the fallback name for isolation between test runs. A `docker
compose down -v` is correct and necessary in a test cycle; the unique `-p` is what keeps it
from reaching anything it did not create.

## Ground rules

- Be kind and assume good intent.
- No scrapers or integrations that violate a source's terms of service; compliant
  adapters only (see requirements section 8).
- All contributions are licensed under Apache-2.0.
