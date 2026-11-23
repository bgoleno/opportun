# Changelog

Opportun's first tagged release is [v0.3.1](https://github.com/bgoleno/opportun/releases/tag/v0.3.1),
made by hand. A release is cut by running the Publish image workflow with a version: it needs a `## <version>
(YYYY-MM-DD)` section in this file, made by renaming `## Unreleased` and starting a new one. See
[SECURITY.md](SECURITY.md) for which versions are supported. Entries are grouped by milestone
(requirements section 7, [docs/requirements.md](docs/requirements.md)), newest first, dated by
when the milestone's work was merged.

## Unreleased

### Pipeline board

- **Pipeline board: a card moved by keyboard is picked up in its own column and reaches every
  column on a board narrower than its columns.** In 0.5.0 it stayed in its column at 768 and
  1024 px, and at wider widths with Dismissed and Closed expanded. Left and Right now scroll the next
  column into view, and the card is announced in the column it is over. Pointer drags are
  unchanged. At 768 px with both end columns expanded the chain has no width left, so no chain
  column is on screen, though the card still steps through all of them
  ([#886](https://github.com/bgoleno/opportun/issues/886),
  [#902](https://github.com/bgoleno/opportun/issues/902); PR
  [#900](https://github.com/bgoleno/opportun/pull/900)).

### Opportunities and posting links

- **A description you save at the very moment a background posting check writes is kept.** The
  check writes only while the description is still the one it read. When it is not, the check
  writes nothing, including no location, link or duplicate key, and the timeline says it skipped
  the description: "The description changed while the board was being checked, so the board search
  left it as it is." Re-deriving a posting leaves such a description alone too
  ([#856](https://github.com/bgoleno/opportun/issues/856); PR
  [#883](https://github.com/bgoleno/opportun/pull/883)).
- **While a background check reads the company's board, the Apply panel and the Resume tab say so
  instead of suggesting Find posting.** The refusal to search again, "Opportun is still checking
  this posting on the company's board", goes away when the check ends
  ([#870](https://github.com/bgoleno/opportun/issues/870); PR
  [#885](https://github.com/bgoleno/opportun/pull/885)).

### Sign-in and settings

- **Pressing Escape, or closing while the request is running, no longer loses two-factor recovery
  codes or a new device token.** The recovery codes stay until "I saved them", and a new device
  token until "I saved it", so the next token's dialog shows too. While two-factor activation is
  running, nothing closes its dialog. The extension setup's "Close before the extension has checked
  in?" question now appears on top of the setup, and the setup cannot be closed while its token is
  being made. Other dialogs still close on Escape
  ([#898](https://github.com/bgoleno/opportun/issues/898); PR
  [#901](https://github.com/bgoleno/opportun/pull/901)).

### Docs

- **Docs: the Settings guide covers Linked accounts and what checking an AI key sends; the Inbox
  guide covers paging, Sync now without a reload and the bulk reject outcomes; the demo
  deployment page and the design page are corrected.** Under Security, the Settings guide explains
  **Link** and **Unlink** (each asks for your current password, and Unlink is refused without a
  password) and what a password reset does to linked providers. It also says that checking an
  Anthropic key sends one tiny test message for each distinct model your settings use, and that an
  OpenAI or OpenAI-compatible key sends a model-list request. The Inbox guide explains a tab with
  more than 200 messages ("Showing x–y of N", **Previous** and **Next**), the new mail and
  counts that appear after **Sync now**, and the "changed elsewhere and left as they are" outcome.
  The demo deployment page says every default task policy is `anthropic` and that a dedicated
  account's requests wait for the nightly reset and can delay it. The design page names the
  connector's `/api/v1/connector/mail/batch` endpoint, the Workday adapter and the Google packages
  ([#605](https://github.com/bgoleno/opportun/issues/605),
  [#739](https://github.com/bgoleno/opportun/issues/739),
  [#744](https://github.com/bgoleno/opportun/issues/744),
  [#772](https://github.com/bgoleno/opportun/issues/772),
  [#891](https://github.com/bgoleno/opportun/issues/891); PRs
  [#625](https://github.com/bgoleno/opportun/pull/625),
  [#877](https://github.com/bgoleno/opportun/pull/877),
  [#881](https://github.com/bgoleno/opportun/pull/881),
  [#884](https://github.com/bgoleno/opportun/pull/884),
  [#899](https://github.com/bgoleno/opportun/pull/899)).

## 0.5.0 (2026-11-22)

This release includes everything in
[v0.4.0](https://github.com/bgoleno/opportun/releases/tag/v0.4.0), tagged on 2026-11-14, and what
merged after it.

### Upgrading

- **A job that was running when the server stopped is no longer run again on every restart.** At
  its last attempt it is marked dead, with "orphaned: the process ended while its last attempt
  (n of max) ran" as its error; with attempts left, it waits out the usual retry delay first. A job
  allowed a single attempt (`maxAttempts: 1`) is therefore dead after one crash. A job left waiting
  at its attempt limit by an earlier version is marked dead on the first start after upgrading,
  and a schedule it belonged to runs again
  ([#588](https://github.com/bgoleno/opportun/issues/588); PR
  [#720](https://github.com/bgoleno/opportun/pull/720)).
- **Two new database indexes, added on boot like any migration.** One on the jobs table (SQLite
  migration 0073, Postgres 0055) keeps **Settings > Jobs** quick as the job history grows, and the
  dashboard no longer counts the whole timeline it does not show. One on the observability metric
  points (SQLite 0074, Postgres 0056) serves the point cap
  ([#592](https://github.com/bgoleno/opportun/issues/592),
  [#594](https://github.com/bgoleno/opportun/issues/594); PRs
  [#795](https://github.com/bgoleno/opportun/pull/795),
  [#797](https://github.com/bgoleno/opportun/pull/797)).
- **The Apple Mail connector's `init` handles a change of server.** Given a server address other
  than the saved one, it resets its sync position, so the new server gets the whole lookback
  window, and it no longer offers the saved device token: it asks for a token for the new server
  and says why. `init` can also read the token from a file (`--token-file`, which must be readable
  by you only) or from standard input (`--token-stdin`), so it stays out of shell history
  ([#650](https://github.com/bgoleno/opportun/issues/650),
  [#702](https://github.com/bgoleno/opportun/issues/702),
  [#655](https://github.com/bgoleno/opportun/issues/655),
  [#699](https://github.com/bgoleno/opportun/issues/699); PRs
  [#673](https://github.com/bgoleno/opportun/pull/673),
  [#745](https://github.com/bgoleno/opportun/pull/745),
  [#695](https://github.com/bgoleno/opportun/pull/695),
  [#740](https://github.com/bgoleno/opportun/pull/740)).

### Opportunities, posting links and the board

- **Find posting stays available until a posting is confirmed, and confirming one keeps a
  description you wrote yourself.** A posting you described but never checked is confirmed from
  the company's board with your text kept
  ([#756](https://github.com/bgoleno/opportun/issues/756); PR
  [#804](https://github.com/bgoleno/opportun/pull/804)).
- **Refetch on a posting you described yourself checks the company's board again and keeps your
  description.** Only the link and the job's identity are updated, and the timeline says your
  description was kept ([#812](https://github.com/bgoleno/opportun/issues/812); PR
  [#830](https://github.com/bgoleno/opportun/pull/830)).
- **Find posting says when a company's board couldn't be read, and offers to try again.** That is
  no longer reported as "no close match". A Refetch that finds nothing new says "Nothing changed",
  and the timeline says what each check did
  ([#835](https://github.com/bgoleno/opportun/issues/835); PR
  [#860](https://github.com/bgoleno/opportun/pull/860)).
- **Find posting waits while Opportun is already checking the company's board for that
  posting**, and says why, so a posting is never attached twice. A click that lands just after
  that check confirmed the posting says "Already confirmed" and changes nothing, and the page
  shows the check's result on its own once it lands
  ([#852](https://github.com/bgoleno/opportun/issues/852); PR
  [#865](https://github.com/bgoleno/opportun/pull/865)).
- **A background posting check no longer overwrites a description you save while it runs.** It
  leaves your text as it is, marks the posting for review and says why
  ([#851](https://github.com/bgoleno/opportun/issues/851); PR
  [#855](https://github.com/bgoleno/opportun/pull/855)).
- **Find posting writes a timeline entry when it recognises a job from its own careers-page link**
  ([#813](https://github.com/bgoleno/opportun/issues/813); PR
  [#847](https://github.com/bgoleno/opportun/pull/847)).
- **Posting-link saves: the company's own boards, the later of two saves, and a check that runs
  out of time.** Changing an opportunity's company and posting link together checks the new
  company's Greenhouse boards, newest first, within 5 seconds in all, and a careers-page job link
  is re-checked against the new company. Of two quick saves the later one is kept, a slow board no
  longer stops the others being checked, and a check that ran out of time finishes in the
  background. Cancelling the link editor while a save is still running says how the save ended,
  naming its link ([#598](https://github.com/bgoleno/opportun/issues/598),
  [#685](https://github.com/bgoleno/opportun/issues/685),
  [#737](https://github.com/bgoleno/opportun/issues/737),
  [#785](https://github.com/bgoleno/opportun/issues/785); PRs
  [#633](https://github.com/bgoleno/opportun/pull/633),
  [#714](https://github.com/bgoleno/opportun/pull/714),
  [#787](https://github.com/bgoleno/opportun/pull/787),
  [#805](https://github.com/bgoleno/opportun/pull/805)).

- **On the pipeline board, with Dismissed expanded, a keyboard drag names the right column** and
  steps left and right through every column
  ([#833](https://github.com/bgoleno/opportun/issues/833); PR
  [#844](https://github.com/bgoleno/opportun/pull/844)).

### Inbox

- **A tab with more than 200 messages pages through all of them**, and says how many are shown of
  the total ([#646](https://github.com/bgoleno/opportun/issues/646); PR
  [#700](https://github.com/bgoleno/opportun/pull/700)).
- **After Sync now, new mail, the tab counts and the sync time appear without a reload**
  ([#645](https://github.com/bgoleno/opportun/issues/645); PR
  [#668](https://github.com/bgoleno/opportun/pull/668)).
- **Reject asks first and never takes a message you did not see.** Bulk Reject says how many
  messages it will remove for good, takes only rows on screen, and its Confirm waits while the list
  loads a new filter. A reject leaves alone a message that was linked or moved in another tab or
  session since you selected it, and says how many were left as they are. A single reject always
  says whether it worked, and a refusal explains itself. A failed refresh keeps your selection,
  and a confirmation closes with a message when a refresh changes what it would reject
  ([#647](https://github.com/bgoleno/opportun/issues/647),
  [#666](https://github.com/bgoleno/opportun/issues/666),
  [#678](https://github.com/bgoleno/opportun/issues/678),
  [#758](https://github.com/bgoleno/opportun/issues/758),
  [#841](https://github.com/bgoleno/opportun/issues/841); PRs
  [#659](https://github.com/bgoleno/opportun/pull/659),
  [#672](https://github.com/bgoleno/opportun/pull/672),
  [#712](https://github.com/bgoleno/opportun/pull/712),
  [#838](https://github.com/bgoleno/opportun/pull/838),
  [#864](https://github.com/bgoleno/opportun/pull/864)).
- **A failed Ignore says so, and a filter that matches nothing says "No messages match these
  filters"** instead of reading as an empty inbox
  ([#652](https://github.com/bgoleno/opportun/issues/652); PR
  [#706](https://github.com/bgoleno/opportun/pull/706)).

### Referrals and contacts

- **The AI ranking of who could refer you is kept until something it depends on changes**: a
  contact who could match, the opportunity or its company, the prompt or the model. The list shows
  when it was ranked, with a **Re-rank** button for a fresh one, and only contacts that can match
  are read ([#590](https://github.com/bgoleno/opportun/issues/590); PR
  [#640](https://github.com/bgoleno/opportun/pull/640)).
- **The Referrals tab keeps up with your contacts.** It shows a contact you just added, renamed or
  deleted the next time it opens, and a LinkedIn or contacts import followed to the end on
  **Settings > Import/Export** refreshes it and the network list at once. A referral ask shows the
  contact's current name, or marks them removed. A used-up AI budget says so instead of "AI is
  unavailable"
  ([#651](https://github.com/bgoleno/opportun/issues/651),
  [#694](https://github.com/bgoleno/opportun/issues/694); PRs
  [#688](https://github.com/bgoleno/opportun/pull/688),
  [#734](https://github.com/bgoleno/opportun/pull/734)).
- **Deleting a contact drops each kept referral ranking that names them**, and the list is
  ranked again the next time it opens
  ([#710](https://github.com/bgoleno/opportun/issues/710); PR
  [#718](https://github.com/bgoleno/opportun/pull/718)).
- **A contact's LinkedIn link must be a linkedin.com address**
  ([#655](https://github.com/bgoleno/opportun/issues/655); PR
  [#695](https://github.com/bgoleno/opportun/pull/695)).

### Browser extension, assisted apply and the Mail connector

- **The extension's buttons say what they are doing, and give up after 30 seconds** with a clear
  message when the server does not answer. Focus comes back to the button, the fill report is
  announced, an invalid settings field is marked, and a timeout is announced once. It says the
  server may still have saved something only when something was sent
  ([#648](https://github.com/bgoleno/opportun/issues/648),
  [#783](https://github.com/bgoleno/opportun/issues/783); PRs
  [#713](https://github.com/bgoleno/opportun/pull/713),
  [#798](https://github.com/bgoleno/opportun/pull/798)).
- **The fill report says why the resume was not attached** (still being prepared, could not be
  downloaded, or not a usable PDF), and when it left a matching list option alone because of
  where it sits on the form. After a capture, the extension links to the opportunity or contact
  it saved
  ([#653](https://github.com/bgoleno/opportun/issues/653),
  [#738](https://github.com/bgoleno/opportun/issues/738); PRs
  [#717](https://github.com/bgoleno/opportun/pull/717),
  [#761](https://github.com/bgoleno/opportun/pull/761)).
- **The extension checks a device token's shape exactly as the server does, and warns when a
  plain-http server address would carry the token unencrypted.** Only loopback names count as
  local for that warning ([#655](https://github.com/bgoleno/opportun/issues/655),
  [#699](https://github.com/bgoleno/opportun/issues/699); PRs
  [#695](https://github.com/bgoleno/opportun/pull/695),
  [#740](https://github.com/bgoleno/opportun/pull/740)).
- **Assisted apply fills "How did you hear about this role?" with your reviewed answer** when you
  gave one, and pages for application systems the extension does not fill no longer read your
  device tokens ([#595](https://github.com/bgoleno/opportun/issues/595); PR
  [#674](https://github.com/bgoleno/opportun/pull/674)).
- **At handoff, assisted apply opens only a page that names the job in its own path, exactly as
  checked, and the form filler never clicks a list option inside a link or a label**
  (PR [#641](https://github.com/bgoleno/opportun/pull/641)).
- **The Apply panel says what to do, or why it can't apply yet, for each posting state**
  ([#738](https://github.com/bgoleno/opportun/issues/738); PR
  [#761](https://github.com/bgoleno/opportun/pull/761)).
- **The Apple Mail connector no longer stops syncing for good when the server refuses one
  message.** It skips that message, says which, and sends the rest
  ([#649](https://github.com/bgoleno/opportun/issues/649); PR
  [#680](https://github.com/bgoleno/opportun/pull/680)).

### Sign-in, settings and errors

- **About sixty refusals explain themselves in words**, instead of "Request failed (code)",
  including a step refused because your password changed during it
  ([#743](https://github.com/bgoleno/opportun/issues/743),
  [#750](https://github.com/bgoleno/opportun/issues/750); PRs
  [#753](https://github.com/bgoleno/opportun/pull/753),
  [#774](https://github.com/bgoleno/opportun/pull/774),
  [#832](https://github.com/bgoleno/opportun/pull/832)).
- **A sign-in that cannot finish lands on an Opportun page.** Signing in with two-factor
  authentication says when the password was changed during the sign-in, and a sign-in, link or
  Google connect that fails at its last step lands on an app page with an error, not an error page
  ([#662](https://github.com/bgoleno/opportun/issues/662),
  [#853](https://github.com/bgoleno/opportun/issues/853); PRs
  [#741](https://github.com/bgoleno/opportun/pull/741),
  [#873](https://github.com/bgoleno/opportun/pull/873)).
- **Changing a sign-in provider asks for the admin's password**, as turning registration on or off
  does, and switching registration is audited
  ([#853](https://github.com/bgoleno/opportun/issues/853); PRs
  [#731](https://github.com/bgoleno/opportun/pull/731),
  [#873](https://github.com/bgoleno/opportun/pull/873)).
- **Two-factor setup and an admin's password reset take effect only while the password you just
  entered is still current** (PR [#643](https://github.com/bgoleno/opportun/pull/643)).
- **A credential or settings change whose audit record cannot be written now changes nothing,
  and a removal or switch-off still takes effect, recorded right after.** That covers sign-in,
  registration, password resets (from the command line and by an admin), device tokens, stored
  secrets, Google, sign-in providers, telemetry export, the Collect switch and the Reactive Resume
  key. A sign-in cookie is set only once its session is recorded, and an audit or settings event
  is reported only once its change has committed
  ([#661](https://github.com/bgoleno/opportun/issues/661),
  [#779](https://github.com/bgoleno/opportun/issues/779),
  [#802](https://github.com/bgoleno/opportun/issues/802),
  [#807](https://github.com/bgoleno/opportun/issues/807),
  [#819](https://github.com/bgoleno/opportun/issues/819),
  [#824](https://github.com/bgoleno/opportun/issues/824),
  [#846](https://github.com/bgoleno/opportun/issues/846); PRs
  [#723](https://github.com/bgoleno/opportun/pull/723),
  [#801](https://github.com/bgoleno/opportun/pull/801),
  [#815](https://github.com/bgoleno/opportun/pull/815),
  [#822](https://github.com/bgoleno/opportun/pull/822),
  [#826](https://github.com/bgoleno/opportun/pull/826),
  [#836](https://github.com/bgoleno/opportun/pull/836),
  [#854](https://github.com/bgoleno/opportun/pull/854)).
- **Export and import keep a closed opportunity's closed reason**, an export from an older version
  still imports, and the Settings guide says what an import brings back and what stays only in the
  export ([#736](https://github.com/bgoleno/opportun/issues/736); PR
  [#755](https://github.com/bgoleno/opportun/pull/755)).
- **The command-line pepper refusal, for a database whose server has not recorded its version,
  says to restart the server first** ([#635](https://github.com/bgoleno/opportun/issues/635); PR
  [#746](https://github.com/bgoleno/opportun/pull/746)).

### AI, jobs and fetching

- **The daily AI duplicate check no longer gets stuck.** Pairs it passes over go behind the rest,
  an error on one pair skips that pair and the pass goes on, and a pair whose check keeps failing,
  at the provider or with a malformed answer, stops being sent to the AI after three tries and
  stays as it is ([#593](https://github.com/bgoleno/opportun/issues/593),
  [#687](https://github.com/bgoleno/opportun/issues/687),
  [#742](https://github.com/bgoleno/opportun/issues/742); PRs
  [#644](https://github.com/bgoleno/opportun/pull/644),
  [#701](https://github.com/bgoleno/opportun/pull/701),
  [#751](https://github.com/bgoleno/opportun/pull/751)).
- **Each user gets a fair share of a job board host.** One user's burst of board lookups no longer
  makes other users' lookups to the same board time out. The nightly board probe no longer stops a
  vendor for everyone because of a wait on this server, and one user's failing companies can stop
  it for everyone at most once a week
  ([#617](https://github.com/bgoleno/opportun/issues/617); PR
  [#667](https://github.com/bgoleno/opportun/pull/667)).
- **Observability: a long workflow's trace keeps its root span, and a failed metrics write is
  counted as dropped** ([#594](https://github.com/bgoleno/opportun/issues/594); PR
  [#797](https://github.com/bgoleno/opportun/pull/797)).
- **Moving an installation onto Postgres (`copyToPostgres.ts`) keeps a JSON key named
  `__proto__`** instead of dropping it
  ([#587](https://github.com/bgoleno/opportun/issues/587); PR
  [#669](https://github.com/bgoleno/opportun/pull/669)).
- **Batch ranking, still behind the hidden setting.** It gains an Anthropic batch client, written
  from the API reference with no real call. The provider's copy of a batch is removed once its
  results are applied, even after a crash or an account reset, each provider call has its own
  time limit and the results answer is read within a size and time bound. A refused batch is sent
  again within minutes and stops after nine tries, with the postings saying why, and a retried
  collect reports the rankings that landed
  ([#509](https://github.com/bgoleno/opportun/issues/509),
  [#634](https://github.com/bgoleno/opportun/issues/634),
  [#686](https://github.com/bgoleno/opportun/issues/686),
  [#784](https://github.com/bgoleno/opportun/issues/784),
  [#827](https://github.com/bgoleno/opportun/issues/827); PRs
  [#534](https://github.com/bgoleno/opportun/pull/534),
  [#657](https://github.com/bgoleno/opportun/pull/657),
  [#715](https://github.com/bgoleno/opportun/pull/715),
  [#735](https://github.com/bgoleno/opportun/pull/735),
  [#820](https://github.com/bgoleno/opportun/pull/820),
  [#840](https://github.com/bgoleno/opportun/pull/840)).

### Demo

- **On a demo server, an AI call stops after 40 seconds, and ends before its request's hold on the
  nightly reset runs out**, so a request that began before the reset writes nothing after it. The
  demo deployment page says what the reset's protection covers, and that the 20 s and 40 s limits
  apply to dedicated accounts too ([#656](https://github.com/bgoleno/opportun/issues/656),
  [#684](https://github.com/bgoleno/opportun/issues/684); PRs
  [#670](https://github.com/bgoleno/opportun/pull/670),
  [#704](https://github.com/bgoleno/opportun/pull/704)).
- **On the demo's shared accounts, the attachment upload and two-factor setup say what they mean
  on a shared login, and the invented candidate has a phone number that is refused in any field**,
  however it is typed: with or without the country code, the 011 prefix or an extension. The demo
  deployment and acceptance pages list the notices, the phone and checks for the reset gate and
  the 40 s limit ([#671](https://github.com/bgoleno/opportun/issues/671),
  [#681](https://github.com/bgoleno/opportun/issues/681),
  [#682](https://github.com/bgoleno/opportun/issues/682),
  [#726](https://github.com/bgoleno/opportun/issues/726),
  [#782](https://github.com/bgoleno/opportun/issues/782); PRs
  [#676](https://github.com/bgoleno/opportun/pull/676),
  [#721](https://github.com/bgoleno/opportun/pull/721),
  [#725](https://github.com/bgoleno/opportun/pull/725),
  [#762](https://github.com/bgoleno/opportun/pull/762),
  [#806](https://github.com/bgoleno/opportun/pull/806)).

### Docs, security policy and supply chain

- **`SECURITY.md` says that a message pushed through `mail:push` can mark an application confirmed
  by email**, that Opportun verifies no SPF, DKIM or DMARC result, and how to undo it, and its
  threat model covers what shipped since 0.4.0. It also says how audit records commit with what
  they record, which error text reaches a client, that the test-support switches are refused in
  production, and what CI pins and scans
  ([#522](https://github.com/bgoleno/opportun/issues/522),
  [#703](https://github.com/bgoleno/opportun/issues/703),
  [#845](https://github.com/bgoleno/opportun/issues/845); PRs
  [#548](https://github.com/bgoleno/opportun/pull/548),
  [#708](https://github.com/bgoleno/opportun/pull/708),
  [#848](https://github.com/bgoleno/opportun/pull/848)).
- **Guides: the Inbox's Reject, filters and bulk reject, the Referrals ranking and Re-rank, the
  review limit, and Tailor again after a copy is marked Submitted.** The Inbox guide covers
  Reject, Not spam, the filter bar and bulk reject, and the token step names the required
  **Name**. The Network guide describes the kept ranking. The Settings guide says the review limit
  is any whole number from 1 up to the server's limit, and the Pipeline guide's **Tailor again**
  covers a copy marked Submitted. The guide's previous and next links follow its contents, and the
  connector's `init` help and the install guide say which questions `init` asks
  ([#541](https://github.com/bgoleno/opportun/issues/541),
  [#637](https://github.com/bgoleno/opportun/issues/637),
  [#654](https://github.com/bgoleno/opportun/issues/654),
  [#709](https://github.com/bgoleno/opportun/issues/709); PRs
  [#543](https://github.com/bgoleno/opportun/pull/543),
  [#658](https://github.com/bgoleno/opportun/pull/658),
  [#660](https://github.com/bgoleno/opportun/pull/660),
  [#711](https://github.com/bgoleno/opportun/pull/711)).
- **A new `docs/architecture.md`**: diagrams of the system, its packages, the server's layers and
  its trust boundaries, an assessment of the layering, and what a multi-tenant hosted service would
  need ([#757](https://github.com/bgoleno/opportun/issues/757); PR
  [#759](https://github.com/bgoleno/opportun/pull/759)).
- **Supply chain and CI.** Dependabot keeps the pinned actions current and proposes only digest,
  minor or patch updates of the image's Node 22 base. pnpm is installed at a hash-checked release,
  the image's OS packages are scanned weekly, and the image's base, the lockfile scanner and CI's
  Postgres and Playwright images are pinned by digest, with a test that every image a workflow
  runs is. CI checkouts no longer keep a token, and a pull request's `security` label is decided by
  the main branch's own workflow, so a pull request can't remove its own label
  ([#619](https://github.com/bgoleno/opportun/issues/619),
  [#663](https://github.com/bgoleno/opportun/issues/663),
  [#683](https://github.com/bgoleno/opportun/issues/683),
  [#728](https://github.com/bgoleno/opportun/issues/728),
  [#733](https://github.com/bgoleno/opportun/issues/733),
  [#800](https://github.com/bgoleno/opportun/issues/800); PRs
  [#642](https://github.com/bgoleno/opportun/pull/642),
  [#689](https://github.com/bgoleno/opportun/pull/689),
  [#705](https://github.com/bgoleno/opportun/pull/705),
  [#730](https://github.com/bgoleno/opportun/pull/730),
  [#796](https://github.com/bgoleno/opportun/pull/796),
  [#818](https://github.com/bgoleno/opportun/pull/818)).

### Earlier in this release

- **Changing your password can also sign out your devices, and does so by default.** In
  **Settings > Security**, the password form has a checkbox, **Also sign out the browser extension
  and the Mail connector**, checked by default. It revokes your device tokens as part of the
  change, so the capture extension and the Apple Mail connector stop working until you pair them
  again with a new token from Settings. Clear it to keep them working. Until now a password
  change did not end device tokens, which are a separate credential. A refused change revokes
  nothing, and the audit entry records how many devices were signed out. Other clients of the
  password route are unchanged unless they ask for it, and the administrator and command-line
  password reset already revoked every device token
  ([#523](https://github.com/bgoleno/opportun/issues/523); PR
  [#536](https://github.com/bgoleno/opportun/pull/536)).
- **Hardening from the 2026-11-13 audit: two more address ranges blocked, tidier per-host rate
  buckets, a pinned scanner action, and a Compose proxy note.** The outbound fetch guard now
  blocks the local-use NAT64 range `64:ff9b:1::/48` and treats an IPv4-mapped IPv6 address it
  cannot unwrap as private, so such a spelling no longer passes as public. A request whose wait
  timed out gives its per-host slot back, and the per-host buckets are keyed on the host in
  lower case without a trailing dot and are dropped once their slot has passed. In CI, the OSV
  scanner action is pinned to a commit, and a test fails if any workflow action is not. The
  [install guide](docs/install.md#3-exposing-to-the-internet) now explains that where
  Docker's userland proxy makes the connection (Docker Desktop on macOS or Windows, rootless
  Docker, and IPv6 clients on some setups), Caddy sees one client address, so the per-IP sign-in
  limits are shared by everyone and the per-account limits still apply. For a server many people
  sign in to, run Docker Engine as root on Linux and reach it over IPv4
  ([#524](https://github.com/bgoleno/opportun/issues/524); PR
  [#551](https://github.com/bgoleno/opportun/pull/551)).
- **Assisted apply reads the job of a handoff address or a confirmation page from its own path
  only.** An address for a posting on a job board, and the page recorded as an application's
  confirmation, now name their job from the address's path (or its `gh_jid` where the path names
  none), never from another address that appears in its query string. An address whose path names
  another job is refused, and a confirmation page for another job is not recorded. This was always
  the intent, and nothing the extension fills changes. A Workday address with parentheses in its
  path, such as `(Remote)`, now names its job too, so assisted apply recognises it, and a
  stored posting address that ends in a stray `)`, pasted out of parentheses, keeps its job id
  again, while a `)` that closes a `(` in the address is kept
  ([#521](https://github.com/bgoleno/opportun/issues/521),
  [#549](https://github.com/bgoleno/opportun/issues/549),
  [#562](https://github.com/bgoleno/opportun/issues/562); PRs
  [#538](https://github.com/bgoleno/opportun/pull/538),
  [#555](https://github.com/bgoleno/opportun/pull/555),
  [#565](https://github.com/bgoleno/opportun/pull/565)).
- **The Publish image workflow runs in a `release` environment, so GitHub itself can limit
  publishing to `main`.** Both of its jobs, `publish` and `release`, declare
  `environment: release`. "Only from `main`" was otherwise enforced only by the workflow's own
  check, which runs from the dispatched branch's checkout. A branch rule on the `release`
  environment, set in the repository's settings, is the platform's own limit
  ([#519](https://github.com/bgoleno/opportun/issues/519); PR
  [#532](https://github.com/bgoleno/opportun/pull/532)).
- **The browser extension says so when it cannot fetch your resume in 30 seconds, and a closed
  window's fill cannot be doubled.** Before, the popup could stay blank while it downloaded the
  resume copy from your server. It now shows that it is filling, and past 30 seconds it fills
  nothing and says "Your resume could not be fetched from your server in time. Try again.
  Nothing was filled." A fill left running in a page by a popup you closed is now noticed: a
  second fill writes nothing and says to wait a few seconds for the earlier one to finish
  ([#531](https://github.com/bgoleno/opportun/issues/531); PR
  [#556](https://github.com/bgoleno/opportun/pull/556)).
- **A device token cannot be created while your password is being changed or reset.** A token
  made at the same moment as a password change (with its devices signed out) or an administrator
  or command-line reset could survive it. The creation is now refused, with `password_changed`,
  if the password it was checked against is no longer the current one, so a token cannot outlive
  the change ([#539](https://github.com/bgoleno/opportun/issues/539); PR
  [#557](https://github.com/bgoleno/opportun/pull/557)).
- **Demo servers can have a dedicated account for one person, out of the shared demo admin's
  reach.** On a demo server, `createDemoAccount.ts <email> <display name>` makes an ordinary
  account, prints its password once, and marks it so the nightly reset leaves it and its data
  alone. The command always prints the new password, even if writing its audit entry fails
  afterwards. The shared `demo-admin` is an administrator only for the user list, the pepper list,
  password resets, and the jobs list and its retry, and only for the five seeded accounts: it
  cannot reset or reach a dedicated account, open registration, or change other instance-wide
  settings, which now say "This setting covers the whole instance and is not available to this
  account." See [A dedicated account for one
  person](docs/demo-deployment.md#a-dedicated-account-for-one-person)
  ([#563](https://github.com/bgoleno/opportun/issues/563),
  [#570](https://github.com/bgoleno/opportun/issues/570); PRs
  [#567](https://github.com/bgoleno/opportun/pull/567),
  [#574](https://github.com/bgoleno/opportun/pull/574)).
- **The command-line password reset now works after a pepper rotation.** With a rotated pepper
  (`OPPORTUN_PEPPER_VERSION` 2 or later, the earlier secret in `OPPORTUN_PEPPER_V1`), the reset
  used to stamp the new password as version 1 under the new secret, so the password it printed
  never signed in and the account stayed locked out. The reset, and the demo's
  `createDemoAccount.ts`, now hash with the same pepper set the server loads, so the password
  they print signs in
  ([#568](https://github.com/bgoleno/opportun/issues/568); PR
  [#569](https://github.com/bgoleno/opportun/pull/569)).
- **Assisted apply now works on the demo, with the visitor's own data only.** On the shared demo
  accounts a draft starts empty, nothing is saved to the shared profile, an application carries
  no resume (the visitor attaches their own on the employer's form), and the demo's own names and
  addresses are refused. Each application is bound to the visitor (the session) who started it:
  anyone on the account can read it or cancel it, and only that visitor can change, review or hand
  it off, and only that visitor's device token is given it. A shared account keeps at most 20
  active device tokens, the oldest revoked when another is made. Mail push stays available on the
  demo. A dedicated demo account behaves like an account on any other instance. Two new operator
  settings: `OPPORTUN_DEMO_TOKEN_CAP` (default 20, `0` for no cap) and
  `OPPORTUN_DEMO_SHARED_ASSISTED_APPLY` (default `1`, `0` turns assisted apply off for the shared
  accounts only). See [Device tokens and assisted apply on the
  demo](docs/demo-deployment.md#device-tokens-and-assisted-apply-on-the-demo)
  ([#544](https://github.com/bgoleno/opportun/issues/544),
  [#545](https://github.com/bgoleno/opportun/issues/545); PRs
  [#550](https://github.com/bgoleno/opportun/pull/550),
  [#566](https://github.com/bgoleno/opportun/pull/566)).
- **On the demo's shared accounts, the apply steps, Settings > Profile and the mail connectors
  warn that what you enter is visible to others.** The warning says "This is a shared demo
  account. Anything you enter here is visible to others using it, and is cleared at the nightly
  reset." It shows on the Apply page's resume, details and review steps and on Settings > Profile
  and its Application details card. The Apple Mail and Gmail connector cards say that email a
  connected mailbox brings in can be read by everyone signed in to the account until the nightly
  reset, and can mark an application there confirmed. The resume step offers no resume (attach
  your own on the employer's form), the details step offers no **Save to my profile** ticks,
  and starting again after an expired review carries nothing over. A value that came with the
  demo is refused by field name, for example "Email: this value came with the demo. Enter your
  own, or leave the field empty. Nothing was opened.", with a link back to the details step.
  On the review step of an application with no resume, the tick no longer mentions one: "I have
  read my answers, and I will press Submit myself on _host_."
  Dedicated demo accounts and instances that are not the demo see none of this
  ([#546](https://github.com/bgoleno/opportun/issues/546),
  [#577](https://github.com/bgoleno/opportun/issues/577); PRs
  [#575](https://github.com/bgoleno/opportun/pull/575),
  [#600](https://github.com/bgoleno/opportun/pull/600)).
- **The extension's Greenhouse filler never clicks a list option inside a link or button, and it
  stops if the page moves.** An option with a link, button, label, area or summary between it
  and its list is now refused, since a click there would follow the link or press the control
  (an SVG link included). The filler also reads the page's address again before it writes each
  list, and after each list's options load. If the page has moved to another address, it writes
  nothing more, and the popup names the list it was on and every list after it: "the page moved
  to another address while filling: check this field on the form"
  ([#537](https://github.com/bgoleno/opportun/issues/537); PR
  [#560](https://github.com/bgoleno/opportun/pull/560)).
- **A sign-in whose password was checked just before a password change or reset is refused.**
  Before, a sign-in that was between checking your password and starting its session when you
  changed the password (or an administrator reset it) could still start a session that outlived
  the change. The session, or the pending two-factor step, is now written only while that password is
  still the current one, and a change or reset ends every session and pending two-factor step in
  its own transaction. A refused sign-in answers as for a wrong password (401
  `invalid_credentials`) and the audit entry records `password_changed`
  ([#561](https://github.com/bgoleno/opportun/issues/561); PR
  [#571](https://github.com/bgoleno/opportun/pull/571)).
- **A password reset also unlinks the account's sign-in providers.** The administrator's reset
  (**Settings > Users**) and the command-line reset now unlink every Google, GitHub and LinkedIn
  sign-in linked to the account, and say which ones: the temporary-password dialog names them,
  and the command prints them on stderr (stdout is still the password alone), so a provider
  someone else linked cannot sign in after the reset. Changing your own password keeps your
  providers. A provider link, or a provider sign-in, that was in flight when the reset ran now
  writes nothing ([#573](https://github.com/bgoleno/opportun/issues/573); PR
  [#602](https://github.com/bgoleno/opportun/pull/602)).
- **On the demo, an account made for one person gets the normal welcome tour and the "Get set
  up" checklist.** The demo's shared accounts keep the view-only tour
  ([#576](https://github.com/bgoleno/opportun/issues/576); PR
  [#586](https://github.com/bgoleno/opportun/pull/586)).
- **The security policy and the design documents now describe the demo's shared accounts.**
  `SECURITY.md` lists what assisted apply allows on them and the trade-offs the owner accepted,
  as a deliberate deviation, and the assisted apply design documents, the ADR and
  `docs/design.md` no longer say it is off on the demo
  ([#585](https://github.com/bgoleno/opportun/issues/585); PR
  [#601](https://github.com/bgoleno/opportun/pull/601)).
- **Resume flow: forms opened in place take focus and can be cancelled, every step change is
  announced, and finished steps link to what they made.** The forms for registering a base resume
  and for recording that you sent something focus their first field, and **Cancel** closes one and
  returns focus to the button that opened it. A change of place is announced once, a repeat of
  the same message included, and the message clears after a few seconds. A finished step links to
  what it made
  ([#596](https://github.com/bgoleno/opportun/issues/596); PR
  [#609](https://github.com/bgoleno/opportun/pull/609)).
- **Moving or reordering a card on the pipeline board no longer downloads every opportunity
  again, so drags stay quick on a large board.** A stage change or a reorder now refreshes the
  other lists and leaves the board's own list as it is
  ([#589](https://github.com/bgoleno/opportun/issues/589); PR
  [#621](https://github.com/bgoleno/opportun/pull/621)).
- **Companies: the network list is paged on the server, and a running board check refreshes only
  its own row instead of the whole list.** `GET /discovery/network-companies` takes `limit` (default
  50, at most 200) and `offset` and returns `items` and `total`, and the screen walks the pages. The
  order is unchanged ([#591](https://github.com/bgoleno/opportun/issues/591); PR
  [#624](https://github.com/bgoleno/opportun/pull/624)).
- **The password-reset and demo-account commands refuse, changing nothing, when their pepper
  version is not the one the server last started with.** Before, after a pepper rotation, a run with
  only the new secret set printed a password that could not sign in, having already ended the
  user's sessions and revoked their device tokens. The refusal names the variables to set and says
  a rotation needs a server restart first. The server records the version it runs with on every
  start ([#606](https://github.com/bgoleno/opportun/issues/606); PR
  [#627](https://github.com/bgoleno/opportun/pull/627)).
- **On the Metrics page, choosing "Last 30 days" and then a custom range no longer refuses that
  range with "Points are kept 30 days" when it was picked late in a minute.** A start the page
  filled in is clamped to the last 30 days, and a start you typed past 30 days is still refused
  ([#614](https://github.com/bgoleno/opportun/issues/614); PR
  [#628](https://github.com/bgoleno/opportun/pull/628)).
- **Run now on a paused board source that follows a company says to follow the company.** Following
  a company is what switches its source on, so the message now says to follow it on the Companies
  tab (or, if you already do, to turn on the source's Enabled box). Other sources keep the old
  message ([#599](https://github.com/bgoleno/opportun/issues/599); PR
  [#629](https://github.com/bgoleno/opportun/pull/629)).
- **On the demo, stdio MCP discovery sources cannot be configured or run.** Creating one, or
  changing a source to one, is refused (403 `mcp_stdio_unavailable_on_demo`), and a stored one stops
  with "stdio MCP sources do not run on the demo" before anything starts. An https MCP source is
  unchanged, and so is everything off the demo (PR
  [#631](https://github.com/bgoleno/opportun/pull/631)).
- **On a demo server, a shared demo account's data export leaves the request address out of its
  audit rows** (PR [#636](https://github.com/bgoleno/opportun/pull/636)).
- **The guide and the demo page walk a demo visitor through trying assisted apply with their own
  details.** The acceptance checks and design section 7.8 describe it as built, and a browser test
  runs it on a seeded demo server up to the handoff
  ([#547](https://github.com/bgoleno/opportun/issues/547); PR
  [#622](https://github.com/bgoleno/opportun/pull/622)).
- **On the demo's shared accounts, the Google and Reactive Resume cards say what connecting means
  there, and nothing that began before the nightly reset can write into the reseeded accounts.**
  The notices and docs for resumes, backups and two-factor sign-in on shared accounts are updated to
  match ([#618](https://github.com/bgoleno/opportun/issues/618); PR
  [#638](https://github.com/bgoleno/opportun/pull/638)).
- **The security label on pull requests also catches** changes to assisted apply submissions, the
  extension's filler and popup, deployment files, the board probe, the AI clients, the demo
  boundary, export and import, file storage and the observability settings, and `CONTRIBUTING.md`
  names them all ([#610](https://github.com/bgoleno/opportun/issues/610); PR
  [#639](https://github.com/bgoleno/opportun/pull/639)).
- **The timing-attack and unsafe-regex lint rules are now errors, after the existing warnings were
  triaged** ([#587](https://github.com/bgoleno/opportun/issues/587); PR
  [#612](https://github.com/bgoleno/opportun/pull/612)).
- **Batch ranking gains an OpenAI client, still behind the hidden setting.** Nothing is visible yet:
  it was written from OpenAI's documentation with no real call, and stays hidden until the owner's
  check ([#510](https://github.com/bgoleno/opportun/issues/510); PR
  [#632](https://github.com/bgoleno/opportun/pull/632)).
- **Docs: a Jobs section in the Settings guide, nine retaken screenshots, and a statement that only
  the latest release is supported.** The Jobs section explains the Jobs card's statuses and
  retries. The screenshots show the Settings side menu with Metrics and Telemetry and the tailored
  copy's header. `SECURITY.md` and `CONTRIBUTING.md` say that fixes land on `main` first and only
  the latest tagged release is supported
  ([#604](https://github.com/bgoleno/opportun/issues/604),
  [#608](https://github.com/bgoleno/opportun/issues/608),
  [#611](https://github.com/bgoleno/opportun/issues/611); PRs
  [#607](https://github.com/bgoleno/opportun/pull/607),
  [#613](https://github.com/bgoleno/opportun/pull/613),
  [#616](https://github.com/bgoleno/opportun/pull/616)).

## 0.4.0 (2026-11-14)

This release includes everything in [v0.3.1](https://github.com/bgoleno/opportun/releases/tag/v0.3.1),
which was tagged by hand from `main` on 2026-11-13, and what merged after it.

### Upgrading: prompts, defaults and costs

- **Assisted apply is now on by default.** Until now it was off unless `OPPORTUN_SUBMISSIONS=1`.
  Now it is on when the variable is unset, empty or `1`, and `0` turns it off. Any other value
  stops the server from starting with an error naming the variable: before this change a value
  such as `false`, `off` or `no` meant off, so it is refused rather than read as on. It is never
  on the demo. Assisted apply never sends an application: it prepares one for you to review and
  submit yourself. What to check when upgrading:
  - **To keep it off, set `OPPORTUN_SUBMISSIONS=0`.** An install that never set the variable, or
    removed it to turn the feature off, has it on after upgrading.
  - **Device tokens made with the Assisted apply permission (`apply:assist`) while it was on work
    again.** Turning the feature off never revoked them. Revoke any you no longer want in
    **Settings > Integrations > Extensions and Connectors**.
  - With it off, the server also removes the feature's three scheduled jobs (the review expiry,
    the follow-up and the resume snapshot check) at startup; before, it removed only the last.
    ([#455](https://github.com/bgoleno/opportun/issues/455))
- **Network job boards, on by default.** A nightly check of companies where you know someone, and
  that you have not followed, denied or checked, so their rows in Recommended companies show the
  board, its open jobs and an estimate without a click. It is on for every account after
  upgrading, including existing ones. Each night, Opportun looks up as many as 20 of these
  companies on Greenhouse, Lever and Ashby by name. Those services see the names it tries, which
  come from where your contacts work, and your server's address. No contact's name or details are
  sent. No AI call is made, and no company is followed. To turn it off, clear "Check job boards for
  companies in my network" in **Settings > AI**
  ([#296](https://github.com/bgoleno/opportun/issues/296)).
- **Three shipped prompts were reordered so Anthropic can cache them.** An automatic upgrade step rewrites the system default
  of each of these tasks in place, and only while it is still exactly the text the previous
  release shipped: `discovery.company_tags` (step 0060; Postgres 0042), `discovery.rank` (0061; Postgres 0043) and `comms.classify` (0063; Postgres 0045). The wording is the same but for a few words (the ranking prompt
  and the classify prompt each gain one closing line after the posting or message, and
  `comms.classify` rewords two references to "above"); the order changed, so the part that is
  the same for every call comes first. A prompt version you made yourself is a separate row
  and is left as it is, in its own order and with its own text: it works, but only the part
  before the message or posting in it is cached. To get the cached order, open
  **Settings > AI > Advanced: prompts**, choose the task and press **Reset to default**. Cache
  reads and writes are now priced at their own rates in the usage figures, and only Anthropic
  models are marked ([#356](https://github.com/bgoleno/opportun/issues/356),
  [#388](https://github.com/bgoleno/opportun/issues/388),
  [#380](https://github.com/bgoleno/opportun/issues/380); PRs
  [#378](https://github.com/bgoleno/opportun/pull/378),
  [#390](https://github.com/bgoleno/opportun/pull/390),
  [#433](https://github.com/bgoleno/opportun/pull/433)). Measured: ranking cost per posting fell
  about 18% and tagging about 31% in the PRs' own runs, and qa measured about 43% less per
  classify call on one batch of 36 messages.
- **New AI tasks get a system default prompt on upgrade.** Steps 0048 (`discovery.title_variants`),
  0051 (`discovery.industry_profile`) and 0054 (`discovery.company_tags`) add a prompt only if
  none exists. Step 0057 rewrites the `company.suggest` system default in place for the new
  version of the weekly company suggestion (below); your own version of it keeps its wording and
  still works, without the new context.
- **A new AI call can happen the first night after upgrading, and it costs money.** With an AI
  key and budget room, the nightly sweeps make one call per active role target that has no list
  of title variants (about $0.01 each, at 05:30 server time), and tag candidate companies with an industry
  in batches of 20 (at 05:45 server time). Both skip a user with no AI key. To avoid the
  first: write a title variants list yourself under **Settings > Role targets**. To limit both:
  lower the discovery budget under **Settings > AI**.

### Discovery

- **A title pre-filter skips ranking postings that clearly do not fit, once it has been
  right on your own decisions.** Every new job board posting now gets a verdict from your role
  target's name, title family and a list of equivalent titles (up to 40, made by one AI call and
  editable in **Settings > Role targets**, one per line), plus its remote and location rules. In
  **shadow mode** it only measures: the Decided tab says how many of the postings you accepted it
  would have kept. It starts acting for board sources when, over at least 20 postings you
  accepted, it would have kept at least 95% of them, and goes back to shadow mode if that falls.
  A filtered posting is not ranked and shows **Filtered: title** (or remote, or location) with
  **Rank anyway**. Job alert emails, captures and postings you added by hand are never
  filtered. The switch is a box per board on the Sources tab, on by default (the upgrade turns it
  on for every existing board); **Settings > AI** shows whether it is acting, why not, and the
  share it would filter. Postings already ranked stay as they are
  ([#217](https://github.com/bgoleno/opportun/issues/217),
  [#218](https://github.com/bgoleno/opportun/issues/218)).
- **The discovery budget now makes a posting wait, not skip.** Over the day's budget (default
  $1.00, set under **Settings > AI**), a posting reads **Waiting for budget** and is ranked on a
  later UTC day, best title match first and oldest among equals, instead of ending as skipped. On upgrade, a posting that was
  refused for budget and has no score joins the wait, so after the upgrade the day's budget can
  go on that backlog. Postings that arrived with no AI key were the same: they are ranked once a
  key works, best title match first. While companies wait for an industry tag, ranking stops at
  90% of the budget and leaves the rest for tagging (never less than half the budget, and at
  least five ranking calls' worth for tagging); with none waiting it can use all of it. If the
  provider rejects your key (a 401), the hourly calls stop and the cards say so until you add a
  working key or press **Validate** and it succeeds. **Undo** on a dismissed posting that was never ranked now
  joins the wait. Raise or lower the budget to taste
  ([#214](https://github.com/bgoleno/opportun/issues/214),
  [#261](https://github.com/bgoleno/opportun/issues/261),
  [#262](https://github.com/bgoleno/opportun/issues/262),
  [#274](https://github.com/bgoleno/opportun/issues/274),
  [#299](https://github.com/bgoleno/opportun/issues/299),
  [#317](https://github.com/bgoleno/opportun/issues/317)).
- **A board's first run ranks only its 25 newest postings.** The rest read **Not ranked: below
  the cut**, and the source row offers **Rank these**, with the estimated cost in a dialog. Boards
  that have already had a successful run are not capped
  ([#215](https://github.com/bgoleno/opportun/issues/215)).
- **Where to look: industries, recommended companies and company tags.** The Companies tab has a
  collapsed **Where to look** panel; **Suggest industries** sends your newest base resume's text
  and your role target fields to the model once, when you press it, and shows NAICS industries
  to confirm, remove or add (it counts against the discovery budget, and says in plain words
  when it fails). Candidate companies get an industry tag from the model, once, which you can
  correct and your correction stands; the weekly company suggestion now also sends your
  confirmed industries and up to 500 names of companies where you know someone (names only) and
  drops suggestions outside your profile. The tab shows one **Recommended companies** list with
  filters, two sorts, **Follow** and **Deny**, a **Check board** button (public board pages, no
  AI call, 30 checks per user per hour) and an estimate of new postings and cost a day for each;
  following several at once asks first when their first runs would cost over $1.00, or bring over
  20 new postings a day, or more than today's budget allows. Nothing here is a switch: do not
  press the buttons, remove the key, or lower the budget to stop the calls
  ([#219](https://github.com/bgoleno/opportun/issues/219),
  [#220](https://github.com/bgoleno/opportun/issues/220),
  [#221](https://github.com/bgoleno/opportun/issues/221),
  [#222](https://github.com/bgoleno/opportun/issues/222),
  [#277](https://github.com/bgoleno/opportun/issues/277),
  [#291](https://github.com/bgoleno/opportun/issues/291),
  [#300](https://github.com/bgoleno/opportun/issues/300),
  [#301](https://github.com/bgoleno/opportun/issues/301),
  [#302](https://github.com/bgoleno/opportun/issues/302)).
- **Runs and jobs behave better under load.** One run of a source at a time (**Run now** during a
  run, or on a paused source, says so instead of queueing nothing), a run cut short by a server
  stop reads **Interrupted** in Run history instead of **Running** for good (existing unfinished
  rows change once, at the first start), a job queued during a long one starts as soon as a
  worker is free (up to `OPPORTUN_JOB_WORKERS`, default 4), at most two waiting-posting drains
  run at once, and one user's company checks cannot hold up another's. On Postgres, overlapping
  runs of one source store each posting once; duplicates already stored are not removed. A
  capture and a board run on the same posting give one row, and a ranking from older posting
  text is not stored over a newer one
  ([#263](https://github.com/bgoleno/opportun/issues/263),
  [#267](https://github.com/bgoleno/opportun/issues/267),
  [#268](https://github.com/bgoleno/opportun/issues/268),
  [#269](https://github.com/bgoleno/opportun/issues/269),
  [#297](https://github.com/bgoleno/opportun/issues/297),
  [#310](https://github.com/bgoleno/opportun/issues/310),
  [#321](https://github.com/bgoleno/opportun/issues/321),
  [#323](https://github.com/bgoleno/opportun/issues/323),
  [#331](https://github.com/bgoleno/opportun/issues/331)).
- **A board found on another vendor right after a failed guess for the same name is no longer
  recorded.** When Opportun guesses a company's job board by name and one vendor's guess errors (a
  429, a 5xx, no answer, or a vendor stopped for the night), a hit for the same name on another
  vendor may be a decoy, and it used to be recorded. It is not recorded now: detection ends as
  transient and retries later, and the company keeps the board it had, which also holds when
  re-checking that recorded board errors. A hit after guesses that all answered is recorded as
  before, and an error for one name does not hold back another name's hit. A link on the company's
  careers page is not a guess and is unchanged
  ([#514](https://github.com/bgoleno/opportun/issues/514); PR
  [#526](https://github.com/bgoleno/opportun/pull/526)).
- **A company whose nightly board check keeps getting refused is checked less often.** When a
  company's own request to a job-board vendor is told to slow down or gets no answer, the vendor is
  stopped for the night as before, and that company is now parked out of the nightly pick, for 1
  night, then 2, 4 and 8, and 8 at most, until one of its checks is answered. The vendor is still
  stopped on each night the company is refused, but on fewer and fewer nights, so it holds up
  other users' checks on that vendor less often. Nothing is recorded about its board, no failed
  night is counted, and nothing about it shows in the app. **On upgrade:** two columns are added to
  `companies`, `board_probe_stops` and `board_probe_parked_until` (SQLite migration 0067, Postgres
  0049); they travel in the data export like the other company columns
  ([#518](https://github.com/bgoleno/opportun/issues/518); PR
  [#533](https://github.com/bgoleno/opportun/pull/533)).
- **One user's failure in the nightly network board check no longer stops it for everyone
  else.** If queuing one user's probes failed (a database error, a stored setting that does not
  parse), every later user got no probes that night and the retry stopped at the same user. The
  failure is now logged, with the user's id and the error's type only, never its message, and the
  sweep goes on to the next user. The job's result counts the users it queued and the users that
  failed
  ([#515](https://github.com/bgoleno/opportun/issues/515); PR
  [#525](https://github.com/bgoleno/opportun/pull/525)).
- **Jobs queued at the same moment run in the order they were queued.** When several jobs were
  due at the same millisecond, which one ran first was left to the database and could differ
  between SQLite and Postgres. A tie on the time a job is due and was created is now broken by its
  id, which is its queue order, on both. There is no migration and no setting
  ([#465](https://github.com/bgoleno/opportun/issues/465); PR
  [#501](https://github.com/bgoleno/opportun/pull/501)).
- **Captures share one budget per user.** The web capture dialog and every extension token now
  share 60 captures per 15 minutes per user (the dialog had no limit; 30 per token still holds),
  and the limit says which one was reached and when to retry. A user's captures are saved one
  at a time: a second one waits up to 5 seconds, then is refused as busy with a message to
  capture again in a few seconds. The limiter is in memory, so a restart resets it
  ([#272](https://github.com/bgoleno/opportun/issues/272),
  [#309](https://github.com/bgoleno/opportun/issues/309),
  [#324](https://github.com/bgoleno/opportun/issues/324)).
- **Batch ranking is built but off, and hidden.** The server can rank postings in provider
  batches behind a setting that is off by default and is not in Settings; no provider has a batch
  client yet, so ranking is still made live whatever the setting. The upgrade adds a table
  `rank_batches` and three columns on `discovery_results` (step 0064; Postgres 0046) and
  nothing else changes, so there is nothing to do
  ([#441](https://github.com/bgoleno/opportun/issues/441),
  [#358](https://github.com/bgoleno/opportun/issues/358)).
- **Role targets show an error on a list field that is too long.** An entry over 200 characters
  in Industries, Keywords, Locations or Title variants now says so; before, Save did nothing and
  said nothing ([#243](https://github.com/bgoleno/opportun/issues/243)).

### Telemetry, usage and logs

- **Telemetry is built in, and off until an administrator turns it on.** Two switches under
  **Settings > Telemetry**, both off by default: **Collection** keeps metrics, traces and event
  records in your own database, and **Export** sends them to one destination you choose
  (Prometheus, a Datadog Agent, InfluxDB or OTLP) and can be on only while collection is. Nothing
  leaves your server unless an administrator turns export on, and the demo never collects. New
  pages: **Settings > Metrics** (charts and a table) and **Settings > AI traces**. Event
  records carry no personal information, by a catalogue and a gate. The upgrade adds tables
  (`obs_metric_points`, `obs_traces`, `obs_spans`) and a column `jobs.trace_context`, and an
  hourly `obs.prune` job runs even with collection off, keeping minute points 48 hours and
  hourly points and traces 30 days, within row caps. The data is in your database and so in
  your backups, but not in the user's own export. Export to loopback or a private network needs
  `OPPORTUN_TELEMETRY_ALLOW_PRIVATE=1`; a blocked destination says why; changing the OTLP
  header name clears the stored credential. SQLite now checkpoints its WAL every 100 pages
  instead of 1,000, from the next start. See the [install guide](docs/install.md) and
  **Settings > Telemetry** in the guide
  ([#340](https://github.com/bgoleno/opportun/issues/340),
  [#342](https://github.com/bgoleno/opportun/issues/342),
  [#343](https://github.com/bgoleno/opportun/issues/343),
  [#344](https://github.com/bgoleno/opportun/issues/344),
  [#346](https://github.com/bgoleno/opportun/issues/346),
  [#347](https://github.com/bgoleno/opportun/issues/347),
  [#353](https://github.com/bgoleno/opportun/issues/353),
  [#375](https://github.com/bgoleno/opportun/issues/375),
  [#382](https://github.com/bgoleno/opportun/issues/382)).
- **Server log lines changed, so a script that reads them needs checking.** Every line passes a
  filter that keeps a fixed message and typed values (ids, counts, codes) and nothing else: no
  names, addresses, request URLs, error messages or host name. A message the server does not
  know reads `[message withheld]`, an error is its type and frames (a run of frames outside
  Opportun's code is one `at <external>`), and Fastify's own request logging is replaced by one
  access line per request (method, route template, status, address). There is no switch
  ([#345](https://github.com/bgoleno/opportun/issues/345)).
- **Every AI call is now sent through the checked fetch.** To Anthropic, OpenAI or an
  OpenAI-compatible endpoint: https only, every resolved address public, no redirects, so each
  call makes one DNS lookup first. A host that reaches the internet only through NAT64 can no
  longer reach either provider. If that is you, or you use a proxy, set `ANTHROPIC_BASE_URL` or
  `OPENAI_BASE_URL` to it: a request to that address is sent as it is
  ([#344](https://github.com/bgoleno/opportun/issues/344), install guide section 4,
  "AI provider requests").
- **AI usage is shown by feature, task and model.** **Settings > AI > Usage** now lists nine
  features (Resume tailoring, Matching, Discovery, Capture, Mail, Companies, Referrals,
  Duplicates, Integrations) that expand to their tasks, with calls, tokens and estimated cost
  per model, including features with no calls, and a model reached through two providers shows as
  two rows. The figures come from the cost recorded at call time, so earlier rows keep their price
  ([#341](https://github.com/bgoleno/opportun/issues/341),
  [#350](https://github.com/bgoleno/opportun/issues/350)).
- **An error a dependency throws deep in its own code keeps the Opportun frame that called
  it in the log.** Node keeps 10 stack frames by default, so such an error reached the log
  without the Opportun line that led to it. The server now keeps 50 from startup. The log still
  writes at most 20 frames per error, and an error made 66 frames deep costs about 2 µs more to
  create, measured in the PR
  ([#436](https://github.com/bgoleno/opportun/issues/436); PR
  [#445](https://github.com/bgoleno/opportun/pull/445)).

- **The observability docs match the code.** The guide's Settings pages now cover what was
  missing: the **Mail filters** and **Telemetry** sections in the list, the nine metrics with
  their units, the Metrics page's range, zoom and filter limits, the AI traces page's paging and
  summary, the collection switch (no password, audited), what **Send a test** can report and the
  reasons a record is dropped. They also say the local store keeps only AI traces and that the
  log's access line holds the client's address (log only, never stored or exported). The design and
  requirements are corrected where they had drifted, and ADR-16, 17 and 18 are Accepted
  ([#340](https://github.com/bgoleno/opportun/issues/340); PR
  [#513](https://github.com/bgoleno/opportun/pull/513)).

### Mail, pipeline and assisted apply

- **An unsubscribe request your own mail app sent is filtered.** A message from your own address
  to an unsubscribe address, or whose body is only Gmail's "automatically generated" line, now
  lands on the Blocked tab as "an unsubscribe request your mail app sent" instead of the Inbox.
  Messages already ingested stay where they are. There is no switch; restore one from the
  Blocked tab ([#392](https://github.com/bgoleno/opportun/issues/392)).
- **A message you sent to an unsubscribe address with a person in Cc is no longer filtered.**
  The automatic unsubscribe filter now reads Cc as well as To: a message is filtered only when
  every To and Cc recipient is an unsubscribe address, and Gmail's "automatically generated"
  body counts only when no Cc recipient is anything else, since Gmail's button never adds a Cc.
  A message with a person in Cc lands in the Inbox as your own mail. Gmail ingest and the Apple
  Mail connector both send Cc now. **If you run the connector:** its rows no longer hold Cc
  addresses in `to` (Cc is its own field), so the "To:" line the classifier sees is To only.
  Either the server or the connector can be upgraded first: an older connector's rows are read
  as before, and an older server ignores the new field
  ([#406](https://github.com/bgoleno/opportun/issues/406); PR
  [#472](https://github.com/bgoleno/opportun/pull/472)).
- **An opportunity can move from any chain stage to any other in one move.** In process can go
  straight back to Preparing; nothing tied to a later stage is lost. Closed and Dismissed still leave only through **Reopen**, and a move out of one of them says so. On the board, a keyboard
  drop that is refused is announced as not moved, with the reason, not as dropped on the column
  ([#397](https://github.com/bgoleno/opportun/issues/397),
  [#413](https://github.com/bgoleno/opportun/issues/413)).
- **An opportunity's Communications tab opens newest first,** with a control for oldest first.
  The inbox order is unchanged ([#394](https://github.com/bgoleno/opportun/issues/394)).
- **A thread of more than 200 messages says so and shows the rest.** The server returns 200
  messages at a time, so a longer thread used to stop there with no sign of it. The tab now
  says "Showing the newest 200 of 205 messages." (or the oldest, in the order you chose) and a
  **Show N more** button adds the next page below. Switching between newest and oldest first
  never shows the other order's partial list turned round: it says it is loading until the
  right page arrives. A thread of 200 or fewer looks as before
  ([#422](https://github.com/bgoleno/opportun/issues/422); PR
  [#446](https://github.com/bgoleno/opportun/pull/446)).
- **The Resume tab leads you through one resume flow.** A card at the top of the tab shows four
  steps (Base, Tailor, Finish, Apply), says where this opportunity is, and offers one filled
  button for the next action with a quieter alternative beneath it: register or choose a base
  resume, create a tailored copy, mark it final, then apply or record that you sent it. A
  base resume can also be sent as it is, which marks it final everywhere it is used. After an
  action, focus moves to the new state and a status line says what happened and what is next.
  The older ways of adding a resume moved into a collapsed **Other ways to add a resume**
  section, and the separate **Create tailored copy** card is now the flow's own button. On a
  phone the steps become one line, "Step 3 of 4: Finish"
  ([#440](https://github.com/bgoleno/opportun/issues/440); PR
  [#443](https://github.com/bgoleno/opportun/pull/443)).
- **A tailored copy's own page shows the next step, and the Resume tab fits a phone with a long
  title.** Under the title of a tailored resume that belongs to an opportunity, a strip shows
  the same state as the opportunity's Resume tab and offers the one action that fits it: **Mark
  as final** in place (with **Score again** beside it) while it is a draft or in review, **Apply**
  when it is ready and assisted apply can start, and otherwise **Back to the opportunity**. A
  copy the flow does not follow gets a line linking the one it does. **Change status** opens the
  full status control, so every status stays reachable. Scoring runs one request at a time: the
  strip's button, the match report's and the tab's cannot send two AI calls. The Resume tab no
  longer widens past a 375 px phone when a copy's title is one long unbroken word. A base
  resume's page is unchanged
  ([#447](https://github.com/bgoleno/opportun/issues/447),
  [#486](https://github.com/bgoleno/opportun/issues/486); PR
  [#490](https://github.com/bgoleno/opportun/pull/490)).
- **Three small fixes on the Resume tab and in toasts.** Detaching a resume from an opportunity
  now shows its "Resume removed from this opportunity" message, or "Could not remove the resume"
  on a failure: the row left the list before the server answered, and the message was lost. A
  fast double click on **Create tailored copy** or **Tailor again** makes one copy, not two; a
  click after a failure works again. A toast whose title or description holds one long unbroken
  word, such as a tailored copy's title, breaks inside the toast instead of running past its
  edge
  ([#469](https://github.com/bgoleno/opportun/issues/469),
  [#484](https://github.com/bgoleno/opportun/issues/484),
  [#491](https://github.com/bgoleno/opportun/issues/491); PR
  [#494](https://github.com/bgoleno/opportun/pull/494)).
- **The guide describes the resume flow.** The pipeline guide's **Resume** section now describes
  the tab as it is: the **Resume for this application** card with its four steps, what it shows
  from "add a base resume" to "sent", sending a base resume as it is, **Tailor again**,
  **Other ways to add a resume** and the phone line. The resumes guide describes finishing a
  tailored copy on its own page, with the **Next step for this resume** strip and **Change
  status**. Two screenshots show the card and the strip
  ([#495](https://github.com/bgoleno/opportun/issues/495),
  [#400](https://github.com/bgoleno/opportun/issues/400); PR
  [#502](https://github.com/bgoleno/opportun/pull/502)).
- **A resume copy marked Submitted counts as sent in the resume flow.** After a copy of this
  opportunity is marked Submitted, **Tailor again** now keeps the flow at "sent" and names the new
  copy, where it used to fall back to tailoring. A Submitted copy counts whether or not it is the newest. With
  an older Submitted copy and a newer Final one, the Resume tab shows "Sent" with a quiet **Record
  that you sent** _title_ link. The tab, the copy's own page and the Assisted apply panel all read
  the same state
  ([#516](https://github.com/bgoleno/opportun/issues/516); PR
  [#528](https://github.com/bgoleno/opportun/pull/528)).
- **A keyboard drop of a board card on Closed or Dismissed says it is waiting for a reason,
  then whether it moved.** The drop announces "... is waiting for a reason to move to the
  Closed column. Choose one in the dialog, or cancel to leave it where it is." Confirming the
  reason announces that the card moved, and cancelling announces that it was not moved. A
  server error leaves the dialog open with its error message and announces nothing. The card's own **Dismiss** button
  and stage menu are unchanged
  ([#432](https://github.com/bgoleno/opportun/issues/432); PR
  [#474](https://github.com/bgoleno/opportun/pull/474)).
- **On the Pipeline board, a keyboard drag reaches every column in on-screen order.** Left and
  Right now step to the previous or next column as they appear, the collapsed **Dismissed** and
  **Closed** rails included, where a drag could skip one of them. At either end the card does not
  move, and Up and Down still reorder within a column. Expanding or collapsing a column keeps
  keyboard focus on that column: it moves to the column's other control, **Collapse** after
  **Expand** and the reverse. A toggle that changes nothing on screen, such as Collapse on a
  column the stage filter holds open, no longer moves focus later, when the filter is cleared. A
  pointer drag is unchanged
  ([#475](https://github.com/bgoleno/opportun/issues/475),
  [#508](https://github.com/bgoleno/opportun/issues/508); PRs
  [#505](https://github.com/bgoleno/opportun/pull/505),
  [#527](https://github.com/bgoleno/opportun/pull/527)).
- **The reason dialog for a stage move cannot be closed while the move is being saved.** From the moment you confirm until the server answers, **Cancel** is
  disabled, the corner close button is hidden, and a click outside the dialog and **Escape** do
  nothing, so a move cannot be reported as cancelled after it has gone through. If the server
  refuses the move, the dialog stays open with its error and **Cancel** works again. This
  applies wherever the dialog appears: the board, a card's menu and the stage control
  ([#476](https://github.com/bgoleno/opportun/issues/476); PR
  [#492](https://github.com/bgoleno/opportun/pull/492)).
- **Assisted apply, only where it is on.** A refused **Apply** button looks dimmed and says why;
  a new draft starts filled from your profile, account and last application, with where each
  value came from and a **Save to my profile** tick (off by default); **Settings > Profile** has
  an **Application details** card (first and last name, country, school, degree, how you heard, LinkedIn, website, links; the city is your profile's Location); the extension fills the city and how-you-heard text questions
  and tells you where to click next; after you apply the panel leads with the outcome; the Resume
  tab shows each resume once with its sends; and a Greenhouse job on a company's own careers page
  is recognised once Greenhouse's API shows one of the company's boards holds it, and then opens
  that board's page. The upgrade adds a column `profiles.application_details` (empty for existing
  profiles); nothing is saved to a profile unless you tick it
  ([#395](https://github.com/bgoleno/opportun/issues/395),
  [#398](https://github.com/bgoleno/opportun/issues/398),
  [#400](https://github.com/bgoleno/opportun/issues/400),
  [#401](https://github.com/bgoleno/opportun/issues/401),
  [#402](https://github.com/bgoleno/opportun/issues/402),
  [#403](https://github.com/bgoleno/opportun/issues/403),
  [#404](https://github.com/bgoleno/opportun/issues/404),
  [#411](https://github.com/bgoleno/opportun/issues/411),
  [#416](https://github.com/bgoleno/opportun/issues/416),
  [#428](https://github.com/bgoleno/opportun/issues/428),
  [#435](https://github.com/bgoleno/opportun/issues/435)).
- **The extension chooses the one matching option in a Greenhouse list, and reports each choice
  first.** On a Greenhouse form it fills the phone's country code, location, school and degree
  lists, and a list question whose label equals one of your reviewed answers (such as "How did
  you hear about this role?"), by choosing the single option that equals your value. If no
  option, or more than one, equals it, or the list does not show in time (3 seconds), it
  leaves the field empty and says why. It never touches the equal-opportunity and demographic
  sections, multi-select lists, discipline, dates, a second education entry or **Locate me**,
  and it leaves a list you already opened alone. The popup shows "Filling in the form" while it
  runs and lists **Chosen from a list: check each before you submit** ahead of what it filled
  in. The country detail is now called **Phone country code** in Opportun, with a hint; what
  you stored under it does not change. The guide's lists paragraph used to say every list was
  left for you
  ([#402](https://github.com/bgoleno/opportun/issues/402); PR
  [#461](https://github.com/bgoleno/opportun/pull/461)).
- **Opening the extension on the form you handed off fills it, the first time, and a keyboard
  shortcut opens the extension.** On the Greenhouse form of an application you reviewed and opened
  from Opportun, opening the extension now fills it at once, the first time only: the popup says
  "Filling the application for _role_ at _company_ on _host_. Keep this window open...", then
  shows the same report as the button. Every later time, and on any other page, it behaves as
  before, with **Fill in this application**. **Alt+Shift+O** opens the extension, exactly as a
  click on its icon does, and you can rebind it or turn it off in the browser's own shortcut
  settings. The popup's lookup is bounded at 5 seconds and its work runs one at a time. In
  Opportun, the **Open** step reads "Not filled by the extension yet." until the extension has
  read the application, then "The extension read this application at _time_. Check the form, and
  press Fill in this application in the extension if it is empty." **On upgrade:** a nullable column `application_submissions.prefill_read_at`
  is added (SQLite migration 0066, Postgres 0048). Use an extension built with this change
  together with a server that has it: an older server does not say which read was the first, and
  the popup then only offers the button
  ([#403](https://github.com/bgoleno/opportun/issues/403); PR
  [#507](https://github.com/bgoleno/opportun/pull/507)).
- **The project's identifier guard in CI keeps withheld terms out of its public log.** The guard
  that fails a pull request when a withheld identifier is present now masks every term before it
  scans, and reports a hit by file and line only, never the term or the
  matching text; a path whose name holds a term, in any case, is not printed. This changes the project's own CI and nothing in the running application
  ([#520](https://github.com/bgoleno/opportun/issues/520); PR
  [#529](https://github.com/bgoleno/opportun/pull/529)).
- **The guide now says your resume reaches Greenhouse when the extension attaches it, not
  when you press Submit.** The behaviour is not new: when the form's resume field is empty and
  takes a PDF, the extension attaches your Final resume, and Greenhouse's own form uploads it
  at once, as it does when you choose a file yourself. So Greenhouse can hold your resume even
  if you then decide not to apply. Open the extension on the form, or press **Fill in this
  application**, only when you mean to apply ([#468](https://github.com/bgoleno/opportun/issues/468); PR
  [#470](https://github.com/bgoleno/opportun/pull/470)).
- **A company's careers page and domain come from the domains its name gives.** The result is the
  same with or without a message; a careers page found through a sender is used for that
  opportunity only and is not saved on the company. Values already saved are not changed
  ([#451](https://github.com/bgoleno/opportun/pull/451)).

- **Empty Profile fields show neutral examples, each marked "e.g.".** Under **Settings > Profile**,
  the empty Headline, Location (city) and Work authorization fields show examples such as "e.g.
  Senior software engineer" and "e.g. Springfield, Illinois, United States", and the city and
  school hints use neutral examples too. Only placeholder and hint text changed: nothing you
  stored is different, and the details step of an application shows the same hints
  ([#500](https://github.com/bgoleno/opportun/issues/500); PR
  [#503](https://github.com/bgoleno/opportun/pull/503)).

### Install

- **The optional settings in `deploy/.env` now reach the server on Compose.** `compose.yml` passes
  `OPPORTUN_SUBMISSIONS`, `OPPORTUN_DAILY_REVIEW_CAP`, `OPPORTUN_AI_ALLOW_LOOPBACK_HTTP`,
  `OPPORTUN_TELEMETRY_ALLOW_PRIVATE`, `DB_POOL_MAX`, `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`
  and `OPPORTUN_PEPPER_VERSION` and `OPPORTUN_PEPPER_V1` to `V9`. **On upgrade:** a line for one
  of these that was sitting in an existing `deploy/.env` took no effect before and now does, at
  the next `docker compose up -d`; check for stray lines, the two base URLs in particular, since
  a value there now sends every request for that provider to that address. An empty value is the
  same as unset
  ([#417](https://github.com/bgoleno/opportun/issues/417); the two base URLs,
  [#423](https://github.com/bgoleno/opportun/issues/423) and PR
  [#479](https://github.com/bgoleno/opportun/pull/479)).
- **An empty `ANTHROPIC_BASE_URL` or `OPENAI_BASE_URL` no longer stops the server from
  starting.** The AI library refused an empty or blank value ("baseURL must be a non-empty
  string"), which crashed the container as soon as compose passed the variable empty. The
  server and its command-line tools (backup, restore, password reset, seed, copy to Postgres)
  now unset an empty or blank value before the library loads, so it is the same as not setting
  it. CI gains a fourth Docker leg, `docker (minimal)`, that starts the stack from an empty
  `.env` and fails if the container restarts; it is now a required check
  ([#423](https://github.com/bgoleno/opportun/issues/423); PR
  [#479](https://github.com/bgoleno/opportun/pull/479)).
- **Two transitive dependencies moved so the dependency scan passes.** `hono` 4.13.13 to
  4.13.18 and `@hono/node-server` 2.1.5 to 2.1.8, both pulled in by the MCP client library, in
  `pnpm-lock.yaml` only. Opportun uses that library's client side only, and a test now fails if
  server code imports anything else from it. The project's security review judged the advisories
  not reachable ([#466](https://github.com/bgoleno/opportun/issues/466); PR
  [#471](https://github.com/bgoleno/opportun/pull/471)).
- **SQLite can checkpoint its write-ahead log in a background thread, for a slow disk. It is
  off by default.** Set `OPPORTUN_SQLITE_BACKGROUND_CHECKPOINT=1` (only `1` turns it on; on
  Compose, put it in `deploy/.env`) and restart. A thread on its own connection then
  checkpoints once 1,000 pages (about 4 MB) wait to be copied or anything has waited a
  minute, so a write no longer waits for the checkpoint's copy and sync, and the server's own
  automatic checkpoint moves from 100 pages to 10,000 as a backstop. Unset, nothing changes.
  It has no effect on Postgres. Writes are synced within about a minute, or sooner under
  load, instead of every 100 pages. The costs: the log grows to about 4 MB between
  checkpoints (about 40 MB in a long burst), a second connection stays open, and the slowest
  single write in a long burst can be slower than without it. If the thread stops, the server logs it and goes back to automatic
  checkpoints. On an SSD, leave it unset. See **SQLite on a slow disk** in the
  [install guide](docs/install.md#4-configuration-reference)
  ([#383](https://github.com/bgoleno/opportun/issues/383); PR
  [#393](https://github.com/bgoleno/opportun/pull/393)).
- **The install guide and the guide now say how assisted apply is turned off, and how the daily
  review limit works.** Assisted apply is on unless `OPPORTUN_SUBMISSIONS=0` is set (in
  `deploy/.env` on Compose, then `docker compose up -d`); any other value stops the server from
  starting, and it is never on the demo. `OPPORTUN_DAILY_REVIEW_CAP` (default 10, unset or empty
  is 10, 1 to 25 in digits only, anything else stops the server from starting) is the most
  applications one user can confirm a review for in a rolling 24 hours. A user can lower their own
  limit under **Settings > Profile > Applications**, never above the server's. Section 4 of the
  [install guide](docs/install.md#4-configuration-reference) has both settings, and the
  [Settings page of the guide](docs/guide/settings.md#applications-and-the-review-limit) the
  limit ([#453](https://github.com/bgoleno/opportun/issues/453); PR
  [#499](https://github.com/bgoleno/opportun/pull/499)).
- **The published image's `latest` tag moves only when a maintainer publishes, and the install
  guide now has the upgrade steps for it.** The image at `ghcr.io/bgoleno/opportun` is built
  only when someone runs the **Publish image** workflow by hand, so `latest` is the build last
  published from `main` and can be behind it. If you run the published image, upgrade with a
  backup, then `docker compose pull` and `docker compose up -d` (not `--build`), and change a
  pinned `sha-...` tag in `OPPORTUN_IMAGE` first. Section 6 of the
  [install guide](docs/install.md#6-upgrades-and-backups) has the steps and how a maintainer
  publishes; the README says the same about `latest`
  ([#477](https://github.com/bgoleno/opportun/issues/477); PR
  [#481](https://github.com/bgoleno/opportun/pull/481)).
- **Settings shows the version and commit that is running.** Under the list of Settings
  sections, on every page, it reads "Version 0.3.1 (d4d97b6)", "Development build (d4d97b6)" when
  only the commit is known, or "Development build" when neither is. Both come from the Publish
  image build, which passes them into the image. They show only in an image published after
  this change: 0.3.1 predates it, so it shows no version. An image built locally with
  `docker compose up --build`, and a run from source, say "Development build". The route behind
  it, `GET /api/v1/settings/build`, answers any signed-in user and makes no call to GitHub or
  GHCR ([#480](https://github.com/bgoleno/opportun/issues/480); PR
  [#487](https://github.com/bgoleno/opportun/pull/487)).
- **A version publish is now a release: a git tag and a GitHub Release.** Running the Publish
  image workflow with a version (for example `-f version=0.3.2`) creates the git tag
  `v<version>` and a GitHub Release on the commit it built, as well as tagging the image. It
  works only from `main`, and only when `CHANGELOG.md` has a non-empty `## <version>
(YYYY-MM-DD)` section for that version: the release notes are that section, followed by the
  image and a link to the commit. It refuses a version whose image tag, git tag or Release
  already exists, so a version names one build. A publish without a version builds an image
  only. The first tag, [v0.3.1](https://github.com/bgoleno/opportun/releases/tag/v0.3.1), was
  made by hand on 2026-11-13 at the commit of PR
  [#474](https://github.com/bgoleno/opportun/pull/474). Separately, a `sha-...` image tag is
  now one per commit and never moves (a second publish of the same commit is refused), and
  every published image carries the labels `org.opencontainers.image.revision` (the commit) and
  `org.opencontainers.image.version`. The install guide's section 6 and the
  [demo deployment](docs/demo-deployment.md#publishing-a-new-build-from-a-workflow) page have
  the rules ([#478](https://github.com/bgoleno/opportun/issues/478); PR
  [#489](https://github.com/bgoleno/opportun/pull/489)).
- The connector's messages name **Settings > Integrations > Extensions and Connectors** as the
  app shows it ([#235](https://github.com/bgoleno/opportun/issues/235)).

### Earlier in this release

- **A message's full text is encrypted while it waits to be classified.** The text of a new
  message reaches the classifier through its job, which is cleared when the job finishes; it
  is now sealed with the server's secrets key the whole time, so the database files never hold
  it in the clear, not even in space a cleared value leaves behind. Text of messages classified
  before this change may remain in that unused space until it is reused: the install guide
  (section 6, "Clearing message text left from before encrypted classification") gives the
  one-time step to clear it on SQLite and on Postgres
  ([#175](https://github.com/bgoleno/opportun/issues/175)).
- **LinkedIn job captures keep only what the page says.** With an AI key, a job captured from
  LinkedIn now keeps the location and pay the model reads only when the captured page itself
  contains them, as Indeed captures already do, and its description is the page's own text
  rather than the model's rewrite of it. So a figure, a link or a location the posting never
  showed can no longer end up on the opportunity. The LinkedIn prompt now asks for location and
  pay copied exactly, updated by an automatic upgrade step; a prompt version you made yourself is
  left as it is. If you use your own version of the LinkedIn capture prompt, it does not ask for
  exact copies, so expect more locations and pay lines to come back empty: a value the model
  reworded is now dropped. To use the shipped prompt again, open **Settings > AI > Advanced:
  prompts**, choose the `capture.linkedin` task and press **Reset to default**; or add the
  instruction to copy location and pay exactly as the page states them to your own version.
  Captures without an AI key, profile captures and Indeed captures are unchanged
  ([#88](https://github.com/bgoleno/opportun/issues/88),
  [#102](https://github.com/bgoleno/opportun/issues/102)).
- **Indeed captures get their location and pay.** With an AI key, a job captured from Indeed now
  gets the location and the pay the posting states, read by a new site-neutral prompt
  (`capture.job`, added to the prompt list by an automatic upgrade step). A value is kept only
  when the captured page itself contains it, so anything the posting does not say stays empty;
  the title, company and description are still read from the page exactly as before. Without an
  AI key nothing changes, and LinkedIn captures are unchanged
  ([#76](https://github.com/bgoleno/opportun/issues/76)).
- **The browser extension captures Indeed jobs.** On an Indeed job page
  (`indeed.com/viewjob?jk=...`), or an Indeed search with a job open on the right, **Capture
  this page** turns the job into an opportunity at Interested, exactly as a LinkedIn job does.
  Both views of one job send the same thing: the job's title, company, details and
  description, under the link `https://www.indeed.com/viewjob?jk=...`, and nothing from the
  site's navigation, the search results or the recommended jobs. A pending lead from an Indeed
  job alert email for the same job is completed rather than duplicated. A search with no job
  open or a company page is refused in the popup without reading the tab, and if Indeed changes
  its page so that the job cannot be found, the popup says the layout was not recognized and
  sends nothing. The extension now asks for access to `www.indeed.com` as well as
  `www.linkedin.com`, and still reads a tab only when you click. Indeed's country sites are
  not supported ([#72](https://github.com/bgoleno/opportun/issues/72),
  [#73](https://github.com/bgoleno/opportun/issues/73),
  [#74](https://github.com/bgoleno/opportun/issues/74)).
- **Contacts is now called Network.** The section that holds the people you know is
  **Network** in the menu and on its page, and it lives at `/network`; one person in it is
  still a contact. The API moved to `/api/v1/network`, the import pack's `contacts.csv` is now
  `network.csv`, and the database table is `network_contacts`. The old names keep working:
  `/contacts` links and bookmarks redirect, `/api/v1/contacts` answers exactly as
  `/api/v1/network` does, and a pack with `contacts.csv` still imports (a pack holding both
  files is refused). The data export's `export.json` is now format `opportun-export/2`, because
  the network's table is keyed `network_contacts` there instead of `contacts`; nothing else in
  the file changed. The upgrade renames the table in place and keeps every row and every link
  to it ([#22](https://github.com/bgoleno/opportun/issues/22)).
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
not flow back). Decision: [ADR-4](docs/adr/0004-postgres.md).

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
iteration 4 ([ADR-4 amendment](docs/adr/0004-postgres.md)).

## Attach a posting (2026-10-17)

An opportunity tracked without its job description can get one with **Find posting**: from
an ATS link in its linked messages, or from the company's job board, detected first if
needed, with a search over the whole board when the match is not unique (FR-O1).

## M4: Network (2026-10-16)

Contacts arrive from the LinkedIn data export (connections and messages), are mapped to
companies, and are ranked by AI as referral candidates for each opportunity; referral asks
are tracked and appear on the opportunity's timeline.

## M3: Discovery (2026-10-16)

The discovery engine: pluggable sources (Greenhouse, Lever and Ashby job boards, the
user's own MCP connectors, LinkedIn and Indeed job alert emails, manual capture),
scheduled runs, AI ranking against role targets with an editable prompt, dismissal
learning through reviewed prompt changes, AI company suggestions with job board
detection, lead resolution to the canonical ATS posting, and a keyboard-driven review
queue.

## M2: Communications (2026-10-15)

Read-only Gmail ingestion with cursor recovery, AI classification of recruiter mail,
automatic linking to opportunities with proposed stage transitions, broadcast-spam and
role-mismatch filtering, solicitations turned into tracked opportunities, and a unified
inbox.

## M1: MVP tracker (2026-10-15)

Accounts and sessions, profile and role targets, the opportunity pipeline with timeline,
notes and documents, base and tailored resumes in the user's own Google Docs with an
iterative AI tailoring workspace and personal resume rules, CSV and zip-pack import and a
full export, nightly SQLite snapshots, and a single-container deployment behind Caddy.
