# Opportun: System Design

**Version:** 0.1.0
**Date:** 2026-10-15
**Companion document:** [requirements.md](./requirements.md)

---

## 1. Design principles

1. **One process, one volume.** A single Node.js service serves the API, the web UI,
   and the background workers. All durable state lives in one SQLite database plus an
   attachments directory on one volume, and backup is a file copy. The database is the
   one deliberate exception: Postgres (ADR-4, install section 15) is an optional, beta
   alternative to SQLite, running as its own process on its own volume and backed up
   with `pg_dump` rather than a file copy. The rest of this principle holds either way.
2. **Boring, auditable security.** Standard primitives (Argon2id, server-side
   sessions, AES-256-GCM, CSP) wired conventionally, not novel schemes.
3. **Adapters at every edge.** AI providers, discovery sources, mail providers, and
   document stores are all behind small interfaces. The core domain never imports a
   vendor SDK.
4. **The user can always see the strings.** Prompts are data, stored and versioned in
   the database, rendered in the UI, and editable where the requirements allow.
5. **Manual path first.** Every AI feature decorates a workflow that works without AI,
   so provider outages or missing keys never block the tracker.
6. **Report only outcomes you have observed.** Nothing returns control, closes a dialog,
   or records a result before the thing it claims has actually happened: await the write
   instead of firing it and catching nothing, let the server say which outcome occurred
   instead of inferring it on the client, and when a path degrades to a lesser input, make
   the degradation visible rather than substituting it silently. Silence here is not
   safety. It turns a failure into a false success that nobody can find afterwards, and
   the usual sign of it is a comment above the code explaining why the error is being
   discarded.

## 2. Architecture overview

```
                       ┌─────────────────────────────────────────────┐
                       │                Opportun server             │
                       │              (Node.js, one process)         │
  Browser (SPA) ─────► │  Fastify HTTP                               │
                       │  ├─ /api/*        REST API (session auth)   │
                       │  ├─ /app/*        static SPA assets         │
                       │  └─ /healthz      liveness/readiness        │
                       │                                             │
                       │  Domain services                            │
                       │  ├─ opportunities / timeline / next steps   │
                       │  ├─ resumes & tailoring sessions            │
                       │  ├─ discovery engine                        │
                       │  ├─ communications linker                   │
                       │  └─ contacts & referrals                    │
                       │                                             │
                       │  AI model router ──► provider adapters      │
                       │  Job runner (durable queue + scheduler)     │
                       │  Integration adapters                       │
                       │   ├─ Google (Docs/Drive/Gmail)              │
                       │   ├─ ATS postings (Greenhouse/Lever/Ashby)  │
                       │   ├─ MCP client (user-configured servers)   │
                       │   └─ LinkedIn export ingester               │
                       └───────────────┬─────────────────────────────┘
                                       │
                          ┌────────────┴────────────┐
                          │  Data volume            │
                          │  ├─ opportun.db (SQLite, WAL)
                          │  └─ attachments/        │
                          └─────────────────────────┘

  Later (M5): opportun-connector, a small CLI on the user's Mac that reads Apple
  Mail via macOS automation and pushes matched messages to /api/ingest with a
  device token. The server never needs access to the Mac.
```

### 2.1 Approaches considered

| Approach                                                                   | Pros                                                                                                                 | Cons                                                                                                                  | Verdict                                       |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| **A. Node monorepo: Fastify API + React SPA + in-process worker (chosen)** | One language end-to-end; single deployable; background jobs are first-class; SPA keeps API honest for future clients | SSR-less first paint; need our own auth wiring                                                                        | **Chosen**                                    |
| B. Next.js full-stack                                                      | Fastest scaffold; big ecosystem                                                                                      | Long-running sync workers and durable queues fight the serverless-shaped runtime; API locked to framework conventions | Rejected                                      |
| C. Python FastAPI + React                                                  | Strongest AI/data libraries                                                                                          | Two toolchains to build, test, and ship; heavier container                                                            | Rejected, revisit only if AI needs outgrow TS |

### 2.2 Monorepo layout

```
opportun/
├─ apps/
│  ├─ server/        Fastify app, domain services, jobs, adapters
│  └─ web/           React SPA (Vite)
├─ packages/
│  ├─ core/          domain types, zod schemas, state machines (no IO)
│  └─ ai/            model router, task registry, provider adapters
├─ docs/             requirements, design, install, ADRs
└─ deploy/           Dockerfile, compose, Caddy example
```

pnpm workspaces; strict TypeScript everywhere; `packages/core` has zero runtime
dependencies so domain logic is trivially testable.

## 3. Technology selections

All licenses MIT/Apache-2.0/ISC/BSD unless noted.

| Concern          | Choice                                                                      | Notes                                                                                                                                        |
| ---------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime          | Node.js 22 LTS                                                              | single process                                                                                                                               |
| HTTP             | Fastify 5                                                                   | schema-validated routes via zod type provider                                                                                                |
| Validation       | zod                                                                         | shared schemas in `packages/core`                                                                                                            |
| ORM/migrations   | Drizzle ORM + drizzle-kit                                                   | SQL-first, light, SQLite and Postgres dialects                                                                                               |
| Database         | SQLite (WAL) via better-sqlite3                                             | Default. Postgres 16 (node-postgres, `DB_DIALECT=postgres`) is an optional beta backend behind the same Drizzle schemas (iteration 4, ADR-4) |
| Queue/scheduler  | Own `jobs` table + in-process poller                                        | no Redis; durable, visible, testable (see §8)                                                                                                |
| Password hashing | @node-rs/argon2 (Argon2id)                                                  | parameters per OWASP guidance                                                                                                                |
| Sessions         | DB-backed opaque tokens, HttpOnly cookies                                   | no JWTs for first-party sessions                                                                                                             |
| OAuth (M2+)      | arctic                                                                      | thin OAuth 2.0/OIDC client collection                                                                                                        |
| Secrets crypto   | Node `crypto` AES-256-GCM                                                   | envelope: master key from env/keyfile, per-secret data keys                                                                                  |
| Frontend         | React 18 + Vite + TypeScript                                                |                                                                                                                                              |
| Routing/data     | TanStack Router + TanStack Query                                            | typed routes, cache invalidation per entity                                                                                                  |
| UI kit           | Tailwind CSS + shadcn/ui (vendored)                                         | accessible Radix primitives                                                                                                                  |
| AI SDK           | Vercel AI SDK (`ai`) + @ai-sdk/anthropic, @ai-sdk/openai, openai-compatible | provider-agnostic core, streaming chat for tailoring                                                                                         |
| Google APIs      | googleapis (official)                                                       | Docs, Drive, Gmail with minimal scopes                                                                                                       |
| MCP client       | @modelcontextprotocol/sdk                                                   | consume user-configured MCP servers as discovery sources                                                                                     |
| Logging          | pino                                                                        | redaction paths for secrets/PII                                                                                                              |
| Tests            | Vitest, Playwright                                                          | plus supertest-style API tests via fastify.inject                                                                                            |
| Lint/format      | ESLint + Prettier                                                           | plus eslint-plugin-security                                                                                                                  |
| CI               | GitHub Actions                                                              | test, typecheck, lint, osv-scanner, CodeQL                                                                                                   |

## 4. Data model

Conventions: `id` TEXT (UUIDv7), `created_at`/`updated_at` epoch ms, all user data
rows carry `user_id` with every query filtered through a repository layer that
requires it (FR-S5).

### 4.1 Identity and access

- **users**: id, email (unique), password_hash, display_name, is_admin, totp_secret
  (nullable, encrypted), created_at.
- **sessions**: id (hash of token), user_id, expires_at, ip, user_agent.
- **oauth_accounts** (M5): user_id, provider, provider_account_id, tokens (encrypted).
- **secrets**: id, user_id, kind (`ai_api_key` | `oauth_token` | `device_token`),
  label, ciphertext, iv, tag, key_version. Decrypted only in the adapter about to use
  them; never returned by any API.
- **audit_log**: id, user_id (nullable), event, detail (JSON, pre-redacted), ip,
  created_at.

### 4.2 Profile

- **profiles**: user_id (1:1), identity fields, links, location, work_auth.
- **role_targets**: id, user_id, name, title_family, seniority_min/max, industries
  (JSON), keywords (JSON), locations (JSON), remote_pref, comp_min/max, currency,
  active, discovery_prompt_id (FK → prompts).
- **resume_rules**: id, user_id, rule_text, category (style | content | redaction),
  active, sort_order. Injected into every tailoring context.

### 4.3 Pipeline

- **companies**: id, user_id, name, domain, careers_url, status (`suggested` |
  `followed` | `denied` | `none`), suggestion_rationale, ats_kind, ats_ref (org
  slug), ats_verified_at, notes. Denied companies are kept so they are never
  re-suggested (FR-D8).
- **opportunities**: id, user_id, company_id, role_target_id (nullable), title,
  description_md, posting_url, source_kind, source_ref, location, remote, comp_note,
  stage, stage_detail (round label), dismissed_reason, priority,
  possible_duplicate_of (nullable, another opportunity's id), created_at.
- **stage_history**: id, opportunity_id, from_stage, to_stage, note, at.
- **activities**: id, user_id, opportunity_id, kind (`note` | `meeting` | `interview`
  | `application` | `message_ref` | `stage_change` | `referral` | `link`), title,
  body_md, occurred_at, participants (JSON), external_url. The timeline is a query
  over activities + stage_history + communications.
- **next_steps**: id, opportunity_id, action, due_at, done_at, owner.
- **attachments**: id, user_id, opportunity_id (nullable), filename, mime, bytes,
  sha256, stored_path.
- **opportunity_dedupe_candidates**: id, user_id, the pair's two opportunity ids
  (ordered so each unordered pair has exactly one row regardless of which side
  triggered detection), score, decision (`pending` | `confirmed` | `rejected`),
  decided_by, created_at, updated_at. A heuristic pass (same company after name
  normalization, title overlap above a threshold) queues a near-miss pair here for
  a decision rather than asserting one.

Three mechanisms catch duplicate opportunities at different points, and the
boundary between them matters because all three can end up describing the same
pair: discovery_results.dedupe_key (§4.5) is checked within one discovery run,
before an opportunity even exists, on an exact match of normalized company, title
and location. possible_duplicate_of is set only when a user explicitly forces a
create past an exact dedupe_key collision; the new opportunity keeps a record of
which existing one it was forced past. opportunity_dedupe_candidates is a
heuristic pass over opportunities that already exist, for near-misses neither of
the others would catch (a renamed company, a reworded title). Dismissing a
possible-duplicate flag, however it was set, always records a `rejected` decision
in opportunity_dedupe_candidates, so a later heuristic run triggered by an edit to
either opportunity cannot re-propose a pair the user already rejected.

### 4.4 Resumes

- **resumes**: id, user_id, kind (`base` | `tailored`), opportunity_id (nullable),
  title, store (`google_doc` | `local_file`), doc_ref (Doc ID or path),
  parent_resume_id, status (`draft` | `in_review` | `final` | `submitted`),
  submitted_at, submitted_to, archived_at (nullable). Archiving is a second axis
  from status: deleting a submitted resume archives it (sets `archived_at`)
  rather than removing it, so its history and an opportunity's record of what was
  submitted stay intact; deleting any other resume removes it. `opportunity_id` is
  attached, moved between opportunities, or detached by distinguishing a present
  string, a present `null`, and an absent value on the update, not by three
  separate verbs; a base resume, the one tailored copies are made from, can never
  be attached to an opportunity.
- **tailoring_sessions**: id, resume_id, task_run ids, transcript (JSON of
  user/assistant turns), accepted_at. Keeps the iterate-until-satisfied loop (FR-R4)
  auditable and resumable.

### 4.5 Discovery and AI

- **prompts**: id, user_id (nullable for system defaults), task_key, name, body,
  version, parent_id, is_active. Editing creates a new version; defaults are seeded
  rows, so "reset" is re-activating the seed.
- **discovery_sources**: id, user_id, kind (`ats_greenhouse` | `ats_lever` |
  `ats_ashby` | `mcp` | `feed` | `manual`), config (JSON: org slug, MCP server +
  tool, endpoint), enabled, schedule_cron, last_run_at.
- **discovery_runs**: id, source_id, role_target_id, started_at, finished_at, stats
  (JSON), error.
- **discovery_results**: id, run_id, normalized posting (JSON), dedupe_key, ai_score,
  ai_rationale, resolution (`full` | `resolved_ats` | `needs_capture`),
  resolved_source_ref (ATS posting reference when resolved), disposition
  (`pending` | `accepted` | `dismissed`), opportunity_id (when accepted).
- **dismissal_feedback**: id, user_id, opportunity_id/result_id, reason, note, at.
  Input to the prompt-refinement task (FR-D6).
- **task_runs**: id, user_id, task_key, provider, model, prompt_id/version,
  input_tokens, output_tokens, est_cost, duration_ms, status, error. The cost ledger
  (FR-A5) is an aggregate over this table.

### 4.6 Contacts and communications

- **contacts**: id, user_id, name, emails (JSON), linkedin_url, current_company_id,
  history (JSON), strength, notes, source (`manual` | `linkedin_export` | `capture`).
- **communications**: id, user_id, channel (`gmail` | `apple_mail` | `linkedin`),
  external_id (unique per channel for idempotent sync), thread_key, from, to (JSON),
  subject, snippet, body_ref (legacy only: an attachment pointer on rows ingested
  before the body stopped being stored anywhere; no code path writes it), sent_at,
  classification, outreach_kind (`targeted` | `broadcast_spam` |
  `irrelevant`, nullable for non-outreach), mismatch_reason, confidence,
  opportunity_id (nullable), contact_id (nullable), needs_review. The body is
  never written to the database or to an attachment: it travels from ingestion to
  the comms.classify task in that job's own payload, which is cleared once the job
  finishes, so no copy of a message's text outlives classification. Outreach
  filtering acts only on these ingested copies; the user's mailbox is never
  modified (FR-M8).
- **sync_state**: user_id, integration, cursor (JSON: Gmail historyId etc.),
  last_sync_at, status.

### 4.7 Opportunity lifecycle state machine

```
discovered ──► interested ──► preparing ──► applied ──► in_process ──► offer ──► closed(accepted)
     │              │             │             │            │           │
     └─► dismissed ◄┴─────────────┴─────────────┴────────────┴───────────┴──► closed(rejected|withdrawn|ghosted)
```

Transitions are validated in `packages/core`; every transition writes stage_history;
dismissal from any stage requires no reason but accepts one (FR-O5). Reopening a
dismissed/closed opportunity is allowed and recorded.

## 5. AI subsystem

### 5.1 Task registry and model router

Each AI feature is a **task**: `{ task_key, description, default_prompt,
default_policy, input_schema, output_schema }`, registered in `packages/ai`.
Launch tasks:

| task_key                | Purpose                                                        | Default policy shape                     |
| ----------------------- | -------------------------------------------------------------- | ---------------------------------------- |
| resume.tailor           | Interactive tailoring chat (FR-R4)                             | most capable configured model, streaming |
| discovery.rank          | Score posting vs role target (FR-D4)                           | mid-tier model, batched                  |
| discovery.refine_prompt | Propose prompt edits from dismissals (FR-D6)                   | capable model, scheduled                 |
| comms.classify          | Classify, outreach-filter, and link messages (FR-M2, FR-M8)    | small/fast model, batched                |
| opportunity.dedupe      | Duplicate and multi-recruiter repost detection (FR-O7, FR-O10) | small model after cheap heuristics       |
| referral.rationale      | Rank referral candidates (FR-C3)                               | mid-tier model                           |
| capture.extract         | Parse pasted job posting into fields (FR-D1)                   | small model, structured output           |
| resume.match            | Score resume vs job description with gap report (FR-R8)        | mid-tier model, structured output        |
| company.suggest         | Propose fitting companies from resume + role targets (FR-D8)   | capable model, scheduled                 |

The **router** resolves `task_key → {provider, model, params}` from user settings
overlaid on defaults, acquires the decrypted key, enforces per-task token ceilings
and a per-day budget cap, executes via the AI SDK with zod-validated structured
outputs, and records a task_run row. Model names are configuration, never hardcoded
in task code, so new model generations are a settings change.

### 5.2 Prompt management

Prompts live in the `prompts` table, versioned. The UI shows the exact rendered
prompt for any task_run (template + variables). Discovery prompts are first-class
editable per role target; the refinement task only ever proposes a new version,
which the user diffs, edits, and activates or discards.

### 5.3 Guardrails

- Structured outputs validated with zod; invalid outputs retry once then fall to the
  manual path.
- resume.tailor runs with the user's resume rules (FR-P4) prepended and a standing
  instruction to never invent facts (C-4); the UI shows suggestions as diffs to
  accept per hunk.
- No AI output auto-sends anywhere (NG-3); writes to Google Docs happen only on an
  explicit user action.

## 6. Integration adapters

### 6.1 Interfaces (in `packages/core`)

```ts
interface DiscoverySource {
  kind: string;
  fetchPostings(cfg: SourceConfig, since?: Cursor): AsyncIterable<NormalizedPosting>;
}
interface MailProvider {
  sync(cfg, cursor): AsyncIterable<InboundMessage>; // read-only (FR-M7)
}
interface DocumentStore {
  registerExisting(ref): ResumeDocMeta;
  copyFrom(baseRef, name): ResumeDocMeta; // tailored copy (FR-R2)
  applyEdits(ref, edits): void; // only on user action
}
```

### 6.2 Notes per adapter

- **Google**: user creates their own OAuth client (documented step-by-step in
  install docs); scopes requested incrementally: `drive` + `documents` for
  resume flows (M1), `gmail.readonly` added at M2. Full `drive` rather than `drive.file`
  is a deliberate deviation (see SECURITY.md): copying a base resume the user made outside
  the app needs it, and the CSP rules out the Google Picker that `drive.file` requires. Tokens encrypted in `secrets`.
- **ATS postings** (M3): Greenhouse, Lever, and Ashby expose public JSON endpoints
  for an org's postings; adapters take an org slug, respect rate limits, and are
  pure HTTP (no keys).
- **Workday** (FR-D10, shipped in iteration 3 after a successful spike): Workday is addressed by
  **tenant plus site**, not by one org slug, so it does not fit the slug-probe shape the
  other three ATS adapters share. Two pieces, separable and worth shipping in this order:
  1. _Reference extraction, no network._ `lib/atsJobRef.ts` gains a Workday matcher for
     `https://<tenant>.<dc>.myworkdayjobs.com/<site>/job/<location>/<title>_<reqId>`,
     yielding kind `ats_workday`, board key `<tenant>/<site>`, and `externalId` = the
     requisition id (`JR-000001`). `AtsJobRef.org` is a single string today, which this
     overloads: carry `<tenant>/<site>` in it and keep the host on the source config
     (`{ host, tenant, site }`), since the datacenter label (`wd1`, `wd5`) is part of the
     host and is not derivable from the tenant. A reference alone is already useful: it
     records the posting URL on an opportunity, names the requisition, and deduplicates
     reposts.
  2. _Board adapter._ `adapters/sources/workday.ts` implementing `DiscoverySource` over
     the CXS endpoints, `POST /wday/cxs/<tenant>/<site>/jobs` (listing, paged by
     `offset`/`limit`) and `GET /wday/cxs/<tenant>/<site>/job/<externalPath>` (one
     posting, description as HTML in `jobPostingInfo.jobDescription`), through
     `sctx.fetch` with the myworkdayjobs host allowlisted, mapped into
     `NormalizedPosting` and sanitized by the engine like every other source. New source
     kind `ats_workday` in `DISCOVERY_SOURCE_KINDS` (a text column, so no migration) and
     in `ATS_SOURCE_KINDS`.

  Detection (FR-D9) must not probe Workday: there is no slug to guess. Instead
  `boardFromUrl` gains the Workday host pattern, which makes the two acquisition paths
  that already exist do the work: the careers-page scan, and a posting link in the user's
  own mail (FR-D7, and the find-posting flow for an existing opportunity). A tenant in a
  maintenance window answers 303 to `community.workday.com/maintenance-page`; that and
  any 5xx must raise `AtsDetectTransientError` rather than record `ats_kind = 'none'`, or
  a Friday-night probe would permanently mark a company boardless.

  **Spike attempt 2026-10-17 01:45 PT: blocked by Workday's weekly service window**, and
  the attempt itself settled the maintenance-detection question. Observed signals, all
  read-only:
  - `GET https://<tenant>.<dc>.myworkdayjobs.com/<site>` answers `302` to
    `https://<dc>.myworkday.com/wday/drs/outage?t=<tenant>&s=<site>` while that
    datacenter is down. It fires for **any** tenant and site, including slugs that do not
    exist, so this redirect means "come back later", never "wrong board". An adapter and
    FR-D9 detection must read it as transient; treating it as a miss would mark a company
    boardless for a week.
  - The CXS endpoints answer variously during the window: `303` to
    `community.workday.com/maintenance-page`, `422` with an empty message, or `500`
    serving an HTML page whose only content is a JavaScript redirect to that same
    maintenance page. None of these is a usable contract signal, which is why the
    listing-request shape stays unestablished.
  - A bare host root (`https://<tenant>.<dc>.myworkdayjobs.com/`) answers `406`
    regardless of `accept` and `user-agent` headers, in the window or out of it, so
    probing must address a site path, not the host root.
  - Every `wd5` tenant tried (five of them, including Workday's own) and the one
    `wd1` tenant tried (initech) were down together, which is consistent with a
    datacenter-wide weekly update rather than per-tenant maintenance.
  - Workday postings are barely indexed by web search, so a link from the user's own mail
    or a careers page is in practice the only way one arrives. This strengthens the case
    for shipping the reference extractor first.
  - `wd5` and `wd12` were both in the window at once (seven tenants in all), so the window
    is Workday-wide and not per-tenant. A `500` whose body is only a JavaScript redirect to the maintenance page
    is **not** the same signal: an unknown tenant or site answers that way too (a
    nonsense tenant on every datacenter did). Only the `302` to `wday/drs/outage` proves
    an outage; the `500` must be read as "unknown board", and the two must not be
    conflated by detection.
  - **The path shape is confirmed against real postings.** Initech's public careers site
    (`careers.initech.com`, a Phenom front end) links straight into Workday, which yielded
    ten live URLs of the form
    `https://initech.wd5.myworkdayjobs.com/Initech_Careers/job/Milpitas-California-US/Product-Manager--AI-Security--Hybrid-_1000001/apply`.
    Two refinements for the extractor: a trailing segment such as `/apply` may follow the
    requisition, and requisition ids are not all plain digits (`1000001`, but also
    `1000002-1` and Globex's `JR-000001`), so the id is "the segment tail after the last
    underscore" and must not be constrained to a digit pattern.
  - That Phenom front end is also an acquisition path worth having: a company whose
    human-facing careers site runs on another platform still publishes Workday job links
    in its HTML, which FR-D9's existing careers-page scan can harvest once `boardFromUrl`
    knows the Workday host. The scan should keep the **job** links, not only the board
    root, since those carry the requisition id.

  **Status, 2026-10-17: the spike succeeded and both pieces shipped in iteration 3.** Once
  the weekly service window ended, both CXS contracts were verified live against tenant
  `globexnetworks`, site `globexexternalcareers`: the listing
  (`POST /wday/cxs/<tenant>/<site>/jobs`, JSON body
  `{"appliedFacets":{},"limit":N,"offset":N,"searchText":""}`, paged at the site's default of 20) and the detail (`GET /wday/cxs/<tenant>/<site>/job/<externalPath without its leading
/job/>`, description HTML in `jobPostingInfo.jobDescription`). The adapter calls both with
  plain JSON requests, no browser session or landing-page visit. The verified contract is recorded at the top of
  `adapters/sources/workday.ts`; the reference extractor lives in `lib/atsJobRef.ts`, URL-only
  board detection in `jobs/atsDetect.ts`, and the find-posting flow reads Workday too. The
  blocked first attempt and its observed signals are kept above because they document the
  service window that the adapter and detection must keep treating as transient. The
  paragraph below is the spike's original charter, kept for the record.

  **The spike, before any adapter code** (timeboxed, read-only, against healthy tenants):
  pin the CXS request contract. Probing on 2026-10-17 reached the endpoints but could not
  call them blind: one tenant was in its maintenance window, one answered `HTTP 422` with
  an empty message for the documented body shape, one `303`ed on a guessed site id. The
  spike answers: the exact listing request body and headers a tenant accepts; whether a
  landing-page visit (session cookie) is a precondition; how `externalPath` from the
  listing maps onto the detail URL; what the description HTML looks like after
  `sanitizePosting`; the real path variants in the wild (`/job/...` versus
  `/details/...`); and observed rate limits. If the contract turns out to need a browser
  session, the honest outcome is to ship piece 1 only and leave descriptions to the user's
  paste (FR-O1) or an MCP connector (ADR-12).

- **MCP sources** (M3): user registers an MCP server (command or URL) and maps a
  tool to the DiscoverySource interface with a small field-mapping config. This
  reuses existing job board connectors (Indeed, Dice, ZipRecruiter) without
  Opportun shipping scrapers for sites that prohibit them (C-2).
- **ATS board detection** (M3, FR-D9): given a company name and domain, probe the
  public endpoints of supported ATS providers for likely org slugs (for example
  `boards.greenhouse.io/<slug>` and its JSON API, `jobs.lever.co/<slug>`,
  `jobs.ashbyhq.com/<slug>`) using slug candidates derived from the company name
  and domain, and fetch the company's own careers page via `safeFetch` to find ATS
  links. All of these are public, unauthenticated endpoints intended for
  consumption. A verified hit writes a discovery_source row automatically;
  periodic re-verification catches ATS migrations. company.suggest output feeds
  this detector after user acceptance, so the pipeline is: suggest, accept,
  detect, poll.
- **Job alert emails** (M3, depends on M2 mail ingestion): a DiscoverySource that
  consumes ingested messages matching known alert senders (LinkedIn, Indeed, and
  similar), with a per-board parser extracting title, company, location, and
  posting link into partial leads. Compliance rationale (C-1): the board sends
  this data to the user's own mailbox, so reading it requires no automated access
  to the board at all.
- **Lead resolution** (M3, FR-D7): a pipeline step after any source yields a
  partial lead. Deterministic first: match the lead's company against followed
  companies and ATS org slugs, then fuzzy-match title/location against that org's
  postings (same machinery as opportunity.dedupe); on a confident match, attach
  the full ATS job description and mark `resolved_ats`. No match leaves the lead
  `needs_capture`, surfaced in the review queue with its posting link for
  one-click user capture. `safeFetch` refuses linkedin.com and the other
  prohibited hosts whatever a caller's allowlist says; the allowlist (NFR-SEC6) is
  also the compliance boundary. The one exception is C-1's official-API clause:
  OAuth sign-in (FR-S4) calls exactly two official LinkedIn endpoints, the token
  URL (`www.linkedin.com/oauth/v2/accessToken`) and the OIDC userinfo URL
  (`api.linkedin.com/v2/userinfo`), after the user consents on LinkedIn. Those two
  URLs are listed in `safeFetch.ts` (`OFFICIAL_API_URLS`), each call names its one
  URL exactly, no redirect is followed, and every other LinkedIn URL is still
  refused; a compliance test pins the list.
- **LinkedIn** (M4/M5): official data export ZIP ingester (connections, messages);
  later a WebExtension that captures only pages the user visits and POSTs them to
  the user's own server (C-1).
- **Apple Mail** (M5): `opportun-connector` CLI on macOS using JXA/AppleScript to
  read matched mailboxes, filter by the user's rules, and push via HTTPS with a
  scoped device token. Keeps mail credentials off the server entirely.
- **Reactive Resume** (M5, FR-R7): optional companion service implementing the
  DocumentStore interface against Reactive Resume's API and JSON resume schema
  (MIT), giving non-Google users resume building and PDF export without Opportun
  shipping its own builder. See requirements section 11.3.

### 6.3 SSRF and fetch hygiene (NFR-SEC6)

All adapter HTTP goes through one `safeFetch` wrapper except the AI provider's
`openai_compatible` base URL path (a known gap, not a deliberate deviation, tracked in
#334): allowlisted schemes/hosts
per adapter, DNS pinning with private-range rejection (including on redirect), 15 s
timeout, 5 MB cap, and per-host token-bucket rate limits.

## 7. Security design

**Assets**: credentials and session tokens; AI keys and OAuth tokens; resume content
and private resume rules; communications; the aggregate picture of the user's search.
**Adversaries**: internet scanners hitting an exposed instance; a malicious or
compromised job posting payload (prompt injection, SSRF lures); a stolen database
file; a careless co-user on a shared install.

Controls, beyond the NFR-SEC list:

- **AuthN**: Argon2id (m=19456 KiB, t=2, p=1 initial parameters), optional pepper
  from env; opaque 256-bit session tokens stored hashed (SHA-256) server-side;
  rotation on privilege change; absolute and idle session expiry.
- **AuthZ**: repository layer requires user scope on every query (enforced by types:
  repositories take a `UserCtx`, not a raw db handle); admin-only routes gated
  centrally.
- **CSRF**: SameSite=Lax cookies plus double-submit token on unsafe methods; the SPA
  sends the token header; non-browser clients use bearer device tokens (connector).
- **Headers**: CSP `default-src 'self'` (no third-party origins at runtime by
  design), frame-ancestors none, nosniff, referrer-policy, HSTS behind the proxy.
- **Prompt injection containment**: content from postings/emails is untrusted data;
  task prompts delimit it, task outputs are structured and validated, and no task
  output can trigger an outbound action without a user click (NG-3 is the backstop).
- **Secrets**: master key (32 bytes) from `OPPORTUN_MASTER_KEY` or keyfile; AES-256-
  GCM with random IV per secret; key_version column enables rotation; DB backup
  without the key exposes no secrets. Logs redact via pino paths; task_run stores
  token counts, never raw prompts containing secrets.
- **Filesystem confinement** (NFR-SEC11): one `storage` module mediates every file
  read and write, rooted at `DATA_DIR`; no other code touches `fs` (lint-enforced).
  Candidate paths are joined to the root, realpath-resolved, and rejected if they
  escape it or traverse a symlink; attachments are stored under content-hash names
  (`sha256`) with original filenames kept only as metadata, so client input never
  forms a path. Import/export cross the boundary exclusively as HTTP streams.
  Platform layer: container runs non-root with `read_only: true` and only the
  `/data` volume writable; the bare-metal unit ships `ProtectSystem=strict` with
  `ReadWritePaths=DATA_DIR`.
- **Rate limiting**: global per-IP on auth routes, per-user on AI routes (also a
  cost control), via in-process buckets (single node by design).
- **Supply chain**: pnpm lockfile, `pnpm audit` + osv-scanner + CodeQL in CI,
  Renovate for updates, no postinstall scripts allowed (`pnpm` config).

## 8. Background processing

A `jobs` table (id, kind, payload JSON, run_at, attempts, max_attempts, locked_by,
locked_at, last_error, status) with an in-process poller (1 s interval, `UPDATE ...
RETURNING` claim). Exponential backoff with jitter; dead-letter status surfaces on
the jobs status page (NFR-OPS5). A cron-expression scheduler row materializes
recurring jobs: discovery runs, mail sync, a nightly backup, and an attachment
sweep that runs a fixed interval after it. The sweep removes attachment files
nothing references any more, once they have sat unreferenced past a grace period;
running it after backup is a safety property, not a scheduling convenience, since
a file it removes was already captured in that night's snapshot, so a wrong
deletion is still recoverable from it. Idempotency: sync jobs
upsert on external_id; discovery dedupes on dedupe_key (company + normalized title +
location). Single-writer SQLite is respected: workers run in the same process, and
write transactions are short.

## 9. Web UI

Information architecture (FR-U):

- **Dashboard** `/` : pipeline counts by stage, next steps due, upcoming interviews,
  triage queue size, recent activity.
- **Pipeline** `/pipeline` : kanban by stage + table view with saved filters.
- **Opportunity** `/opportunities/:id` : header (company, title, stage control),
  tabs: Timeline, Communications, Resume, Referrals, Details/JD.
- **Resumes** `/resumes` : base resumes, tailored versions grid; `/resumes/:id`
  tailoring workspace: left = chat with the model, right = current intro/body with
  per-hunk accept, top = status + "create Google Doc copy" action.
- **Discovery** `/discovery` : posting review queue (keyboard-first triage, FR-U8)
  for results still pending, and a decided-results view, browsed rather than
  triaged since there is nothing left to decide, for ones already accepted or
  dismissed; company suggestion queue (accept/deny with fit rationale, FR-D8),
  sources, runs, prompt editor with version diff (FR-U6).
- **Contacts** `/contacts`, **Settings** `/settings` (account, security, AI
  providers + per-task models + budget, integrations, import/export, jobs, audit).

SPA served by the same origin as the API; no third-party fonts or CDNs (CSP stays
`self`). Light/dark/auto theming (FR-U10) via CSS custom properties and a
`prefers-color-scheme` default, with the user's choice stored in their settings and
applied before first paint to avoid theme flash. Virtualized tables for large
histories.

## 10. Deployment and operations

- **Image**: multi-stage Dockerfile, distroless-style final image, non-root user,
  read-only root filesystem with `/data` as the only writable volume
  (`opportun.db`, `attachments/`, optional `master.key`) per NFR-SEC11.
- **Compose example**: opportun + Caddy (automatic HTTPS) in `deploy/`.
- **Config**: environment variables, all documented in install.md
  (`OPPORTUN_MASTER_KEY`, `OPPORTUN_BASE_URL`, `PORT`, `DATA_DIR`, SMTP for
  password reset optional, log level).
- **Migrations**: drizzle migrations run on boot inside a lock; version stamped in
  DB; refuse to boot on downgrade mismatch with a clear message.
- **Backups**: nightly job copies a consistent snapshot (`VACUUM INTO`) into
  `/data/backups`, retention configurable; restore documented and tested in CI.
- **Health**: `/healthz` (process + DB + queue lag). Logs to stdout (pino).

## 11. Testing strategy

- `packages/core`: pure unit tests (state machine transitions, schema validation,
  dedupe keys).
- `apps/server`: integration tests on a temp SQLite file via `fastify.inject`; auth,
  authz isolation (user A cannot read user B), CSRF, rate limits, import/export
  round-trip; adapter tests against recorded fixtures (no live network in CI).
- AI tasks: provider adapters mocked; golden tests validate prompt rendering and
  output-schema handling, including malformed-output fallback.
- `apps/web`: component tests for critical forms; Playwright e2e for auth →
  create opportunity → advance stage → tailor resume (mock AI) → export.
- Security gates in CI: osv-scanner, CodeQL, eslint-plugin-security, dependency
  review on PRs.

## 12. Risks and mitigations

| Risk                                  | Impact                           | Mitigation                                                                                                                                                                  |
| ------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| LinkedIn data hard to get compliantly | Network features underwhelm      | Export-first design; extension later; feature degrades to manual contacts                                                                                                   |
| Job board APIs limited/paywalled      | Discovery coverage gaps          | ATS-direct adapters + MCP reuse + manual capture; coverage is configurable, not promised                                                                                    |
| Gmail OAuth app verification friction | Setup pain for non-founder users | Users run their own OAuth client (documented); app never brokers tokens                                                                                                     |
| SQLite write contention as data grows | Slow syncs                       | WAL, short transactions, single-process workers; optional Postgres backend (iteration 4, beta), reached from existing data with the verified copy tool (install section 15) |
| AI cost creep on high-volume tasks    | Surprise bills                   | Per-task budgets, daily caps, small-model defaults, cost ledger (FR-A5)                                                                                                     |
| Prompt injection via postings/emails  | Bad links/classifications        | Untrusted-data delimiting, structured outputs, no autonomous outbound actions                                                                                               |
| Scope creep before MVP ships          | Nothing usable                   | M1 cut line excludes discovery and comms; founder dogfoods M1                                                                                                               |

## 13. Decision log

| #      | Decision                                                                                                                                                                                                                                        | Status                                                          |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| ADR-1  | Name "Opportun", domain opportun.app                                                                                                                                                                                                            | Accepted 2026-10-15                                             |
| ADR-2  | Apache-2.0 license                                                                                                                                                                                                                              | Accepted 2026-10-15                                             |
| ADR-3  | TypeScript monorepo; Fastify + React SPA; single process                                                                                                                                                                                        | Accepted 2026-10-15                                             |
| ADR-4  | SQLite default, Postgres later; amended: Postgres backend built in iteration 4 (beta, every server test on both engines in CI, verified SQLite-to-Postgres copy tool), SQLite stays default ([docs/adr/0004-postgres.md](adr/0004-postgres.md)) | Accepted 2026-10-15, amended 2026-10-17; implemented 2026-10-17 |
| ADR-5  | DB-backed sessions, no JWT for first-party auth                                                                                                                                                                                                 | Accepted 2026-10-15                                             |
| ADR-6  | Vercel AI SDK as provider abstraction                                                                                                                                                                                                           | Accepted 2026-10-15                                             |
| ADR-7  | MCP client support as a discovery source class                                                                                                                                                                                                  | Accepted 2026-10-15                                             |
| ADR-8  | LinkedIn via export + user-driven capture only                                                                                                                                                                                                  | Accepted 2026-10-15                                             |
| ADR-9  | Own jobs table instead of Redis-backed queue                                                                                                                                                                                                    | Accepted 2026-10-15                                             |
| ADR-10 | Apple Mail via local connector CLI, not server-side access                                                                                                                                                                                      | Accepted 2026-10-15                                             |
| ADR-11 | Local resumes (FR-R7) via optional Reactive Resume integration, not a built-in builder                                                                                                                                                          | Accepted 2026-10-15                                             |
| ADR-12 | No embedded scrapers; community scrapers (e.g. JobSpy) only through user-configured MCP sidecars                                                                                                                                                | Accepted 2026-10-15                                             |
| ADR-13 | Match scoring (FR-R8) recreated as an internal AI task rather than embedding Resume-Matcher                                                                                                                                                     | Accepted 2026-10-15                                             |
| ADR-14 | LAN-first access: plain HTTP over a private network is a supported path, TLS recommended but never required; nothing may assume a single canonical origin ([docs/adr/0014-lan-first-access.md](adr/0014-lan-first-access.md))                   | Accepted 2026-10-18                                             |

Accepted decisions will move into `docs/adr/` as individual records once reviewed.
