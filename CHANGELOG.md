# Changelog

Opportun has no tagged releases yet; while it is in beta, `main` is the only supported
version (see [SECURITY.md](SECURITY.md)). Entries are grouped by milestone (requirements
section 7, [docs/requirements.md](docs/requirements.md)), newest first, dated by when the
milestone's work was merged. Each links the implementation plan it was built from.

## Unreleased

- **Capturing a job posting now means "I want this".** A job captured with the browser
  extension becomes an opportunity at Interested instead of a card in the review queue, and it
  completes the lead that was already waiting for it rather than sitting beside it as a second
  one. Before this, capturing a posting you had an alert email for produced a duplicate lead
  flagged multi-posted, and capturing one you already tracked threw the description away with
  a message about a review queue that was not involved (#17, and the FR-D7 gap behind it).
  Stage moves are one-way: `discovered` and `dismissed` advance to Interested, and anything
  from `preparing` onward only gains details.
- **A captured posting is reconciled against the company's own job board.** In the background,
  Opportun looks the same job up on the company's ATS board and makes the employer's own copy
  the description, keeping whatever the captured page carried that the board's posting does
  not under a heading naming where it came from. The model selects passages out of the page
  you captured and never writes any, and each one is checked against that page before it is
  stored, so the description is only ever the employer's words and yours. The opportunity also
  records which req on which board it is, which is what makes applying through the board
  possible later. When the search cannot be settled (several plausible rows, no match, or no
  board at all) nothing is changed and the opportunity is flagged: a note on the Details tab
  carrying the action, and a **Posting unconfirmed** mark on its card on the board. A
  description you wrote or edited yourself is never overwritten, and when that is what stopped
  the merge the flag offers to look the board copy up so you can decide. The extension popup
  now says where the job went; a build from before this change still says "review queue", so
  update it.

- **The navigation fits a phone in either orientation.** A phone held in landscape clears the
  768px breakpoint on width but is only about 430px tall, so it was handed the full 14rem
  desktop sidebar: a quarter of a window that had none to spare. A header control now
  collapses the sidebar to an icon rail, the choice is remembered per browser, and a window
  under 500px tall starts collapsed so the landscape case costs no tap. In portrait the
  sidebar is hidden altogether and the destinations move into a menu behind a three-bar
  button, replacing a row of seven links that had to be scrolled sideways to reach the end of.
  Collapsed rail items keep their accessible names, and the menu marks the current page.
- **The browser extension installs from Settings**, with no checkout, Node or terminal.
  Settings > Integrations > Extensions and Connectors gains a row per connectable thing and a
  guided dialog that creates the scoped token, hands over the download for your browser and
  walks through the install. The download is assembled by your own server and carries its
  address, so the token is the only thing you paste. The image builds the extension, so this
  works on a Compose deployment out of the box; a bare-node install needs
  `pnpm --filter @opportun/extension build` first, and the card says so when it is missing.
- **The extension accepts a plain-http server on a private network** (ADR-14): localhost,
  `.local` and `.home.arpa` names, dotless hostnames, and RFC1918, CGNAT, loopback and
  link-local addresses. A public host still requires https.
- **Chrome keeps its settings across upgrades, after one more setup.** The manifest now pins
  the extension id, so from here on re-downloading after a server upgrade is the same
  extension rather than a new one with empty storage. The changeover costs one install:
  Chrome treats the pinned build as a different extension from any copy loaded before this
  change, so the new one starts with no saved address and no token. Run **Set up** once more
  to mint a fresh token (the old one cannot be recovered, since the server keeps only a hash),
  then remove the old entry in `chrome://extensions`.
- **Device tokens can be renamed** (`PATCH /device-tokens/:id`), so two of the same browser
  can be told apart.
- Capture is named for what it is rather than for one site: the permission reads **Browser
  capture**, not LinkedIn capture. The scope string `capture:push` is unchanged.

- **The Compose deployment now publishes on every interface by default** (ADR-14).
  `OPPORTUN_BIND_ADDRESS` defaults to `0.0.0.0` instead of `127.0.0.1`, so a phone, tablet or
  another computer on the same network can reach Opportun without editing anything. The
  previous default made the common household setup fail silently: the install looked fine from
  the machine itself and no other device could connect.
  **On upgrade:** an existing `deploy/.env` wins, so a deployment that sets
  `OPPORTUN_BIND_ADDRESS` keeps its current behavior. A deployment that _omits_ the line picks
  up the new default and becomes reachable from its local network. Set
  `OPPORTUN_BIND_ADDRESS=127.0.0.1` and run `docker compose up -d` to restore loopback-only.
  Opportun still requires an account and password, and is not on the internet without a domain.
- New install guide section "2.1 Reaching it from another device", covering the setting, the
  host firewall, why `OPPORTUN_BASE_URL` stays `http://localhost:8080`, and what a plain-HTTP
  network costs.

## Iteration 4: Postgres backend, beta (2026-10-17)

Opportun can run on Postgres 16 instead of SQLite (`DB_DIALECT=postgres`, `DATABASE_URL`),
as an optional beta backend; SQLite stays the default and fully supported, and a single
user needs nothing else. The data layer is async on both engines (SQLite behind an
in-process write gate), the check-then-act paths (2FA steps and recovery codes, pending
sign-ins, the first admin, job claims and dedupe, company, message and prompt writes) are
atomic under Postgres `READ COMMITTED`, search runs on `tsvector` with the same hits as
FTS5, and nightly backups become `pg_dump` archives with a documented, tested restore.
Every server test runs on both engines in CI. A verified copy tool
(`src/cli/copyToPostgres.ts`) moves an existing SQLite database into an empty Postgres
database in one transaction and proves it before committing: per-table row counts and
checksums, the search index rebuilt for the same entities, and every vault secret
decrypted again; it never touches the SQLite file, which stays the rollback. The compose
file gained an opt-in `postgres` profile, and docs/install.md section 15 covers when to
choose Postgres, the cutover and the rollback (writes made on Postgres after a cutover do
not flow back). Plan:
[iteration 4](docs/superpowers/plans/2026-10-18-iteration-4-postgres.md), decision:
[ADR-4](docs/adr/0004-postgres.md).

## M5: Hardening and reach (2026-10-17)

Accounts gained TOTP two-factor sign-in with QR enrollment and ten single-use recovery codes
(FR-S3), sign-in with Google, GitHub or LinkedIn configured by the administrator (FR-S4,
linking only from a signed-in session with the password, never by email match), an
administrator Users screen with password reset that also clears two-factor sign-in and
revokes device tokens (FR-S1), and an optional password pepper (`OPPORTUN_PEPPER`).
Scoped, revocable device tokens (FR-M5, FR-C5) feed two new clients: the
`opportun-connector` CLI, which pushes Apple Mail from a Mac into the same ingest as Gmail,
and the Opportun Capture browser extension, which sends a LinkedIn profile or job the user
is viewing to their own server (C-1). Resumes can live in a Reactive Resume 6.0.x instance
instead of Google Docs (FR-R7). Discovery reads Workday boards through their public
candidate-experience endpoints, with posting links recognized without a network call and
Workday's weekly service window treated as transient (FR-D10). The Postgres option was
assessed: the database construction seam is in place and the port itself is planned for
iteration 4 ([ADR-4 amendment](docs/adr/0004-postgres.md)). Plan:
[iteration 3](docs/superpowers/plans/2026-10-17-iteration-3-m5.md).

## Attach a posting (2026-10-17)

An opportunity tracked without its job description can get one with **Find posting**: from
an ATS link in its linked messages, or from the company's job board, detected first if
needed, with a search over the whole board when the match is not unique (FR-O1). Plan:
[attach posting](docs/superpowers/plans/2026-10-16-attach-posting.md), design:
[spec](docs/superpowers/specs/2026-10-16-attach-posting-design.md).

## M4: Network (2026-10-16)

Contacts arrive from the LinkedIn data export (connections and messages), are mapped to
companies, and are ranked by AI as referral candidates for each opportunity; referral asks
are tracked and appear on the opportunity's timeline. Plan:
[iteration 2](docs/superpowers/plans/2026-10-16-iteration-2-m3-m4.md).

## M3: Discovery (2026-10-16)

The discovery engine: pluggable sources (Greenhouse, Lever and Ashby job boards, the
user's own MCP connectors, LinkedIn and Indeed job alert emails, manual capture),
scheduled runs, AI ranking against role targets with an editable prompt, dismissal
learning through reviewed prompt changes, AI company suggestions with job board
detection, lead resolution to the canonical ATS posting, and a keyboard-driven review
queue. Plan: [iteration 2](docs/superpowers/plans/2026-10-16-iteration-2-m3-m4.md).

## M2: Communications (2026-10-15)

Read-only Gmail ingestion with cursor recovery, AI classification of recruiter mail,
automatic linking to opportunities with proposed stage transitions, broadcast-spam and
role-mismatch filtering, solicitations turned into tracked opportunities, and a unified
inbox. Plan: [iteration 1](docs/superpowers/plans/2026-10-15-iteration-1-m1-m2.md).

## M1: MVP tracker (2026-10-15)

Accounts and sessions, profile and role targets, the opportunity pipeline with timeline,
notes and documents, base and tailored resumes in the user's own Google Docs with an
iterative AI tailoring workspace and personal resume rules, CSV and zip-pack import and a
full export, nightly SQLite snapshots, and a single-container deployment behind Caddy.
Plan: [iteration 1](docs/superpowers/plans/2026-10-15-iteration-1-m1-m2.md).
