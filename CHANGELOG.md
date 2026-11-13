# Changelog

Opportun's first tagged release is [v0.3.1](https://github.com/bgoleno/opportun/releases/tag/v0.3.1)
(2026-11-13, made by hand, at the commit of PR [#474](https://github.com/bgoleno/opportun/pull/474)). See
[SECURITY.md](SECURITY.md) for which versions are supported. Entries are grouped by milestone (requirements
section 7, [docs/requirements.md](docs/requirements.md)), newest first, dated by when the
milestone's work was merged.

## Unreleased

### Upgrading: prompts, defaults and costs

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

### Mail, pipeline and assisted apply

- **An unsubscribe request your own mail app sent is filtered.** A message from your own address
  to an unsubscribe address, or whose body is only Gmail's "automatically generated" line, now
  lands on the Blocked tab as "an unsubscribe request your mail app sent" instead of the Inbox.
  Messages already ingested stay where they are. There is no switch; restore one from the
  Blocked tab ([#392](https://github.com/bgoleno/opportun/issues/392)).
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
- **A keyboard drop of a board card on Closed or Dismissed says it is waiting for a reason,
  then whether it moved.** The drop announces "... is waiting for a reason to move to the
  Closed column. Choose one in the dialog, or cancel to leave it where it is." Confirming the
  reason announces that the card moved, and cancelling announces that it was not moved. A
  server error leaves the dialog open with its error message and announces nothing. The card's own **Dismiss** button
  and stage menu are unchanged
  ([#432](https://github.com/bgoleno/opportun/issues/432); PR
  [#474](https://github.com/bgoleno/opportun/pull/474)).
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
- **The guide now says your resume reaches Greenhouse when the extension attaches it, not
  when you press Submit.** The behaviour is not new: when the form's resume field is empty and
  takes a PDF, the extension attaches your Final resume, and Greenhouse's own form uploads it
  at once, as it does when you choose a file yourself. So Greenhouse can hold your resume even
  if you then decide not to apply. Press **Fill in this application** only when you mean to
  apply ([#468](https://github.com/bgoleno/opportun/issues/468); PR
  [#470](https://github.com/bgoleno/opportun/pull/470)).
- **A company's careers page and domain come from the domains its name gives.** The result is the
  same with or without a message; a careers page found through a sender is used for that
  opportunity only and is not saved on the company. Values already saved are not changed
  ([#451](https://github.com/bgoleno/opportun/pull/451)).

### Install

- **The optional settings in `deploy/.env` now reach the server on Compose.** `compose.yml` passes
  `OPPORTUN_SUBMISSIONS`, `OPPORTUN_DAILY_REVIEW_CAP`, `OPPORTUN_AI_ALLOW_LOOPBACK_HTTP`,
  `OPPORTUN_TELEMETRY_ALLOW_PRIVATE`, `DB_POOL_MAX` and `OPPORTUN_PEPPER_VERSION` and
  `OPPORTUN_PEPPER_V1` to `V9`. **On upgrade:** a line for one of these that was sitting in an
  existing `deploy/.env` took no effect before and now does, at the next `docker compose up -d`;
  check for stray lines. An empty value is the same as unset. `ANTHROPIC_BASE_URL` and
  `OPENAI_BASE_URL` still need a `compose.override.yml`
  ([#417](https://github.com/bgoleno/opportun/issues/417)).
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
- **Releases now have git tags,** starting with
  [v0.3.1](https://github.com/bgoleno/opportun/releases/tag/v0.3.1), made by hand on
  2026-11-13 at the commit of PR [#474](https://github.com/bgoleno/opportun/pull/474). A
  release tag is separate from the image tags: the Publish image workflow's optional version
  input tags an image, and does not create a git tag.
- The connector's messages name **Settings > Integrations > Extensions and Connectors** as the
  app shows it ([#235](https://github.com/bgoleno/opportun/issues/235)).

### Earlier in Unreleased

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
