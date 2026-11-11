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
  (JSON), keywords (JSON), title_variants (JSON), title_variants_needed, locations (JSON),
  remote_pref, comp_min/max, currency, active, discovery_prompt_id (FK → prompts).
- **resume_rules**: id, user_id, rule_text, category (style | content | redaction),
  active, sort_order. Injected into every tailoring context.

### 4.3 Pipeline

- **companies**: id, user_id, name, domain, careers_url, status (`suggested` |
  `followed` | `denied` | `none`), suggestion_rationale, ats_kind, ats_ref (org
  slug), ats_verified_at, notes, naics_code, industry_source (`ai` | `user`), industry_at
  (#220). Denied companies are kept so they are never re-suggested (FR-D8).
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
and location. possible_duplicate_of names the existing opportunity a new one may
duplicate, and is written in three ways. A forced create past an exact dedupe_key
collision with a live opportunity records the one it was forced past: the user's
Create anyway, or a browser capture kept apart from the opportunity holding its
dedupe_key because every lead accepted against that opportunity is a different
posting on the capture's own site (posting identities only contradict on the same
site; `keyHolder` in captureResolve.ts). The kept-apart capture also adds a `link`
activity naming the other opportunity. A confirmed opportunity_dedupe_candidates
pair writes it on an opportunity that has none yet, whether the heuristic was
confident or the daily AI pass confirmed a pending pair.
opportunity_dedupe_candidates is a heuristic pass over opportunities that already
exist, for near-misses neither of
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
  be attached to an opportunity. Sending one is recorded in `resume_sends` instead
  (below): a send is a record, not an attachment.
- **resume_sends** (#158): id, user_id, opportunity_id, resume_id, sent_at,
  sent_via (free text: "Indeed", "Email", or the ATS name for assisted apply),
  submission_id (nullable: the assisted-apply attempt whose "I submitted it"
  recorded it), created_at. One row per send, many per resume and per
  opportunity, duplicates allowed. Recording or removing a send never writes the
  resume row. Deleting an opportunity removes its sends with it (they record what
  went to that opportunity); merging two opportunities moves the duplicate's sends
  to the one kept. A resume with a send is archived rather than deleted, as a
  submitted one is, so its sends survive (`resume_id` cascades only when something
  above it, such as the user, is deleted). **Derivation**: a resume's status and
  `submitted_at`/`submitted_to`, wherever the API shows or checks them, come from
  one function. The stored status is the document's workflow state and a send is
  a separate fact: a stored `draft` or `in_review` stands even with sends (a resume
  sent and then tailored again has unreviewed edits, and assisted apply refuses
  it), while a stored `final` or `submitted` reads `submitted` once the resume has
  a send. Where and when is the later of the newest send and the stored manual
  record (the "Submitted to" control), a send showing as "<sent_via> / <company>"
  with the company's name read at read time. Locks: `resume:<id>` is taken by
  recording a send, by deleting the resume and by "I submitted it" (right after
  the attempt's lock), always before any row write; the order is documented at
  `submissionScope`.
- **tailoring_sessions**: id, resume_id, task_run ids, transcript (JSON of
  user/assistant turns), accepted_at. Keeps the iterate-until-satisfied loop (FR-R4)
  auditable and resumable.

### 4.5 Discovery and AI

- **prompts**: id, user_id (nullable for system defaults), task_key, name, body,
  version, parent_id, is_active. Editing creates a new version; defaults are seeded
  rows, so "reset" is re-activating the seed.
- **discovery_sources**: id, user_id, kind (`ats_greenhouse` | `ats_lever` |
  `ats_ashby` | `mcp` | `feed` | `manual`), config (JSON: org slug, MCP server +
  tool, endpoint), enabled, prefilter_enabled (off: this board's postings are judged, and all
  ranked), schedule_cron, last_run_at.
- **discovery_runs**: id, source_id, role_target_id, started_at, finished_at, stats
  (JSON), error.
- **discovery_results**: id, run_id, normalized posting (JSON), dedupe_key, ai_score,
  ai_rationale, prefilter_outcome (`pass` | `filtered`), prefilter_rule (`title` | `location` |
  `remote`), prefilter_score, rank_skip_reason (`no_key` | `budget_exceeded` | `provider_error` |
  `key_rejected` | `invalid_output` | `below_cut` | `filtered`), rank_deferred_at (set while a ranking waits for the discovery budget),
  resolution (`full` | `resolved_ats` | `needs_capture` | `capture_failed`),
  resolved_source_ref (ATS posting reference when resolved), disposition
  (`pending` | `accepted` | `dismissed`), opportunity_id (when accepted).
- **dismissal_feedback**: id, user_id, opportunity_id/result_id, reason, note, at.
  Input to the prompt-refinement task (FR-D6).
- **industry_profile**: id, user_id, naics_code, tier (core | similar | adjacent), source
  (resume | target | user), reason, confirmed. One row per user and code (#219).
- **task_runs**: id, user_id, task_key, provider, model, prompt_id/version,
  input_tokens, output_tokens, est_cost, duration_ms, status, error. The cost ledger
  (FR-A5) is an aggregate over this table.

### 4.6 Network and communications

- **network_contacts** (one row per contact in the user's network; `contacts` until issue
  [#22](https://github.com/bgoleno/opportun/issues/22)): id, user_id, name, emails (JSON),
  linkedin_url, current_company_id, history (JSON), strength, notes, source (`manual` |
  `linkedin_export` | `capture`), tags (JSON).
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

| task_key                   | Purpose                                                             | Default policy shape                     |
| -------------------------- | ------------------------------------------------------------------- | ---------------------------------------- |
| resume.tailor              | Interactive tailoring chat (FR-R4)                                  | most capable configured model, streaming |
| discovery.rank             | Score posting vs role target (FR-D4)                                | mid-tier model, batched                  |
| discovery.industry_profile | NAICS industries to look in, from base resume + role targets (#219) | mid-tier; only when the user asks        |
| discovery.company_tags     | NAICS tag for each candidate company, about 20 a call (#220)        | small model, batched, nightly            |
| discovery.refine_prompt    | Propose prompt edits from dismissals (FR-D6)                        | capable model, scheduled                 |
| discovery.title_variants   | List equivalent titles for one role target (#217)                   | mid-tier; on create/rename, or nightly   |
| comms.classify             | Classify, outreach-filter, and link messages (FR-M2, FR-M8)         | small/fast model, batched                |
| opportunity.dedupe         | Duplicate and multi-recruiter repost detection (FR-O7, FR-O10)      | small model after cheap heuristics       |
| referral.rationale         | Rank referral candidates (FR-C3)                                    | mid-tier model                           |
| capture.extract            | Parse pasted job posting into fields (FR-D1)                        | small model, structured output           |
| resume.match               | Score resume vs job description with gap report (FR-R8)             | mid-tier model, structured output        |
| company.suggest            | Propose fitting companies from resume + role targets (FR-D8)        | capable model, scheduled                 |

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
  refused; a compliance test pins the list. `safeFetch` also refuses indeed.com
  and its subdomains (`PAGE_FETCH_PROHIBITED_HOSTS`, C-2), in every mode, on every
  redirect hop and with no official-API exception: Indeed pages reach Opportun
  only from the user's own browser (the capture extension) or as pasted text, so
  Capture posting with an Indeed link answers with the paste-the-text hint and
  enrichment skips Indeed links. The list is separate from LinkedIn's on purpose:
  it covers only the server fetching pages, so the MCP and AI provider guards
  check the C-1 list alone, and an MCP connector the user points at an Indeed
  host stays their choice (C-2, ADR-12).
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
  tailoring workspace: a header with the title, a link to open the document in its
  store, the match score and the status control; then the document's text (for a
  resume with no external link) and the match report; and the tailoring chat, where
  the model proposes edits as cards, each applied on its own. From `xl` the chat is
  a column on the right (the Chat width below), level with the first section, that
  stays in view while the other column scrolls; its conversation scrolls inside it,
  with the composer at the bottom. Below `xl` the sections stack, chat last, capped
  at 48rem (`max-w-3xl`). Issue
  [#35](https://github.com/bgoleno/opportun/issues/35).
- **Discovery** `/discovery` : posting review queue (keyboard-first triage, FR-U8)
  for results still pending, and a decided-results view, browsed rather than
  triaged since there is nothing left to decide, for ones already accepted or
  dismissed; company suggestion queue (accept/deny with fit rationale, FR-D8),
  sources, runs, prompt editor with version diff (FR-U6).
- **Network** `/network` (one contact at `/network/:id`; the old `/contacts` paths
  redirect here), **Settings** `/settings` (account, security, AI
  providers + per-task models + budget, integrations, import/export, jobs, audit).

SPA served by the same origin as the API; no third-party fonts or CDNs (CSP stays
`self`). Light/dark/auto theming (FR-U10) via CSS custom properties and a
`prefers-color-scheme` default, with the user's choice stored in their settings and
applied before first paint to avoid theme flash. Virtualized tables for large
histories.

### Layout widths

Desktop widths come from a few theme tokens in `apps/web/src/index.css` (`@theme`), so each is
one line to change. Tailwind turns each `--container-*` token into `max-w-*` and `w-*`
utilities. The standard and its measurements were proposed in issue
[#31](https://github.com/bgoleno/opportun/issues/31).

| Width   | Token                                     | Used for                                                                                                                                                                                                                                           |
| ------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reading | `max-w-prose` (Tailwind's built-in, 65ch) | Any block of running text: paragraphs, Markdown, the job description, timeline bodies, notes, chat messages, suggestion text, resume text. Set once in `Markdown`, `CardDescription` and `FormField`'s hint, so text through those needs no class. |
| Page    | `--container-page` (`max-w-page`)         | Every view by default. `AppShell` caps the route's content at the page cap and centres it in the main area. The cap's value is set in `index.css` and written nowhere else.                                                                        |
| Fluid   | none                                      | Boards and lists that gain from width: Pipeline (kanban and table), Discovery (every tab), the Inbox list, the Network (contacts) list.                                                                                                            |
| Rail    | `--container-rail` (20rem, `w-rail`)      | The side column of a main-plus-rail layout, from `lg`. Lay one out with `MainWithRail` (`components/MainWithRail.tsx`), not a grid of your own.                                                                                                    |
| Chat    | `--container-chat` (28rem, `w-chat`)      | The resume workspace's tailoring chat as a right-hand column from `xl`.                                                                                                                                                                            |
| Card    | `--container-card` (18rem, `grid-cards`)  | The narrowest card in a card grid. Lay one out with the `grid-cards` utility (`index.css`), see rule 2.                                                                                                                                            |

Rules that go with them:

1. **Measure belongs to the text block, not the container.** A container can be wide; a block
   of running text inside it is not. Target 65ch.
2. **Use extra width with columns, not longer lines.** Independent short items (weak-area
   cards, missing keywords, dashboard cards) flow into a card grid, `grid grid-cards`, so a
   wide area becomes two or three columns of readable cards instead of one long column. The
   utility is `repeat(auto-fit, minmax(min(var(--container-card), 100%), 1fr))`. It uses
   `auto-fit`, not `auto-fill`, so fewer cards than there is room for stretch across the row
   instead of leaving empty tracks, and `min(..., 100%)` keeps one card from overflowing a
   phone.
3. **Breakpoints stay Tailwind's defaults**, keyed on the window: main plus rail from `lg`, the
   workspace chat column from `xl`. Layouts are designed for the expanded sidebar, the narrower
   case. Container queries on the main area are out of scope.
4. **Every view is page width unless its route declares `staticData: { layout: 'fluid' }`**
   (`apps/web/src/lib/layout.ts`). A route inherits the layout of the nearest route above it
   that declares one, so a section declares it once and its header and tabs do not move between
   tabs. Going fluid is a reviewed decision: `lib/layout.test.tsx` pins where it is declared,
   so adding one changes that test.
5. **Widths come from the tokens.** Anywhere in `apps/web/src` outside `components/ui/`,
   `pnpm lint` (`opportun/no-arbitrary-width`, `apps/web/eslint/no-arbitrary-width.js`, which
   also says what it cannot see) fails:
   - an arbitrary width value with a literal length: `max-w-[70ch]`, `w-[37rem]`,
     `grid-cols-[1fr_21rem]`;
   - a numeric width step wider than 96, such as `max-w-160` or `w-97`. In Tailwind 4 these
     steps are open-ended, and 96 (24rem) is the top of its documented spacing scale, so
     anything wider is a layout width.

   These pass, on purpose:
   - tokens, including inside a track (`grid-cols-[minmax(0,1fr)_var(--container-rail)]`);
   - column splits with no length (`grid-cols-[auto_1fr]`) and column counts (`grid-cols-3`);
   - numeric steps up to 96 (`w-4`, `w-64`, `w-96`), fractions (`w-1/2`) and keywords
     (`w-full`, `w-fit`, `w-screen`);
   - squares (`size-*`);
   - Tailwind's named container sizes, `max-w-xs` to `max-w-7xl` (20rem to 80rem). These are
     an allowance, decided in [#64](https://github.com/bgoleno/opportun/pull/64): theme tokens
     like ours, from a fixed set, used for dialog and form widths and the stacked chat cap
     (`max-w-3xl`).

   A width that has to stay, such as a viewport-relative popover, carries an
   `eslint-disable-next-line` comment saying why.

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

| #      | Decision                                                                                                                                                                                                                                                  | Status                                                          |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| ADR-1  | Name "Opportun", domain opportun.app                                                                                                                                                                                                                      | Accepted 2026-10-15                                             |
| ADR-2  | Apache-2.0 license                                                                                                                                                                                                                                        | Accepted 2026-10-15                                             |
| ADR-3  | TypeScript monorepo; Fastify + React SPA; single process                                                                                                                                                                                                  | Accepted 2026-10-15                                             |
| ADR-4  | SQLite default, Postgres later; amended: Postgres backend built in iteration 4 (beta, every server test on both engines in CI, verified SQLite-to-Postgres copy tool), SQLite stays default ([docs/adr/0004-postgres.md](adr/0004-postgres.md))           | Accepted 2026-10-15, amended 2026-10-17; implemented 2026-10-17 |
| ADR-5  | DB-backed sessions, no JWT for first-party auth                                                                                                                                                                                                           | Accepted 2026-10-15                                             |
| ADR-6  | Vercel AI SDK as provider abstraction                                                                                                                                                                                                                     | Accepted 2026-10-15                                             |
| ADR-7  | MCP client support as a discovery source class                                                                                                                                                                                                            | Accepted 2026-10-15                                             |
| ADR-8  | LinkedIn via export + user-driven capture only                                                                                                                                                                                                            | Accepted 2026-10-15                                             |
| ADR-9  | Own jobs table instead of Redis-backed queue                                                                                                                                                                                                              | Accepted 2026-10-15                                             |
| ADR-10 | Apple Mail via local connector CLI, not server-side access                                                                                                                                                                                                | Accepted 2026-10-15                                             |
| ADR-11 | Local resumes (FR-R7) via optional Reactive Resume integration, not a built-in builder                                                                                                                                                                    | Accepted 2026-10-15                                             |
| ADR-12 | No embedded scrapers; community scrapers (e.g. JobSpy) only through user-configured MCP sidecars                                                                                                                                                          | Accepted 2026-10-15                                             |
| ADR-13 | Match scoring (FR-R8) recreated as an internal AI task rather than embedding Resume-Matcher                                                                                                                                                               | Accepted 2026-10-15                                             |
| ADR-14 | LAN-first access: plain HTTP over a private network is a supported path, TLS recommended but never required; nothing may assume a single canonical origin ([docs/adr/0014-lan-first-access.md](adr/0014-lan-first-access.md))                             | Accepted 2026-10-18                                             |
| ADR-15 | Assisted apply instead of direct ATS submission: Opportun prepares and records, the user submits on the ATS site ([docs/adr/0015-assisted-apply.md](adr/0015-assisted-apply.md))                                                                          | Accepted 2026-10-28                                             |
| ADR-16 | Observability by wrappers at five boundaries (routes, jobs, database, outbound requests, AI calls) with OpenTelemetry names, not auto-instrumentation and not a span per function (section 14.2)                                                          | Proposed 2026-11-10                                             |
| ADR-17 | Telemetry has a local store in the app's own database and an export, each behind its own switch and both off by default; the in-app dashboards read only the local store (sections 14.1, 14.7, 14.10)                                                     | Proposed 2026-11-10                                             |
| ADR-18 | Telemetry privacy by allowlist: only catalogued attribute keys with typed values are stored, logged or exported, checked in one gate at the sinks; export carries no user's row id, and no prompt or response content is stored for traces (section 14.8) | Proposed 2026-11-10                                             |

Accepted decisions will move into `docs/adr/` as individual records once reviewed. A Proposed decision becomes Accepted when the owner accepts it.

## 14. Observability

Requirements: FR-T1 to FR-T7, NFR-PRV6, NFR-PRV7 and NFR-OPS7. The work is tracked on
https://github.com/bgoleno/opportun/issues/340, and this section is the design every slice
follows (https://github.com/bgoleno/opportun/issues/348). **Status: designed; only FR-T1 is
built.** A name in `code` below that does not exist yet is the name its slice creates.

| Slice | Requirement                          | Issue                                          |
| ----- | ------------------------------------ | ---------------------------------------------- |
| Base  | what FR-T2 to FR-T7 build on (14.12) | https://github.com/bgoleno/opportun/issues/353 |
| O1    | FR-T1                                | https://github.com/bgoleno/opportun/issues/341 |
| O2    | FR-T2                                | https://github.com/bgoleno/opportun/issues/342 |
| O3    | FR-T3                                | https://github.com/bgoleno/opportun/issues/343 |
| O4    | FR-T4, built in two parts (14.12)    | https://github.com/bgoleno/opportun/issues/344 |
| O5    | FR-T5                                | https://github.com/bgoleno/opportun/issues/345 |
| O6    | FR-T6                                | https://github.com/bgoleno/opportun/issues/346 |
| O7    | FR-T7                                | https://github.com/bgoleno/opportun/issues/347 |

### 14.1 What it is

Everything below except FR-T1 describes the design, in the present tense. It is not shipped
behaviour until its slice merges.

Opportun measures itself with OpenTelemetry names and data shapes: metrics, traces and log
records for HTTP routes, background jobs, database access, outbound requests and, most of
all, AI calls. The data has two destinations:

- **The local store**: tables in Opportun's own database, read by the in-app dashboards
  (FR-T6, FR-T7). It fills while collection is on, so the dashboards work with export off.
- **Export**: the same data, less what identifies a user, sent over the network to a
  destination an admin names: Prometheus, Datadog, InfluxDB or any OTLP endpoint (FR-T2).

Two instance-wide switches, both admin-only:

| Switch  | Default | What off means                                                                 |
| ------- | ------- | ------------------------------------------------------------------------------ |
| Collect | off     | No recording spans, no metric points, no local store writes. Dashboards empty. |
| Export  | off     | Nothing is sent and no connection is made for telemetry (NFR-PRV1, NFR-PRV7).  |

- **Both are off by default.** Most users will not care about this feature, so an instance
  pays nothing for it (14.11) until an admin turns collection on. Export can be on only while
  collection is on.
- **On the demo deployment (`OPPORTUN_DEMO=1`) collection cannot be turned on**, because the
  demo's admin account is public (as for export, 14.10 rule 6). The switch's `PUT` answers
  403 `unavailable_on_demo` to every caller, for on and off alike.
- **Turning either on or off applies without a restart.**
- **Changing the Collect switch is audited** (`telemetry.collect.updated`, with the new
  state), as an export change is (14.10 rule 1), because turning it on starts recording every
  user's activity metadata. It needs no password re-confirmation: nothing leaves the instance.
- **With collection off the dashboards say so.** Each shows an empty state that explains
  collection is off, with a link to the switch for an admin. Rows collected earlier stay until
  they age out, and are still shown.
- **What the Collect switch does not govern:** the Usage card (FR-T1), which reads
  `task_runs`, and the server's ordinary log (NFR-OPS5). FR-T5 puts that log under the gate
  (14.8) whether or not collection is on. The events of 14.9 are part of the feature: they are
  written only while collection is on.

### 14.2 Wrappers at five boundaries

Opportun's own code creates spans and metrics at five boundaries. It does not use
OpenTelemetry auto-instrumentation, and it does not wrap every function.

| Boundary       | Where the wrapper goes                                                                                                                                                                                                              | Span                                                                   | Metric                                                    |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------- |
| HTTP route     | A Fastify plugin, `plugins/obsHttp.ts`. Spans for `/api/v1` only; the metric for every request.                                                                                                                                     | `{method} {route}`, SERVER                                             | `http.server.request.duration`                            |
| Background job | Around the whole of `processJob` in `jobs/runner.ts`, so a job that dies before its handler runs is counted too.                                                                                                                    | `job {kind}`: CONSUMER when it continues a trace (14.6), else INTERNAL | `opportun.job.duration`                                   |
| Database       | The execution choke points in `db/client.ts`: `execute` and `onConnection` on SQLite, the already-patched `queryWithCache` on Postgres.                                                                                             | none                                                                   | `db.client.operation.duration`                            |
| Outbound HTTP  | Inside `safeFetch`, which carries the ATS, company-site, OAuth and Reactive Resume requests; the `fetch` given to the AI providers, `aiProviderFetch` and `mcpClient`; and the Google API seam, `realGoogleApi` in `lib/google.ts`. | `{method}`, CLIENT                                                     | `http.client.request.duration`                            |
| AI call        | The span: the `Run` lifecycle in `packages/ai/src/router.ts`, from `prepare` to where the run is recorded. The metrics: the server's `record` dependency in `lib/ai.ts`, from the same record it writes to `task_runs`.             | `chat {model}`, CLIENT (14.5)                                          | `gen_ai.client.inference.*`, `opportun.gen_ai.usage.cost` |

Why wrappers, and why boundaries:

- **Auto-instrumentation patches modules at load time.** The server is ESM run through
  `tsx`, where that needs a loader hook registered before anything else is imported. It is
  the fragile part of OpenTelemetry on Node, for five places we own anyway.
- **Stock instrumentations record what this design forbids** (14.8): the full URL of every
  request, SQL text, host names. A wrapper sets exactly the attributes the catalog allows.
- **Database access gets a metric and no span.** A discovery run makes thousands of queries.
  A span for each would cost more than the query on SQLite and would bury the waterfall.
- **"Every function" is met at the boundaries.** A span inside a pure function says nothing
  the enclosing route or job span does not, and costs the same. A step inside a workflow that
  is worth naming gets a span of its own through `obs.span()` (14.3).

**The request's context in Fastify.** A hook cannot wrap the code that runs after it, and the
async context set in `onRequest` is lost while the body is parsed. So the plugin starts the
span in a callback-style `onRequest` hook and calls `done` inside the span's context, enters
that context again in `preValidation`, and keeps it on the request (`request.obsContext`). A
handler that starts a workflow span passes `request.obsContext` as the parent explicitly
instead of relying on the ambient one. `onResponse` ends the span.

### 14.3 One catalog, three sinks

```text
apps/server/src/obs/
  catalog.ts      every metric (name, instrument, unit, description, bucket boundaries,
                  attribute keys, scope), every span name template, every span and log
                  attribute key with its value type, every event name. It imports the
                  Gen AI names from @opportun/ai. Nothing outside it is stored or sent.
  gate.ts         the allowlist check every sink calls (14.8)
  index.ts        what the rest of the server calls: obs.record(), obs.span(), obs.event()
  config.ts       the two switches and the export settings
  metrics.ts      in-process aggregation, flushed to obs_metric_points every 60 s
  outbound.ts     the observed fetch and the wrapper safeFetch calls
  tracing.ts      the tracer provider, the async context manager, the keep rule (14.7)
  spanStore.ts    writes kept spans to obs_spans and obs_traces
  log.ts          the one pino configuration and the event writer (14.9)
  export/         the export manager and the InfluxDB writer (14.10)
packages/ai/src/telemetry.ts   the Gen AI names, the user context key, the router's span code
```

The three sinks are the local store, the log output and export.

- **Metrics** are recorded through `obs.record(metric, value, attributes, { userId })`. One
  call feeds the local aggregator and, when export is on, the OpenTelemetry instrument of the
  same name. The local point carries the user it belongs to; the exported metric never does.
  Instruments are built from the catalog, and rebuilt when the export settings change, so no
  restart is needed.
- **Spans** are OpenTelemetry spans from `@opentelemetry/api`. `packages/ai` uses the API
  directly: the package still does no IO, because the API does nothing until the server
  registers a provider. The provider (`@opentelemetry/sdk-trace` 2.x, with the
  `AsyncLocalStorageContextManager` from `@opentelemetry/context-async-hooks` and an explicit
  sampler) has two processors: the local span store, and an export slot the export manager
  fills while export is on. `sdk-trace-base` is deprecated in favour of `sdk-trace`. Its 3.x
  line needs Node 22.15 or later and `@opentelemetry/api` 1.10, while the repository allows
  any Node 22, so moving to 3.x is a separate change that raises `engines`.
- **Log records** go through pino. `obs.event()` and the error path write to the same
  logger, and the export manager attaches a log exporter to it while export is on.
- **With collection off, which is the default**, every `obs` entry point returns after one
  boolean check, no provider is registered (so a span from the API records nothing), and the
  SDK packages are not loaded. They load when an admin first turns collection on. If it is
  turned off again, the sampler records nothing from then on. With export off, the exporter
  packages are not loaded.

### 14.4 Metric names

Names follow the OpenTelemetry semantic conventions where one exists (`semantic-conventions`
1.45.0 for HTTP and database). The conventions define one duration histogram per operation:
its count is the call count, and its count where `error.type` is set is the error count. So
there are no separate count and error instruments, and the catalog exposes both as derived
series of the histogram. All points are aggregated and flushed every 60 seconds.

| Metric                                        | Instrument | Unit      | Attributes                                                                                                                                               | Scope    |
| --------------------------------------------- | ---------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `http.server.request.duration`                | Histogram  | `s`       | `http.request.method`, `http.route`, `http.response.status_code`, `error.type`                                                                           | instance |
| `http.client.request.duration`                | Histogram  | `s`       | `http.request.method`, `opportun.outbound.target`, `server.address` (fixed services only), `http.response.status_code`, `error.type`                     | instance |
| `db.client.operation.duration`                | Histogram  | `s`       | `db.system.name`, `db.operation.name`, `db.collection.name`, `error.type`                                                                                | instance |
| `opportun.job.duration`                       | Histogram  | `s`       | `opportun.job.kind`, `opportun.job.outcome` (`done`, `retry`, `dead`), `error.type`                                                                      | instance |
| `gen_ai.client.inference.duration`            | Histogram  | `s`       | `gen_ai.operation.name`, `gen_ai.provider.name`, `gen_ai.request.model`, `error.type`, `opportun.ai.task`, `opportun.ai.feature`, `opportun.ai.provider` | user     |
| `gen_ai.client.inference.usage.input_tokens`  | Counter    | `{token}` | as the duration, without `error.type`, plus `gen_ai.token.modality`                                                                                      | user     |
| `gen_ai.client.inference.usage.output_tokens` | Counter    | `{token}` | as the input counter                                                                                                                                     | user     |
| `opportun.gen_ai.usage.cost`                  | Counter    | `{USD}`   | as the duration, without `error.type`, plus `opportun.ai.cost.estimated`                                                                                 | user     |
| `opportun.obs.dropped`                        | Counter    | `{item}`  | `opportun.obs.signal`, `opportun.obs.reason`                                                                                                             | instance |

- **Low cardinality is a rule of the catalog**, not of each call site. `http.route` is the
  registered route template, or `_OTHER` when no route matched. `db.operation.name` is the
  statement's first keyword and `db.collection.name` its first table, which must be one of
  the schema's tables or it is `_OTHER`; both are parsed once per distinct SQL text and kept
  in a cache of 1,000 entries. `opportun.outbound.target` is a name from a closed list
  (`anthropic`, `openai`, `ai_compatible`, `mcp`, `google`, `oauth`, one per ATS,
  `reactive_resume`, `public_site`).
- **The Gen AI metrics come from the ledger's own record.** The server's `record` dependency
  writes the `task_runs` row and records these metrics from the same values, so the two
  cannot disagree: the tokens, the duration, and the cost estimated at the price in force
  when the call ran. `opportun.ai.cost.estimated` is true when the fallback price was used.
  A key check writes no `task_runs` row and so records no metric.
- **Input and output tokens are two metrics**, as the Gen AI conventions now define them, not
  one metric with a token-type attribute. `gen_ai.token.modality` is `text`: every task sends
  and receives text. A zero is not recorded, as the conventions require.
- **`opportun.ai.feature`** takes its values from `FEATURES` in `packages/ai/src/features.ts`,
  and `opportun.ai.task` from `TASK_KEYS`.
- **Bucket boundaries are fixed per metric in the catalog**, the same for the local store and
  for export: the conventions' own for HTTP and Gen AI, and for jobs 10 ms to 15 minutes.

### 14.5 Gen AI conventions

The Gen AI conventions are pinned at commit `e6658f14c9` of
https://github.com/open-telemetry/semantic-conventions-genai (2026-11-06). They are still
marked Development, so the names live in one file, `packages/ai/src/telemetry.ts`, which the
catalog imports, and a later change to them is a change to that file.

**One inference span per router call.** `runStructured` and `streamChat` each produce one
span, kind CLIENT, covering the whole logical call: the schema retry of `runStructured` and
the SDK's network retries are inside it, as the conventions ask. Its name is `chat {model}`
when the model has the shape of a model id (14.8), otherwise `chat`. A call the router
refuses before it reaches the provider (no key, over budget) still gets a span, with
`error.type`, so traces and `task_runs` tell the same story. A streamed call's span ends when
the stream ends, errors or is aborted. A key check (`keyCheck.ts`) gets the same span with
`opportun.ai.task` set to `key_check` and no feature.

| Attribute                                                 | Value                                                                                                                                                          |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gen_ai.operation.name`                                   | `chat`                                                                                                                                                         |
| `gen_ai.provider.name`                                    | `anthropic` or `openai`. An OpenAI-compatible endpoint is `openai`: the attribute names the wire format.                                                       |
| `opportun.ai.provider`                                    | Opportun's provider id (`anthropic`, `openai`, `openai_compatible`), which keeps a gateway apart from OpenAI.                                                  |
| `gen_ai.request.model`, `gen_ai.response.model`           | The policy's model, and the model the provider reports. Exported only when the price table lists the model, otherwise as `_OTHER` (14.8).                      |
| `gen_ai.request.max_tokens`, `gen_ai.request.temperature` | From the policy.                                                                                                                                               |
| `gen_ai.request.stream`                                   | `true` for `streamChat`.                                                                                                                                       |
| `gen_ai.output.type`                                      | `json` for `runStructured`, `text` for `streamChat`.                                                                                                           |
| `gen_ai.prompt.name`, `gen_ai.prompt.version`             | The task key, and the prompt version when the caller passes one. `opportun.ai.prompt.id` is the prompt's row id, local only.                                   |
| `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens` | As recorded in `task_runs`. Cache-read and cache-write tokens when the provider reports them and they are not zero.                                            |
| `gen_ai.response.finish_reasons`                          | From the provider's response: the AI SDK's closed list.                                                                                                        |
| `gen_ai.response.id`                                      | The provider's id for the response. Local only.                                                                                                                |
| `gen_ai.response.time_to_first_chunk`                     | Streamed calls only.                                                                                                                                           |
| `gen_ai.conversation.id`                                  | The tailoring session id, on the chat's spans only. Never invented where no conversation exists. Local only.                                                   |
| `error.type`                                              | The router's reason: `no_key`, `budget_exceeded`, `provider_error`, `invalid_output`. Never the error's text, and never anything from a provider's error body. |
| `opportun.ai.task`, `opportun.ai.feature`                 | The task key (or `key_check`) and its feature.                                                                                                                 |
| `opportun.ai.attempts`, `opportun.gen_ai.usage.cost`      | Schema attempts made (1 or 2), and the call's estimated cost in USD.                                                                                           |
| `user.id`                                                 | The caller's row id, from a new `AiDeps.userId`. Local only.                                                                                                   |

"Local only" means the local store and the local log keep the value and export drops it
(14.8).

**Content is never an attribute.** `gen_ai.input.messages`, `gen_ai.output.messages`,
`gen_ai.system_instructions`, `gen_ai.tool.definitions` and `gen_ai.prompt.variable` are not
in the catalog, so the gate (14.8) drops them even if code sets them. The span records no
exception event: an AI SDK error's message can quote the model's output.

**The AI SDK's own telemetry stays off.** It records prompts and responses by default, under
names that are not the conventions', and it turns on by itself once a telemetry integration
is registered. So every `generateText` and `streamText` call passes
`telemetry: { isEnabled: false }`, nothing calls `registerTelemetry`, and neither `telemetry`
nor the older `experimental_telemetry` is ever passed enabled. Turned off this way, the SDK
also publishes nothing on its `ai:telemetry` diagnostics channel, where any in-process
subscriber could otherwise read each call's prompts. A test checks all of it: the options,
that the SDK's global list of integrations is empty, and that a subscriber on `ai:telemetry`
receives nothing from a call through `router.ts` or `keyCheck.ts`.

**The router does no IO for this.** The `console.error` in `streamChat` becomes a call to a
new optional `AiDeps.onRecordError`, which the server wires to its logger.

**Workflows.** Where one user action leads to several AI calls, a parent span named
`invoke_workflow {name}` (kind INTERNAL, `gen_ai.operation.name` `invoke_workflow`,
`gen_ai.agent.name` the workflow's name) holds them in one trace. Opportun's code decides the
control flow, so these are workflows, not agents.

| Workflow         | Starts at                                                                     | Continues into (14.6)                      |
| ---------------- | ----------------------------------------------------------------------------- | ------------------------------------------ |
| `tailoring_chat` | `POST /tailoring/:id/messages`, one turn                                      | none                                       |
| `discovery_run`  | job `discovery.run`                                                           | `discovery.lead_resolve`, `discovery.rank` |
| `rank_backlog`   | job `discovery.rank_waiting`                                                  | none: it ranks in a loop                   |
| `capture`        | `POST /capture`, `POST /connector/capture`, `POST /opportunities/:id/posting` | `posting.reconcile`, `discovery.rank`      |
| `mail_sync`      | job `gmail.sync`, `POST /connector/mail/batch`                                | `comms.classify`, `opportunity.enrich`     |
| `company_tags`   | job `discovery.company_tags`, one call per batch                              | none                                       |

A task that makes a single call outside these (a match report, a referral rationale, title
variants and the rest) is one inference span, with no workflow parent. A new multi-call flow
adds a row here.

**Tools.** No task gives the model tools today. When one does, each tool call gets an
`execute_tool {name}` span under the inference span that asked for it. A step that is not a
model call (a fetch, a parse) is an ordinary span, never `execute_tool`.

### 14.6 Trace context

- **A trace belongs to one user or to the instance.** The plugin and the runner put the
  request's or the job's user in the context, under a key that `packages/ai/src/telemetry.ts`
  defines. When the router starts an inference span for a user who is not the one in the
  context, it starts a new trace. So `opportunity.dedupe_ai_pass`, one instance job that works
  through every user's rows, produces one trace per call, each with its own user.
- **Across the job queue, by choice.** `jobs` gets a nullable `trace_context` column (a W3C
  `traceparent` value). `enqueue` writes it only when the caller passes `continueTrace: true`,
  and the runner then starts the job's span as a child of it. Only the continuations in the
  workflow table pass it, and each of those stays within one user. Every other job starts a
  new trace. This keeps a backlog drain, a re-queued job or a fan-out over every user from
  growing one endless trace, or one that mixes users. An enqueue that finds its job already
  queued (the dedupe key) leaves that job's context as it is.
- **Nothing crosses the process boundary.** Opportun sends no `traceparent` header on any
  outbound request, and ignores one on an incoming request. No global propagator is
  registered.
- **Telemetry about telemetry is suppressed.** The store's own writes and the exporter's own
  requests run in a context that the database and outbound wrappers skip.

### 14.7 The local store

Three tables, in both dialects. The base slice creates all of them, and the `jobs` column,
in one migration pair, so no later slice adds a migration.

| Table               | One row is                                                                                                                                                                                                                      | Kept                                            |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `obs_metric_points` | One series in one time bucket: metric, attributes, owner (a user or the instance), resolution (1 minute or 1 hour), bucket start, count, sum, min, max, bucket counts.                                                          | 1-minute points 48 hours; 1-hour points 30 days |
| `obs_traces`        | One kept trace: trace id, user, start, duration, origin, workflow, feature, conversation id, the lists of its tasks, models and providers, input and output tokens, estimated cost, span count, error count, status, truncated. | 30 days                                         |
| `obs_spans`         | One kept span: span id, trace id, parent span id, user, name, kind, start, duration, status, `error.type`, attributes, and its task, model and provider in columns of their own when it is an inference span.                   | 30 days, with its trace                         |

- **Each metric flush writes the 1-minute row and adds to the 1-hour row**, so there is no
  rollup job. A prune job runs hourly: it deletes by age and enforces the row caps of 14.11.
- **The keep rule.** The local store keeps Gen AI spans (workflow and inference) and
  everything under them: the provider request under an inference span, and the span of a job
  that continues the trace, with what that job does. The keep mark travels in the context and
  in `trace_context`. A route or job that merely contains the first Gen AI span is not stored:
  its name is the trace's `origin` (a route template, or `job {kind}`). Other spans exist only
  for export.
- **Every kept trace has a user**, so `user_id` is never null in `obs_traces` or `obs_spans`.
  An AI call always runs for a user, and 14.6 gives each user's call its own trace.
- **The trace row is kept up to date as spans arrive.** Each span-store flush upserts the
  rows of the traces it touched: the earliest start, the latest end, and the sums and lists
  with the new spans added. A trace filter on task, model or provider matches a trace that has
  an inference span with that value, through the columns on `obs_spans`.
- **Who sees what.** A metric point belongs to a user (the Gen AI metrics) or to the instance
  (everything else). A user sees their own points and traces. An admin sees those of the
  instance and their own, never another user's.
- **Nothing is copied from `task_runs`.** It stays the ledger behind budgets and the Usage
  card (FR-A5, FR-T1). The points are bounded, best-effort aggregates beside it. A crash loses
  at most the last 60 seconds of points and 5 seconds of spans, and never a `task_runs` row.
- **Lifecycle.** The rows are deleted with their user. They are not part of the user data
  export (FR-I3), like `jobs`: they are derived operating data, and the three tables join the
  exporter's exclusion list. A backup contains them.
- **No content is stored.** The trace view links to where the content already lives instead
  of keeping a copy: a chat trace links to its tailoring session (by conversation id), and a
  span links to its prompt template (by prompt id).

### 14.8 The privacy rule: an allowlist, enforced at the sinks

**Rule (NFR-PRV6).** A metric, span or log record, stored or exported, carries only attribute
keys listed in the catalog, each with a value of its declared type:

| Type                    | Accepts                                                                                                                                                                       |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `enum`, list of `enum`  | values from a closed list: task keys, features, job kinds, outcomes, router reasons, finish reasons, HTTP methods, table names, the hosts of fixed public services            |
| `int`, `number`, `bool` | numbers and flags                                                                                                                                                             |
| `id`                    | a row id (UUID), or a trace or span id. Each `id` key says whether it may be exported, and by default it may not.                                                             |
| `code`                  | up to 64 characters of letters, digits, `_`, `-` and `.`: an error class, a database error code, a provider's response id                                                     |
| `model`                 | a model id: up to 128 characters, segments of letters, digits and `. _ : -`, with at most one `/` and not at the start. Anything else, such as a file path, becomes `_OTHER`. |
| `route`                 | a route template as registered, never a request's path                                                                                                                        |
| `ip`                    | an IP literal that `node:net` `isIP()` accepts. Log only: no span, metric or event carries it, so no telemetry table or exporter gets it. `client.address` is its only key.   |

So there is no place a prompt, a response, a resume, a person's name, an email address, a
phone number, an error message, a URL's path or query, SQL text or a header can go. An IP
address can go in one place only: `client.address`, the request's address in the local
access log (14.9), which no exporter sends. The rule is the absence of a field, not a pattern
that hunts for personal data.

**A shape is not what makes `code` and `model` safe: the source is.** A name can have the
shape of either. So the catalog gives every `code` and `model` key its source, and the code
that sets it may use no other:

- `error.type` is an error's class name or a fixed code. It is never taken from a provider's
  error body or from an error's message.
- `gen_ai.request.model` is the user's own policy, which is free text, and
  `gen_ai.response.model` is whatever the endpoint reports. The local store keeps the
  shape-checked value. Export sends a model only when it is a key of the price table
  (`PRICING`), and otherwise `_OTHER`, which also bounds the series at the destination.
- `gen_ai.response.id` is chosen by the endpoint, which a user may have configured. It stays
  local.

**Enforced in one place.** `obs/gate.ts` checks against the catalog, and every sink calls it:

- **Metrics** pass it in `obs.record`, before either sink, and an instrument exists only if
  the catalog lists it.
- **Spans** are rebuilt at each sink, not filtered: the local store writer and a wrapper
  around the span exporter copy out the listed attributes, take the name from a catalog
  template filled with checked values, and drop span events, links and status text. A span
  that matches no catalogued name template and kind is dropped whole and counted. That covers
  a span made with the OpenTelemetry API directly, by `packages/ai` or by any dependency.
- **Log records** are rebuilt from the finished record, in the destination that the local
  output and the log exporter both read from. A formatter is too early: in pino it never
  sees the message, a child logger's bindings, or what the error serializer writes. The gate
  keeps the catalogued keys, reduces an error to its type, code and frame lines, and keeps a
  message only when it is one the catalog lists (the fixed messages of Opportun's own log
  calls, and the event names). Any other message, such as one a library builds from a request,
  is replaced by a fixed marker and counted.

A value of the wrong type is dropped and counted in `opportun.obs.dropped`, always. A key
that is not in the catalog is dropped and counted in production, and throws in unit tests,
so a mistake in code fails CI instead of passing in silence.

**Also fixed by this rule:**

- **The resource** is exactly `service.name` (`opportun`), `service.version` and a random
  `service.instance.id` per start. No host, process or OS detectors run: `host.name` and
  `process.owner` are often a person's name.
- **`server.address`** comes from a literal list: `ATS_ALLOW_HOSTS`, the AI providers' fixed
  API hosts, and Google's. Any other host gets only its `opportun.outbound.target`: a host
  the user configured, a page they captured, and a tenant's own host such as a Workday board,
  whose name is the company's.
- **Errors** carry `error.type`, never the message. The local log keeps a stack made of frame
  lines only (`at ...`): a frame inside the install root keeps its path relative to it, a
  frame outside loses its path, and every other line of a stack, where a message can quote
  data, is dropped. The store and the export carry no stack.
- **Export identifies no user.** No row id that belongs to a user leaves the instance:
  `user.id`, `gen_ai.conversation.id`, `opportun.ai.prompt.id`, a company's id. Each would
  group the export by user. They stay in the local store and the local log, and the exporter
  wrappers drop every `id` key the catalog does not mark as exportable. Trace and span ids are
  exportable. Metrics never have a user. One limit, stated plainly: on an instance with few
  users, the timing of activity can still tell them apart.
- **No company names.** A record names a company by its row id, and that id stays local. The
  original request (https://github.com/bgoleno/opportun/issues/345) allowed a company's name
  in logs. These requirements do not: one free-text field would be the only hole in the rule,
  and a company's name can be a person's.
- **`OTEL_*` environment variables are not configuration.** The provider and the exporters
  are built from the stored settings with every option passed explicitly, so no `OTEL_`
  endpoint, header, sampler, batch or limit variable can turn export on, redirect it or add to
  it. A test sets them and asserts that a captured batch goes to the configured address with
  only the configured header.

**Tested as a property, not by example** (FR-T5): a test puts known names, email addresses
and phone numbers into every field of every event type, into span names, attributes, events
and status text, into a log message built from data, a child logger's bindings, an error's
message and extra properties, a warning a library writes, and unknown keys, with the
production behaviour for unknown keys. It asserts that none of those bytes reaches the local
store, the log output or a captured export batch. A second test walks the catalog and fails
on any key whose type is not in the table above, or whose `code` or `model` type has no
source. A third fails if an export batch contains a user's row id.

**Published.** The catalog's keys are listed in the user guide, in a table a test keeps in
step with `obs/catalog.ts`, so "only catalogued keys" is something a reader can check.

### 14.9 Logs and events

- **One logger configuration** (`obs/log.ts`) for Fastify and for everything else that logs,
  with the gate of 14.8 in its destination. It applies whether or not collection is on.
- **Requests** are logged by Opportun's own plugin, with the method, the route template and
  the route's id parameters, not the URL. Fastify's built-in request logging, which writes the
  raw URL, is turned off. The request's address stays in the local access log, as the
  log-only key `client.address` (14.8): it is never in the telemetry tables and never exported.
- **Today's log calls are brought under it.** Some pass a URL, a host or an error object, or
  build their message from data. FR-T5 changes each to catalogued keys and a fixed, catalogued
  message. Until a call is changed, the gate drops its unknown keys and replaces its message.
- **`obs.event(name, fields)`** writes one structured record: the event name, the time, the
  user id, the trace id, and the fields the catalog lists for that event. Events are part of
  the feature, so they are written only while collection is on.
- **The events** are every `audit()` action, emitted by `audit()` itself with its name and
  user and without its `detail` or address, so no call site changes; `job.finished` (kind,
  outcome, attempt); `discovery.run.finished` (source kind, counts); `settings.updated`
  (which setting, never its value); and `error`. The catalog holds the full list.
- **An error** (a thrown error in a route, a 5xx, a job that fails) writes one `error`
  record with its `error.type`, where it happened (route template or job kind) and its trace
  id. With collection off, the error is still logged as it is today, through the gate.
- **Exported log records are events and errors only.** The per-request access log stays
  local: the HTTP metric and spans already say what it says.
- **No `console.*`** in `apps/server/src` or `packages/ai/src`, and no interpolated text in a
  log message: both are lint rules, so that every message of Opportun's own is a fixed string
  the catalog can list.
- **There is no log table.** `audit_log` remains the security record in the database
  (NFR-SEC7).

### 14.10 Export

One destination at a time, set by an admin in Settings.

| Type       | Sends                 | How                                                                                                                                    | Settings                                                      |
| ---------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| OTLP       | metrics, traces, logs | OTLP over HTTP (protobuf) to `/v1/metrics`, `/v1/traces` and `/v1/logs` under the base path                                            | scheme, host, port, base path, one optional header (a secret) |
| Datadog    | metrics, traces, logs | OTLP over HTTP to the Datadog Agent's OTLP receiver (port 4318)                                                                        | host, port. No credential: the Agent holds the API key        |
| Prometheus | metrics               | OTLP over HTTP to Prometheus's own receiver, `/api/v1/otlp/v1/metrics` (Prometheus runs with `--web.enable-otlp-receiver`), cumulative | scheme, host, port, optional credential                       |
| InfluxDB   | metrics               | Line protocol to `/api/v2/write` (InfluxDB 2 and 3, and 1.8 or later), one write per interval                                          | scheme, host, port, organisation, bucket, token               |

- **Three of the four are one exporter with presets.** InfluxDB has no OTLP endpoint, and
  Telegraf's OTLP input speaks gRPC only, so InfluxDB gets a small writer of its own
  (`obs/export/influx.ts`) instead of a gRPC dependency.
- **One sender for all of them.** Batches are encoded with OpenTelemetry's OTLP transformer
  (or as line protocol) and posted by Opportun's own sender, built like the pinned request in
  `safeFetch.ts`. That gives rule 4 below, and immunity to `OTEL_*` variables, in one place,
  instead of depending on what a stock exporter's HTTP client does.
- **No scrape endpoint.** A `/metrics` page would be a new inbound surface that needs its own
  authentication. Prometheus accepts a push on its OTLP receiver, which is one code path and
  no new listener.
- **Metrics leave every 60 seconds; spans and log records in batches every 5 seconds.**
- **It applies without a restart.** Saving the settings rebuilds the exporters. Turning
  export off shuts them down, drops what is queued and closes the connections.
- **Export covers the whole instance.** It sends every user's telemetry, without saying
  whose (14.8). So every user can see that export is on, its type and which signals it
  sends, but not where to. Admins also see the last success, the last failure as a class
  (refused, timed out, TLS, authentication, 4xx, 5xx, blocked) and the drop counts.

**Where it may send (NFR-PRV7).** The server builds the URL from the fields, so a URL never
holds a credential.

1. Only an admin can turn export on or change the destination, with their password confirmed
   again as for `PATCH /admin/registration`. No operator flag is needed for a public
   destination: only catalogued metadata leaves, and it reaches nothing a public client could
   not. The change is audited with the type and signals, never the
   host or the credential.
2. By default the destination must be `https`, every address its name resolves to must be
   public (`isPrivateAddress`), and `isProhibitedHost` applies.
3. A destination on loopback or a private network, over `http` or `https`, is accepted only
   when the operator has set `OPPORTUN_TELEMETRY_ALLOW_PRIVATE=1` in the environment. This is
   the usual case for an Agent or a Prometheus beside the app, and it is an operator's
   decision, not a setting, for the same reason as `OPPORTUN_AI_ALLOW_LOOPBACK_HTTP`. The flag
   allows exactly these ranges: loopback (`127.0.0.0/8`, `::1`), private (`10.0.0.0/8`,
   `172.16.0.0/12`, `192.168.0.0/16`, `fc00::/7`) and shared address space (`100.64.0.0/10`,
   where tailnets live). Refused always, flag or not: link-local (`169.254.0.0/16`,
   `fe80::/10`), `0.0.0.0/8` and `::`, multicast and the other reserved ranges, and the
   metadata services that sit inside the allowed ranges, by exact address (`fd00:ec2::254`,
   `100.100.100.200`). A public destination over plain `http` is refused always. An
   IPv4-mapped IPv6 address (`::ffff:a.b.c.d`) is unwrapped before it is classified, as
   `mappedIpv4` in `safeFetch.ts` does, so it gets the same answer as its IPv4 address.
4. The connection is pinned to the address that was checked, redirects are never followed,
   the timeout is 10 seconds, and the response body is discarded.
5. The credential is sealed with the vault key and kept in the instance's settings row, as
   an OAuth provider's client secret is. It is never returned, and it is sent to the
   configured destination only. It is cleared whenever the type, scheme, host or port changes:
   a new scheme could send it in clear, and a new port to another service. The OTLP header's
   name is token characters only, and may not be `Host`, `Content-Length`,
   `Transfer-Encoding`, `Connection` or `Content-Type`.
6. Export is unavailable when `OPPORTUN_DEMO=1`: the demo's admin account is public.
7. "Send a test" makes one request and reports only its outcome class. It is rate-limited
   with the re-confirmation. Under the flag of rule 3 it lets an admin probe the private
   network for open ports; the operator accepted that by setting the flag.

### 14.11 Cost and overhead budget (NFR-OPS7)

| State                        | Budget                                                                                                                                                                                                                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Collection off (the default) | One boolean check per boundary: under 1 microsecond. No recording spans, no timers, no writes, SDK not loaded.                                                                                                                                                                              |
| Collection on, export off    | Under 20 microseconds of CPU per boundary crossing on average, under 2 microseconds per database statement after the first sight of its text, no IO on the request path.                                                                                                                    |
| Flushes                      | Metrics: every 60 seconds, in transactions of at most 2,000 rows (each live series writes a 1-minute row and adds to a 1-hour row). Spans: one transaction every 5 seconds or 200 spans.                                                                                                    |
| Memory                       | At most 2,000 live series and 2,000 buffered spans. Beyond that the newest are dropped and counted.                                                                                                                                                                                         |
| Storage                      | At most 250,000 metric point rows and 100,000 span rows, enforced hourly: about 100 MB together at the caps, and an estimated 40 MB or less on a single-user instance. These sizes are estimates until the base slice measures a row. A trace stops at 2,000 spans and is marked truncated. |
| Export on                    | One request per signal per interval, a queue of at most 2,048 spans and 2,048 log records, a 10-second timeout. A failure is counted and shown, never retried into a backlog, and never delays a request or a job.                                                                          |
| AI cost                      | None. Observability makes no model call.                                                                                                                                                                                                                                                    |

How it is shown: with collection off, a test drives requests, jobs and an AI call and asserts
that no row reaches any `obs_` table, that no span is recording, and that the SDK was not
loaded; a guard benchmark runs 100,000 disabled `obs` calls under a bound with a wide margin.
With collection on, a benchmark of the same loop is reported in the pull request, and the
caps are tested by exceeding them.

### 14.12 Build plan: two engineers, by file

The base slice goes first because it holds what everyone else builds on: the dependencies,
every table, the catalog and the gate. It is
https://github.com/bgoleno/opportun/issues/353. After it, the two tracks share only
`obs/catalog.ts` (FR-T4 part 2 and FR-T5 append their own entries), the route registration
block in `app.ts` (one line per slice) and the lockfile. FR-T4 is one issue built in two
parts.

| Order | Track A                            | Track B                                          |
| ----- | ---------------------------------- | ------------------------------------------------ |
| 1     | **Base**                           | **FR-T4, part 1** (`packages/ai` only)           |
| 2     | **FR-T3** server metrics and spans | **FR-T4, part 2** (server tracing and workflows) |
| 3     | **FR-T2** export                   | **FR-T5** logs and events                        |
| 4     | **FR-T6** metric dashboards        | **FR-T7** trace dashboard                        |

| Slice         | Owns                                                                                                                                                                                                                                                                                                                                                                                                   | Must not touch                           |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------- |
| Base          | `obs/catalog.ts`, `obs/gate.ts`, `obs/config.ts`, `obs/index.ts`, `obs/metrics.ts`, `obs/outbound.ts`; the three tables and `jobs.trace_context` in both schemas with the migration pair, the job claim's column mapping in `db/dialect.ts`, the exporter's exclusion list; the `continueTrace` option of `enqueue`; the prune job; the Collect switch with its admin route in `routes/obsSettings.ts` | `packages/ai`                            |
| FR-T4, part 1 | `packages/ai/src/telemetry.ts`; the spans in `router.ts` and `keyCheck.ts`; `AiDeps.userId` and `AiDeps.onRecordError` in `types.ts`; passing a `fetch` to every provider in `providers.ts`; the package's dependency on `@opentelemetry/api`                                                                                                                                                          | `apps/server`                            |
| FR-T3         | `plugins/obsHttp.ts`; the job span, the user in the context and the trace continuation in `jobs/runner.ts`; the database wrappers in `db/client.ts`; the uses of `obs/outbound.ts` in `safeFetch.ts`, `mcpClient.ts` and `google.ts`                                                                                                                                                                   | `lib/ai.ts`, job handler files           |
| FR-T4, part 2 | `obs/tracing.ts`, `obs/spanStore.ts`; `lib/ai.ts` (the Gen AI metrics, the user id, the observed fetch for the AI providers) and `aiProviderFetch.ts`; the workflow spans in the routes and job handlers of 14.5 and their `continueTrace` call sites                                                                                                                                                  | `jobs/runner.ts`, `db/client.ts`         |
| FR-T2         | `obs/export/`, the export settings in `routes/obsSettings.ts`, the Settings card for both switches, the guide's table of catalogued keys, the sealed credential, `OPPORTUN_TELEMETRY_ALLOW_PRIVATE` in `config.ts`                                                                                                                                                                                     | `obs/log.ts`                             |
| FR-T5         | `obs/log.ts`, the logger options in `app.ts`, the hook in `lib/audit.ts`, every existing log call that needs changing, the `console.*` replacements in `apps/server`, the two lint rules                                                                                                                                                                                                               | `obs/export/`                            |
| FR-T6         | `routes/obsMetrics.ts`, the dashboards page under `apps/web/src/routes/settings/`, its link from Settings, the chart component                                                                                                                                                                                                                                                                         | `routes/obsTraces.ts`                    |
| FR-T7         | `routes/obsTraces.ts`, the traces page                                                                                                                                                                                                                                                                                                                                                                 | the dashboards page, except its one link |

- **The slots between slices are part of the base.** `obs/index.ts` declares where an
  exporter attaches for each signal (metrics, spans, log records). FR-T4 and FR-T5 fill the
  span and log side, FR-T2 calls them, and neither waits for the other.
- **The base's catalog holds the five metrics that are not Gen AI** (14.4), with their
  attributes and bucket boundaries, and the `error` event, so FR-T3 adds only wrappers. It has
  no Gen AI entries: FR-T4 part 2 adds them, and the Gen AI metrics, importing the names from
  `@opportun/ai`, which part 1 has merged by then.
- **The Collect switch can be turned on from the base on**, through its admin route, so each
  later slice can be checked live. Its Settings card comes with FR-T2.
- **`obs.event()` exists from the base on**, writing through the gate to the logger that is
  there today, so FR-T3 can write its error records. FR-T5 moves it onto `obs/log.ts` and
  completes the list of events.
- **FR-T3's spans need no provider to compile or to test.** They use the API, and its tests
  register an in-memory provider. They start being stored when FR-T4 part 2 merges.
- **The dashboards build on the tables, not on the instrumentation.** FR-T6 and FR-T7 can
  start once the base is merged, against rows their own tests insert. Both scope every query
  to the caller, check a filter's attribute key against the catalog and bind its value, and
  give an admin's instance view only the points the instance owns.
- **One step is sequenced.** FR-T7 adds its link to FR-T6's dashboards page as its last
  commit, after FR-T6 has merged.
- **One chart library at most**, chosen in FR-T6 and reviewed there: it must work under the
  current Content-Security-Policy unchanged, be operable by keyboard, and sit beside a table
  of the same numbers. FR-T7's waterfall is plain markup and adds none.

### 14.13 Deviations and what is out of scope

- **`server.address` is omitted** on outbound spans and metrics to hosts that are not fixed
  public services, though the HTTP conventions require it. `server.port` and, on the server
  metric, `url.scheme` are omitted too: they say nothing here. Privacy (14.8) comes first.
- **No span per database statement**, and no `db.query.text` anywhere.
- **No exception events on spans**: `error.type` only.
- **Jobs use `opportun.job.*`**, not the messaging conventions, which are not stable and
  describe brokers.
- **Company names are not used**, though the original request allowed them in logs (14.8).
- **Out of scope:** a scrape endpoint, gRPC, more than one destination at a time, sampling
  (volume does not need it), an in-app log viewer, alerting, and storing or showing prompt or
  response content in traces.
