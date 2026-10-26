# Opportun: Requirements

**Status:** Draft for review (pre-implementation)
**Version:** 0.1.0
**Date:** 2026-10-15
**License of this document:** Apache-2.0 (same as the project)

---

## 1. Vision

Opportun is an open source, self-hostable web application that manages the complete
lifecycle of a job search for technology professionals: defining what you are looking
for, discovering opportunities, tailoring and tracking resumes, managing applications
and interviews, tracking every related communication, and learning from your decisions
to make discovery better over time.

The application is AI-assisted but model-agnostic. Users bring their own AI provider
credentials (Anthropic, OpenAI, or any OpenAI-compatible endpoint, including local
models) and the application routes each task to the most effective and efficient model
for that task. Every AI prompt used by the system is visible and editable by the user,
and no AI-generated content is ever sent anywhere without explicit user approval.

Opportun is private by design: it runs on the user's own machine or server, stores
data locally, and sends nothing to third parties except the integrations the user
explicitly connects (their own Google account, their own AI provider accounts, job
board APIs).

## 2. Goals

- G-1: Manage the full job search lifecycle in one place, from discovery to offer.
- G-2: Be a production-quality, secure application that can safely run on a server
  reachable from the public internet.
- G-3: Use only open source, lightweight components; deploy as a single container with
  an embedded database by default.
- G-4: Integrate with the user's AI model of choice, routing each task to an
  appropriate model and variant for cost and quality.
- G-5: Keep the human in control: transparent prompts, editable discovery criteria,
  approval gates on all outbound content.
- G-6: Be genuinely open source: public repository, OSI-approved license, documented
  setup, no telemetry by default.

## 3. Non-goals

- NG-1: Not a job board or a multi-tenant SaaS product. The target deployment is one
  installation per user or household, with support for a small number of accounts.
- NG-2: No credentialed scraping of sites that prohibit it. LinkedIn and similar
  integrations use official exports, official APIs, or user-driven capture only
  (see section 8).
- NG-3: No fully automated or mass outreach. Opportun is not a bulk-application
  tool: there is no apply-to-all flow, and the product never optimizes for
  submission volume. Each opportunity is individually assessed, and every
  submission is customized and pre-reviewed by the user before it goes out. The
  application never sends an email, message, or application without the user
  pressing send. Features that would mainly enable application spam are rejected
  even when technically easy.
- NG-4: No mobile apps in scope. The web UI should be responsive, but native apps are
  out of scope.
- NG-5: Not an applicant tracking system for employers. The user is the candidate.

## 4. Users and personas

- **P-1 Self-hosted job seeker (primary).** A technology professional running the app
  locally or on a personal server, managing an active search. The project founder is
  the first test user.
- **P-2 Returning user.** A past user who reactivates an old installation for a new
  search and needs their history, contacts, and learned preferences intact.
- **P-3 Administrator.** In small shared installs, the person who manages accounts and
  upgrades. In single-user installs this is the same person as P-1.

## 5. Functional requirements

Requirement IDs are stable and intended to be referenced from issues and commits.
Priority: **P0** (MVP, milestone M1), **P1** (near-term, M2/M3), **P2** (later).

### 5.1 Profiles and role targets (FR-P)

- FR-P1 (P0): A user can create a profile holding identity and demographic
  information: name, contact details, location, work authorization, and links
  (LinkedIn, GitHub, personal site).
- FR-P2 (P0): A user can define one or more **role targets**, each describing a kind
  of role they are seeking: title family (for example "Principal Product Manager"),
  seniority range, industries, keywords, location and remote preference, and
  compensation range. Multiple simultaneous role targets in different industries
  must be supported.
- FR-P3 (P0): Each role target carries its own discovery criteria and its own
  discovery prompt (see FR-D4).
- FR-P4 (P0): A user can record **resume rules**: durable, personal constraints that
  all resume tailoring must follow (for example house style of the introduction,
  which experience window the resume presents, phrasing rules). The AI tailoring
  pipeline must always apply these rules. Resume rules are private to the user and
  never leave the account except as applied text in the resume itself: they are
  not sent to anyone else, shared, or published. The user's own full-data export
  (FR-I3) includes them as part of the user's own backup of their own data, which
  is not a route by which they leave the account.
- FR-P5 (P2): A user can import profile data from their LinkedIn official data export.

### 5.2 Resume management (FR-R)

- FR-R1 (P0): Track one or more **base resumes** and any number of
  **tailored versions**, each linked to the opportunity it was created for.
- FR-R2 (P0): Integrate with Google Docs through the user's own Google account:
  register an existing Doc as the base resume, create a tailored copy per opportunity
  (following a configurable naming convention), and store the Doc link and revision
  references for each version.
- FR-R3 (P0): Record the status of each resume version (draft, in review, final,
  submitted) and where and when it was submitted.
- FR-R4 (P0): AI tailoring: given an opportunity's job description and the base
  resume, suggest modifications to the resume introduction and body. The user
  iterates with the assistant through as many rounds as needed and explicitly marks
  the version ready. The system never edits the Google Doc without the user
  triggering the write.
- FR-R5 (P0): Apply the user's resume rules (FR-P4) in every tailoring interaction.
- FR-R7 (P2): Support resume storage that does not depend on a Google account, as an
  alternative to Google Docs. The implementation is an optional integration with a
  user's own Reactive Resume instance, not a built-in local-file (Markdown/DOCX/PDF)
  resume builder (see section 11.3).
- FR-R8 (P1): Match scoring: score a resume version against the opportunity's job
  description and show a keyword and competency gap report in the tailoring
  workspace before submission.
- FR-R9 (P2): Optional cover letter generation, reusing the tailoring machinery and
  resume rules. The default remains a tailored resume introduction in place of a
  cover letter.

### 5.3 Opportunity tracking (FR-O)

- FR-O1 (P0): Persist opportunities with: company, role title, source, job
  description, posting URL, location/remote, compensation data, and free-form notes.
  The description and posting URL are fillable after creation, not only at it: one
  action looks the posting up (the job id in a linked message first, then the
  company's ATS board per FR-D7/FR-D9) and the fields stay editable by hand. The
  description is stored as text, not only linked, so it survives the posting's
  takedown. A description the user has written or edited is never overwritten by a
  board; one the system wrote itself (a browser capture's page text, an earlier
  attach) may be replaced by the posting it was standing in for, and the user's
  edit always wins from then on.
- FR-O2 (P0): Track each opportunity through an explicit lifecycle:
  `discovered → triaged (interested | dismissed) → preparing → applied → in_process
(screen, interview rounds) → offer → closed (accepted | rejected | withdrawn |
ghosted)`. Stage history with timestamps is preserved.
- FR-O3 (P0): Record an **activity timeline** per opportunity: applications,
  meetings and interviews (with participants), emails and messages, notes, links to
  external notes and transcripts, and stage changes.
- FR-O4 (P0): Track **next steps** per opportunity (action, owner, due date) and show
  upcoming next steps across all opportunities on the dashboard.
- FR-O5 (P0): One-click dismiss with an optional structured reason (seniority
  mismatch, compensation, location, industry, role fit, company, stale posting, other).
  Role fit is distinct from industry: the role itself (its function or domain) is the
  wrong one, independent of whether the industry is a fit. Dismiss reasons feed discovery
  learning (FR-D6).
- FR-O6 (P0): Link resume versions (FR-R) and contacts/referrals (FR-C) to
  opportunities.
- FR-O7 (P1): Detect likely duplicates (same role found via different sources) and
  let the user merge them with a single click, preserving history from both.
- FR-O10 (P1): When the same opportunity is published by multiple different
  recruiters, present it as a single opportunity with each recruiter's posting
  attached, mergeable in one click, and score it as lower value: multi-recruiter
  broadcast is a signal of a mass-shopped role.
- FR-O8 (P1): Attach documents to opportunities (job description snapshot, offer
  letters, prep notes) with local storage.
- FR-O9 (P0): Full-text search across opportunities, notes, and activities.

### 5.4 Discovery (FR-D)

- FR-D1 (P1): Pluggable **discovery sources**. Each source is an adapter that returns
  job postings in a normalized shape. Initial source classes:
  - ATS public postings APIs for specific companies (Greenhouse, Lever, Ashby).
  - Job board APIs and feeds where officially available.
  - MCP servers configured by the user (for example existing Indeed, Dice, and
    ZipRecruiter connectors), so the app can reuse integrations the user already has.
  - **Job alert emails**: saved-search digest emails from boards the user subscribes
    to (LinkedIn, Indeed, and similar), parsed out of the user's ingested mail
    (FR-M1) into discovery leads carrying title, company, location, and the posting
    link. This is the preferred compliant channel for LinkedIn-advertised roles:
    the board proactively sends the data to a mailbox the user owns (see C-1).
  - Manual capture: paste a URL or job description and the app extracts fields.
- FR-D2 (P1): Target coverage of the leading technology job boards through compliant
  means (official APIs, feeds, licensed aggregators, or user-configured MCP
  connectors). The set of sources is user-configurable per role target.
- FR-D3 (P1): Scheduled discovery runs per role target, with configurable frequency,
  deduplication against existing opportunities, and a **review queue** where new
  findings are triaged (interested/dismiss). Decided results (accepted or dismissed)
  move to their own **Decided** view rather than disappearing: each carries an
  **Unsuppress** action that reverses the decision and marks the result as
  previously decided, so it is never visually indistinguishable from one that was
  never triaged at all.
- FR-D4 (P1): AI ranking of discovered postings against the role target. The prompt
  used for discovery ranking is stored, versioned, and user-editable in the UI.
- FR-D5 (P1): Track company-specific boards: a user can follow specific companies and
  have their postings checked on a schedule.
- FR-D6 (P1): **Learning from dismissals.** Dismissal reasons and patterns are
  periodically summarized into proposed refinements of the discovery prompt. The user
  reviews, edits, and accepts or rejects each proposed refinement; nothing changes
  silently. Prompt history is kept and any version can be restored.
- FR-D7 (P1): **Lead resolution.** A discovery lead with partial details (for
  example one parsed from a job alert email) is automatically resolved to its
  canonical posting where a compliant path exists: the system matches company and
  title against the company's ATS board (Greenhouse, Lever, Ashby) and pulls the
  full job description from there, since board postings are typically mirrors of
  the ATS entry. Leads that cannot be resolved automatically are queued for
  one-click user capture: the user opens the posting link in their own browser and
  captures it via the extension (FR-C5) or paste capture (FR-D1). The system never
  resolves a lead by server-side fetching of a source whose terms prohibit
  automated access; each lead shows its resolution state (full, resolved via ATS,
  awaiting capture, or capture attempted but not resolved).
- FR-D8 (P1): **Company discovery.** Opportun proactively suggests candidate
  companies that plausibly fit the user's resume, profile, and role targets, with
  the aim of surfacing the superset of fitting employers, not just the ones the
  user already knows. Candidate sources include: an AI suggestion task seeded with
  the resume and role targets (industry peers, competitors and ecosystem neighbors
  of companies already in the pipeline, "companies like X" expansion); companies
  appearing in discovery results, job alert emails, and recruiter outreach; and
  employers of the user's contacts (FR-C2). Suggestions are presented in a company
  review queue with a short fit rationale, and the user accepts or denies each.
  Accepted companies become followed companies (FR-D5) and enter ATS detection
  (FR-D9); denials are remembered, never re-suggested, and feed the same learning
  loop as dismissals (FR-D6).
- FR-D9 (P1): **ATS board detection.** For every accepted or followed company,
  Opportun automatically locates its public job board: probing the known URL and
  API patterns of supported ATS providers (Greenhouse, Lever, Ashby) for the
  company's slug, and scanning the company's own careers page for ATS links. A
  verified board is registered as a discovery source without manual configuration;
  detection is re-verified periodically since companies change ATS providers. When
  no board can be detected, the user is asked once for the careers URL, and
  companies with no API-accessible board are still trackable through alert emails,
  MCP sources, and manual capture. Slug probing only works for providers whose board
  is addressed by a single org slug; a provider addressed by tenant plus site (FR-D10)
  is learned from a URL instead, never guessed.
- FR-D10 (P1): **Workday postings.** Workday hosts a large share of enterprise
  postings, and its links arrive in the user's own mail (for example
  `<tenant>.wd5.myworkdayjobs.com/<site>/job/.../<title>_<reqId>`). Workday support
  has two parts:
  - **Reference extraction, with no API dependency.** A Workday posting URL has a
    parseable shape,
    `https://<tenant>.<datacenter>.myworkdayjobs.com/<site>/job/<location>/<title>_<reqId>`
    with an optional trailing segment such as `/apply`, and requisition ids are not all
    numeric (`1000001`, `1000002-1`, `JR-000001`), so tenant, site and requisition id are
    recoverable from the link alone, with no network call at all. This is enough to
    record the posting URL on an opportunity, identify the requisition, and deduplicate
    reposts even when the board adapter below is unavailable.
  - **A board adapter.** Workday's candidate-experience (CXS) endpoints,
    `POST /wday/cxs/<tenant>/<site>/jobs` for the listing and
    `GET /wday/cxs/<tenant>/<site>/job/<path>` for one posting's description, are the
    public API behind each company's own careers site and are the compliant path under
    C-2, the same class as the three other shipped ATS adapters.
    Workday boards are acquired from a URL the user already has (a posting link in a
    message, or the company's careers URL), never from a guessed slug, and a tenant in a
    maintenance window is a transient failure rather than a recorded "no board" (FR-D9).
    Where the API is unavailable the posting URL is still stored, and the description
    comes from the user's own paste (FR-O1).

### 5.5 Contacts and referrals (FR-C)

- FR-C1 (P1): Store contacts: name, employer history, relationship notes, LinkedIn
  URL, email, and tags.
- FR-C2 (P1): Import contacts from the LinkedIn official data export (Connections
  CSV). Re-import must upsert, not duplicate.
- FR-C3 (P1): Map contacts to companies, and surface **referral candidates** for each
  opportunity: contacts at the company or with relevant relationships, ranked with a
  short AI-generated rationale.
- FR-C4 (P1): Track referral asks and outcomes on the opportunity timeline.
- FR-C5 (P2): Browser-extension based capture of the profile and job-posting pages
  the user visits on supported sites, as a compliant alternative to API access (see
  section 8). LinkedIn is the first supported site; others are added as recognizers.
  A captured profile becomes a contact. A captured job posting is an expression of
  interest, not an item to triage: it becomes an opportunity at `interested`,
  completing any pending lead for the same posting rather than queueing a second
  one (FR-D7), and the posting is then reconciled against the company's own ATS
  board. Nothing is captured without the user pressing the button, and nothing is
  ever fetched on their behalf.

### 5.6 Communications tracking (FR-M)

- FR-M1 (P1): Connect the user's Gmail account (OAuth, read-only scope by default)
  and ingest job-search-related messages.
- FR-M2 (P1): AI classification of ingested messages: recruiter solicitation,
  interview scheduling, follow-up, rejection, offer, networking, other. Messages are
  linked to the matching opportunity and shown on its timeline. Classified
  rejection, interview, and offer messages also generate a proposed stage
  transition that the user confirms with one click; stages never change silently.
- FR-M3 (P1): When a message is a solicitation for a new opportunity that passes the
  outreach filter (FR-M8), create a new opportunity in `discovered` state, mark its
  source as the message, and link the conversation. Filtered solicitations never
  auto-create opportunities.
- FR-M4 (P1): Unified communications view per opportunity and a global inbox of
  job-search communications with unlinked items needing triage.
- FR-M5 (P2): Apple Mail (macOS) support through a local connector agent that runs on
  the user's Mac and syncs matched messages to the server (see design doc).
- FR-M6 (P2): LinkedIn message tracking through the official data export and through
  user-driven capture (FR-C5). Messages link to contacts and opportunities.
- FR-M7 (P0): All ingestion is read-only. Drafting replies is assisted (P2), sending
  always happens in the user's own mail client or LinkedIn session.
- FR-M8 (P1): **Outreach filtering.** Classify recruiter outreach into three kinds
  and treat them differently:
  - _Targeted_: addressed to the user specifically about a concrete role, with
    evidence of personalization (references to the user's background, named role and
    company). Surfaced prominently and eligible for FR-M3.
  - _Broadcast spam_: bulk or template solicitations with no real personalization.
    Routed to a low-priority spam view, never deleted, never auto-creating
    opportunities; the user can review and reclassify at any time.
  - _Irrelevant offers_: real outreach that does not fit the user's role targets
    (FR-P2), such as wrong seniority, domain, location, or contract type. Filtered
    with the mismatch reason shown, and reclassifiable in one click.
    Relevance is judged against the user's active role targets, misclassifications
    corrected by the user feed back into the classification prompt the same way
    dismissals refine discovery (FR-D6), and the filter runs locally on ingested
    messages only (it never deletes, labels, or modifies anything in the user's
    mailbox).

### 5.7 AI integration (FR-A)

- FR-A1 (P0): Provider-agnostic **model router**. Supported providers at launch:
  Anthropic and OpenAI, plus any OpenAI-compatible HTTP endpoint (covers local
  runtimes such as Ollama and vLLM). Adding a provider must not require changes
  outside the provider adapter layer.
- FR-A2 (P0): A **task registry** declares every AI task in the system: resume
  tailoring and match scoring, discovery ranking and prompt refinement, message
  classification and triage, opportunity dedupe and posting merge, referral
  rationale, browser-capture extraction, company-fit suggestions, and integration
  setup diagnosis, among others as the product grows. Each task has a configurable
  model policy: provider, model,
  variant/effort, temperature, and token limits, with sensible defaults that pick
  efficient models for high-volume tasks and capable models for high-stakes tasks.
- FR-A3 (P0): API keys are entered by the user, stored encrypted at rest, never
  logged, and never sent to any destination other than the provider they belong to.
- FR-A4 (P0): Prompt transparency: every system prompt and task prompt is viewable in
  the UI. Discovery prompts are editable (FR-D4); other prompts are editable behind
  an "advanced" setting with reset-to-default.
- FR-A5 (P1): Cost and usage ledger: tokens and estimated cost per task, per model,
  per day, visible in settings.
- FR-A6 (P0): Graceful degradation: every AI-assisted feature has a manual path, and
  provider outages must not block CRUD workflows.

### 5.8 Web UI (FR-U)

- FR-U1 (P0): Dashboard: pipeline summary, upcoming next steps and interviews,
  recent activity, items needing triage.
- FR-U2 (P0): Pipeline view: opportunities as a kanban board by stage and as a
  sortable, filterable table.
- FR-U3 (P0): Opportunity detail: description, timeline, communications, resume
  versions, referrals, next steps, notes.
- FR-U4 (P0): Resume workspace: base resumes, versions per opportunity, tailoring
  chat, status tracking.
- FR-U5 (P0): Profile and role target management forms.
- FR-U6 (P1): Discovery review queue and discovery prompt editor.
- FR-U7 (P0): Settings: account, security (password, two-factor), profile, role
  targets, resume rules, AI providers and model policies, integrations,
  import/export, backups, and, for administrators, user management.
- FR-U8 (P1): Keyboard-first triage (j/k navigation, single-key interested/dismiss).
- FR-U9 (P2): Search funnel analytics: applications per week, response rate,
  time-in-stage, and outcomes by source and role target.
- FR-U10 (P0): Light and dark mode: user-selectable (light, dark, or auto), with
  auto following the system preference. The choice persists per user and every
  screen renders correctly in both themes.
- FR-U11 (P1): First-run guided tour: a brand-new account (no opportunities, no AI
  key) is offered a short tour on first sign-in that walks the three setup steps
  (AI key, mail, first opportunity) and the main pages, each setup step with a "Do
  it now" that pauses the tour at the real control and a Resume pill that survives
  reloads and the Google OAuth redirect. Progress is per user, on the server, and
  can be skipped, resumed or replayed from the account menu. Accounts that already
  have data are never interrupted by it. On the public demo instance it runs on
  every sign-in, view-only. Keyboard and screen-reader operable, usable on a phone,
  honours reduced motion, and never points at something that is not on screen.
- FR-U12 (P1): Setup checklist: a dashboard card listing the three activation
  items, each computed by the server (an AI key that authenticated, Gmail or Apple
  Mail connected, at least one opportunity), until all are done or the user hides
  it. The first time all three are true is recorded per user as the activation
  time, inside the user's own instance (no third-party analytics). Not shown on the
  demo instance.

### 5.9 Accounts and authentication (FR-S)

- FR-S1 (P0): Local accounts: email + password with a modern KDF (Argon2id), secure
  server-side sessions, logout everywhere, and password change/reset.
- FR-S2 (P0): The first registered account becomes the administrator; registration
  then closes by default and can be reopened by the admin (invite-style).
- FR-S3 (P1): Optional TOTP two-factor authentication.
- FR-S4 (P2): OAuth sign-in with Google, LinkedIn, and GitHub, linkable to an
  existing local account.
- FR-S5 (P0): Per-user data isolation enforced at the data layer; no cross-user reads
  in any query path.

### 5.10 Import, export, and seed data (FR-I)

- FR-I1 (P0): Structured import of existing job search activity from Markdown and
  CSV: opportunities, stage history, notes, and contacts. The first import target is
  the founder's existing records (an Obsidian vault and a Google Drive folder of
  tailored resumes); the importer itself must be generic.
- FR-I2 (P0): Register existing resumes (base and per-opportunity copies), in
  either Google Docs or a user's own Reactive Resume instance (FR-R7), against
  imported opportunities.
- FR-I3 (P0): Full export of all user data to open formats (JSON plus Markdown) at
  any time.
- FR-I4 (P1): One-command backup and restore of the full application state.

## 6. Non-functional requirements (NFR)

### 6.1 Security (NFR-SEC)

Target: a reasonable OWASP ASVS Level 2 posture for a self-hosted single-team app.

- NFR-SEC1: All traffic over TLS in production deployments; documentation ships a
  reverse-proxy configuration with automatic certificates.
- NFR-SEC2: Session cookies are HttpOnly, Secure, SameSite=Lax or stricter; CSRF
  protection on all state-changing requests.
- NFR-SEC3: Argon2id password hashing with per-deployment pepper support; constant
  time credential checks; login and reset rate limiting with lockout backoff.
- NFR-SEC4: Secrets (AI keys, OAuth tokens) encrypted at rest with authenticated
  encryption (AES-256-GCM) under a key supplied via environment/keyfile, separate
  from the database file.
- NFR-SEC5: Strict input validation on every API boundary; output encoding in the UI;
  a restrictive Content Security Policy and standard security headers.
- NFR-SEC6: Outbound fetchers (discovery, link snapshots) are SSRF-hardened: scheme
  and host allowlists per adapter, no redirects to private address space, timeouts
  and size caps.
- NFR-SEC7: Audit log of security-relevant events (sign-ins, failed attempts, key
  changes, exports, admin actions).
- NFR-SEC8: Dependency hygiene: lockfiles, automated vulnerability scanning in CI,
  documented update cadence. No dependencies with non-OSI licenses.
- NFR-SEC9: A published security policy (SECURITY.md) with a private disclosure
  channel.
- NFR-SEC10: Least-privilege third-party scopes: Google scopes limited to the
  specific Docs/Drive/Gmail capabilities in use; read-only wherever possible.
- NFR-SEC11: Filesystem least privilege. The server's filesystem access is confined
  to its data directory (database, attachments, backups, keyfile) for writes, and
  to the data directory plus its own read-only application assets for reads. Any
  path influenced by user input or external content is resolved and validated
  against the data root (no traversal, no symlink escape); files enter and leave
  the system only as HTTP upload/download streams, never as server-side paths
  supplied by a client. Deployments enforce the same boundary at the platform
  layer: the container runs as a non-root user with a read-only root filesystem
  and only the data volume writable, and bare-metal docs ship equivalent systemd
  hardening.

### 6.2 Privacy (NFR-PRV)

- NFR-PRV1: No telemetry, analytics, or phone-home by default. Any future opt-in
  telemetry must be documented and off by default.
- NFR-PRV2: All personal data stays in the user's deployment except what the user
  explicitly sends to connected providers. The docs state plainly what each
  integration transmits.
- NFR-PRV3: Resume content and personal constraints are sent to AI providers only as
  needed for a task the user initiated or scheduled.
- NFR-PRV4: Data deletion: a user can delete an opportunity or a contact, and the
  data is actually removed (not soft-hidden) from the live database. Tearing down
  an entire deployment is documented as a complete procedure, not left to be
  inferred: stopping the containers and removing the state directory (database,
  attachments, backups, master key) and the env file (the pepper and any generated
  credentials beside it) leaves nothing behind on the machine. That procedure must
  call out revoking the Google connection as its own explicit step, because
  deleting local OAuth tokens revokes nothing at Google's end: a teardown that
  stops at the filesystem leaves a live grant on the user's Google account.
- NFR-PRV5: A message's full text is never persisted. What the database keeps is a
  short snippet; the full text reaches the classification task (FR-M2) as a
  transient job payload only, and is scrubbed from the job row when that job
  finishes, whether it succeeds or is given up on. Reading more than the snippet is
  a deep link back to the message where it already lives in the user's own
  mailbox, not a copy the app keeps; this is what makes aggressive outreach
  filtering (FR-M8) safe, since refusing to keep a filtered message's content costs
  nothing the user cannot get back in one click. One exception, stated honestly
  rather than claimed absolute: a row written before this guarantee existed can
  still carry a stored body, readable until a purge clears that row.

### 6.3 Platform, footprint, and operations (NFR-OPS)

- NFR-OPS1: Entire stack is open source. Default deployment is a single container
  (or a single Node process) with an embedded SQLite database and a data volume.
- NFR-OPS3: One-file durable state: database plus an attachments directory, both on
  one volume, so backup is a file copy and restore is documented and tested.
- NFR-OPS4: Background work (sync, discovery, classification) is durable across
  restarts: queued jobs persist in the database with retries and backoff.
- NFR-OPS5: Health endpoint, structured logs, and a visible job/queue status page.
- NFR-OPS6: Versioned releases with migrations that run automatically and safely on
  upgrade; a downgrade/restore story documented.

### 6.4 Quality (NFR-QLT)

- NFR-QLT1: Automated tests: unit tests for domain logic, integration tests for API
  and database, and end-to-end tests for the critical flows (auth, opportunity CRUD,
  resume tailoring loop, import).
- NFR-QLT2: CI runs tests, type checks, lint, and security scans on every PR.
- NFR-QLT3: Accessibility: keyboard navigable, semantic markup, WCAG 2.1 AA as the
  working target for the core flows.
- NFR-QLT4: Responsive layout usable on a laptop and a phone browser.

## 7. Milestones

- **M0: Design.** Complete. Requirements and design reviewed and approved.
  Repository public-ready skeleton: docs, license, CI placeholder.
- **M1: MVP tracker (first local build).** Local auth, profile + role targets +
  resume rules, opportunity CRUD with lifecycle and timeline, next steps, dashboard,
  pipeline views, resume version tracking with Google Docs registration, AI resume
  tailoring loop with Anthropic + OpenAI-compatible routing, Markdown/CSV import of
  existing activity, export, single-container deploy. Success: the founder's live
  search runs entirely in Opportun. **Delivered 2026-10-15** (first development
  iteration); the success criterion is met once the founder's data is imported live.
- **M2: Communications.** Gmail OAuth ingestion, classification, outreach
  filtering, opportunity linking, solicitation-to-opportunity flow, unified inbox.
  Per D-5, M1 and M2 together form the first development iteration. **Delivered
  2026-10-15.**
- **M3: Discovery.** Source adapter framework, ATS adapters (Greenhouse, Lever,
  Ashby), MCP source support, scheduled runs, review queue, editable discovery
  prompts, dismissal learning. **Delivered 2026-10-16.**
- **M4: Network.** Contacts, LinkedIn export import, referral suggestions, referral
  tracking. **Delivered 2026-10-16.**
- **M5: Hardening and reach.** OAuth sign-in (Google, LinkedIn, GitHub), TOTP 2FA,
  Apple Mail connector, LinkedIn capture extension, Postgres option, multi-user
  polish. **Delivered 2026-10-21.**
- **M6: Public launch.** Making the repository public. Everything the product
  needs for this is already in M5; what remains is a decision still to be made,
  not work still to be done, so M6 has no delivery date until that decision is.

## 8. Constraints and compliance

- C-1: **LinkedIn.** No automated scraping or credentialed automation of LinkedIn.
  LinkedIn's User Agreement prohibits automated retrieval of its pages (including
  publicly viewable ones), the site authwalls and rate-limits server-side fetches,
  and violations get member accounts restricted and IPs blocked, so the core
  product never fetches linkedin.com URLs server-side. Supported paths: the
  official member data export (CSV/ZIP), any official API the user has access to,
  and a browser extension that only captures pages the user personally visits.
  OAuth sign-in with LinkedIn (FR-S4) uses only LinkedIn's official OAuth token and
  OpenID Connect userinfo endpoints, with the user's consent; no other LinkedIn URL
  is fetched. For job discovery specifically, the compliant pipeline is: LinkedIn job alert
  emails (data LinkedIn chooses to send to the user's own mailbox) are parsed into
  leads (FR-D1), leads are resolved to the canonical ATS posting for the full job
  description (FR-D7), and unresolved leads fall back to one-click user capture.
  Users who accept the risk may attach a third-party connector through the MCP
  source class; that choice and its consequences stay with the user and are never
  shipped in or encouraged by the core (ADR-12). The docs must describe these
  trade-offs honestly.
- C-2: **Job boards.** Sources integrate through official APIs, published feeds,
  licensed aggregators, or user-configured MCP connectors. Per-source rate limits
  and terms are respected and documented in each adapter.
- C-3: **Google.** Access through the user's own OAuth consent with minimal scopes;
  the app is registered as the user's own OAuth client (documented setup) so no
  third party sits in the token path.
- C-4: **AI content.** AI-tailored resumes and drafts are suggestions; the user
  approves every artifact before it leaves the system. The app never fabricates
  resume facts: tailoring rephrases and reorders user-provided material and must
  refuse to invent experience.
- C-5: **Open source.** All runtime dependencies OSI-licensed and compatible with the
  project license.

## 9. Success metrics

- S-1: 100% of the founder's active search (every live opportunity, resume version,
  and next step) managed in Opportun by end of M1.
- S-2: Time from "found posting" to "tailored resume ready" under 30 minutes using
  the tailoring loop.
- S-3: At M2+: over 90% of job-related emails auto-linked to the right opportunity
  without manual re-filing.
- S-4: At M3: at least half of newly surfaced postings rated "worth a look"
  (interested rather than dismissed) after two weeks of dismissal learning.
- S-5: Zero known critical vulnerabilities; CI security scans green at every release.

## 10. Open decisions (for review)

- D-1: Resolved 2026-10-15: the product is named **Opportun** and the domain
  `opportun.app` is registered. (Originally drafted as "Opportune"; the final e
  was dropped when opportun.app was purchased.)
- D-2: Resolved 2026-10-15: Apache-2.0, chosen for its explicit patent grant.
- D-3: Resolved 2026-10-15: TypeScript/Node across the stack (one language
  end-to-end; see design section 2.1 for the alternatives considered).
- D-4: Resolved 2026-10-15: SQLite as the default database, with Postgres kept as
  a later option (M5) behind the same Drizzle schemas.
- D-5: Resolved 2026-10-15: the first development iteration delivers M1 and M2
  together. Gmail ingestion, message classification, outreach filtering (FR-M8),
  opportunity linking, and the unified inbox land in the first build rather than a
  follow-up release.
- D-6: Resolved 2026-10-15: first deployment target is the founder's Mac via
  Docker, then a small VPS.
- D-7: Resolved 2026-10-15: the Apple Mail connector stays at M5 as drafted. The
  initial requirements named local Mac Mail alongside Gmail, but the separate local
  agent it requires is not worth delaying discovery (M3) or network features (M4);
  Gmail coverage in the first iteration (D-5) carries the near-term load.
- D-8: Resolved 2026-10-15: the build-vs-reuse calls in section 11.3 are
  confirmed, including Reactive Resume as the optional local-resume path (FR-R7)
  and community scrapers supported only through user-configured MCP sidecars.

## 11. Prior art and differentiation

Landscape reviewed 2026-10-15; star counts are from that date and will drift.

### 11.1 Comparable projects

| Project                                                                           | License                                       | Scope                                                                                                                                                                                                                                                                               | Relationship to Opportun                                                                                    |
| --------------------------------------------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| [job-ops](https://github.com/DaKheera47/job-ops) (4.0k stars)                     | AGPLv3 + Commons Clause (not OSI open source) | Searches 10+ boards (scrapers plus the Adzuna API), 0-100 AI fit scoring, CV tailoring with PDF export locally or via Reactive Resume, Gmail post-application tracking with automatic status updates, broad AI provider support, explicit no-auto-apply stance, paid cloud offering | Closest competitor. Validates demand and the no-auto-apply ethos. License bars any code reuse               |
| [JobSync](https://github.com/Gsync/jobsync) (1.4k stars)                          | MIT                                           | Application tracker with AI resume review and job matching, local models via Ollama                                                                                                                                                                                                 | Lighter overlap; no communications ingestion or network features                                            |
| [Reactive Resume](https://github.com/reactive-resume/reactive-resume) (44k stars) | MIT                                           | Self-hosted resume and cover letter builder with live PDF, Word/Markdown/JSON export, and light application tracking                                                                                                                                                                | Complementary component, integration candidate for FR-R7                                                    |
| [Resume-Matcher](https://github.com/srbhr/Resume-Matcher) (29k stars)             | Apache-2.0                                    | Master resume plus job description to match score and tailored output, local or remote LLMs                                                                                                                                                                                         | Capability overlap with the tailoring loop; compatible license, source of scoring ideas                     |
| [JobSpy](https://github.com/speedyapply/JobSpy) (4.5k stars)                      | MIT (Python)                                  | Scraping library for LinkedIn, Indeed, Glassdoor, ZipRecruiter and others; powers several trackers                                                                                                                                                                                  | Conflicts with C-2 if embedded; available to users as an MCP sidecar                                        |
| nextrole, jobtrail (under 10 stars)                                               | mixed                                         | Early trackers: shared job pool with Gmail-driven tracking; JobSpy-powered discovery pipeline                                                                                                                                                                                       | Validate the Gmail-tracking and discovery-pipeline patterns                                                 |
| Auto-apply bots (AIHawk lineage, 30k+ stars)                                      | mixed                                         | Mass-apply automation, increasingly anti-bot evasion                                                                                                                                                                                                                                | Permanently out of scope (NG-2, NG-3); even job-ops warns automated applications get candidates blacklisted |

### 11.2 Differentiation

No surveyed project covers Opportun's combination of:

- The full communications lifecycle: Gmail, Apple Mail, and LinkedIn messages
  classified and linked per opportunity, with recruiter solicitations becoming
  tracked opportunities (job-ops tracks Gmail replies to applications it knows
  about; none handle inbound solicitations, Apple Mail, or LinkedIn messages).
- A network and referral layer built from the user's own LinkedIn data export.
- Prompt transparency with approval-gated dismissal learning: discovery improves
  only through prompt changes the user reviews and accepts.
- Google Docs native resume versioning for users whose resumes already live there,
  with Reactive Resume as the planned alternative for everyone else.
- MCP servers as a first-class discovery source class, reusing connectors the user
  already runs instead of shipping scrapers.
- A compliance-first core under a true OSI license (job-ops, the nearest
  competitor, is source-available with a commercial restriction and relies on
  scraping sites whose terms prohibit it).

### 11.3 Build vs reuse

| Capability                           | Prior art                | Decision                                                                                                                                                                                                                                                    |
| ------------------------------------ | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Job board breadth                    | job-ops, JobSpy          | Do not embed scrapers (C-2). Core ships ATS and official-API adapters; users may attach community scrapers such as JobSpy through the MCP source class at their own discretion. No job-ops code under any circumstances (license)                           |
| Local resume building and PDF export | Reactive Resume          | Integrate, do not recreate: optional companion service behind the DocumentStore adapter (FR-R7). Precedent: job-ops already exports through Reactive Resume                                                                                                 |
| Resume-to-JD match scoring           | Resume-Matcher, JobSync  | Recreate as an internal AI task (FR-R8): the capability is a prompt plus parsing on infrastructure Opportun already has, and embedding a second full application is heavier than the feature. Apache-2.0 permits borrowing scoring rubrics with attribution |
| Status updates from email            | job-ops, nextrole        | Covered by FR-M2/FR-M3, with a human-in-the-loop refinement: classified messages propose stage transitions the user confirms, instead of job-ops-style silent automatic updates                                                                             |
| Search funnel analytics              | JobSync, job-ops         | Adopted as FR-U9 (P2)                                                                                                                                                                                                                                       |
| Cover letter generation              | Reactive Resume, JobSync | Adopted as FR-R9 (P2); the tailored-introduction style remains the default                                                                                                                                                                                  |
| Auto-apply                           | AIHawk lineage           | Rejected permanently (NG-3)                                                                                                                                                                                                                                 |
