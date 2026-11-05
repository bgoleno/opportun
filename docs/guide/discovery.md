# Discovery

[Guide home](README.md) · Previous: [Mail filters](mail-filters.md) · Next: [Browser extension](browser-extension.md)

Discovery finds new postings, ranks each one against your role targets with AI, and puts
them in a review queue. Nothing reaches your pipeline until you accept it.

**Discovery** has five tabs: **Review queue**, **Decided**, **Companies**, **Sources** and
**Prompts**.

## Where postings come from

| Source             | How it works                                                                |
| ------------------ | --------------------------------------------------------------------------- |
| Company job boards | Greenhouse, Lever, Ashby and Workday, read through their public job APIs    |
| Followed companies | A company you follow gets its job board detected and becomes a board source |
| Job alert emails   | LinkedIn and Indeed job alert digests in your Gmail become leads            |
| Manual capture     | A posting link or pasted text                                               |
| Capture extension  | A LinkedIn job page you send from your browser                              |
| MCP                | A tool on an MCP server you run yourself                                    |

### Add a board source

On **Sources**, press **New source** and choose a kind:

- **Greenhouse, Lever, Ashby**: enter the board slug (for Greenhouse, the `<slug>` in
  `boards.greenhouse.io/<slug>`).
- **Workday**: paste the company's career site URL, or any posting on it. The `wd1`/`wd5`
  part of the host is kept as given. Workday describes each posting with an extra request, so
  a run fetches at most 200 new descriptions and leaves the rest for the next run. Workday
  sites go down for a weekly service window; a run during it fails and a later one succeeds.
- **MCP**: see [install guide section 7](../install.md#7-configuring-discovery-sources).
  Sources that run a local command are admin-only.

Each source takes an optional **schedule** (cron, for example `0 7 * * *` for daily at
07:00; empty means it only runs when you press run) and an optional **role target** (empty
ranks against all your role targets). The Sources table shows each source's status, last
and next run, an enabled switch, and actions to run it now, see its run history, edit or
delete it.

Below the table, **Posting volume and ranking cost** shows each company board's open jobs at its
last run and, over the last 14 days, its new postings a day, the ranking calls that means, and
what they cost at the last 30 days' average cost per call. A board's first run brings in the whole
board, so it is left out: after only one run, those figures say "no data yet".

**A new board's first run.** The first time a company board runs successfully, Opportun ranks only
its 25 newest postings, so one large board cannot use up your discovery budget. The rest are stored
and shown in the queue as **Not ranked: below the cut**. To rank them, choose **Rank these** on that
source's row in the Sources table. It shows how many there are and the estimated cost, based on your
average cost per ranking call over the last 30 days, before anything runs. Once you confirm, they go
through your [discovery budget](settings.md#models-and-budgets) like any other posting, so any that
do not fit today wait for a later budget day. Later runs of that board are not capped.

### Follow companies

The **Companies** tab offers companies to follow from two places.

**In your network** lists every company where someone in your contacts works now, read from your
own contacts. Each one shows whether it has a job board and **You know N people here**; open that
to see their names. **Follow** one and Opportun looks for its job board, and it then shows
**Following**. **Deny** one and it leaves this list and joins **Denied companies**; tick **Show
denied** to see it here again, with **Undo**. If the list is empty, add your contacts' current
companies under [Network](network.md).

**Suggested companies** comes from the `company.suggest` task, which once a week (Tuesdays)
proposes companies worth following, based on your role targets and past decisions, each with its
reason. **Follow** one and Opportun looks for its job board; **Deny** it and it is not suggested
again.

![The Companies tab. In your network lists Initech, with Priya Example and Sam Example named under You know 2 people here and Follow and Deny buttons, and Globex, marked Following with no board found. Suggested companies lists Pied Piper with its reason and Follow and Deny buttons](images/discovery-companies.png)

_The Companies tab, with invented contacts. Following a company starts job board detection._

A followed company shows the board it found (for example "Greenhouse: piedpiper") and a
**Detect now** button; boards are re-checked weekly. The detected board becomes a source that
runs daily. If no board is found, the card asks for the company's careers page URL so it can
be scanned. Workday boards are only detected from a URL (a careers page on Workday, or
Workday links on the company's careers page), never guessed from the name.

### Job alert emails

If Gmail is connected, LinkedIn (`jobalerts-noreply@linkedin.com`) and Indeed
(`alert@indeed.com`) job alert digests are recognized during Gmail sync by default, and each
job in them becomes a lead in the review queue. Digests skip the AI classifier and never
appear as inbox messages to triage. **Edit alert senders**, on the Sources tab, lets you add
or remove senders, or reset to the built-in LinkedIn and Indeed pair; an address only does
anything once a digest from it actually matches one of Opportun's two understood layouts, so
adding an arbitrary sender does not teach it a new one. (The screenshots here come from a test
mailbox without alert digests, so none are shown.)

## The review queue

The queue lists new results, best score first. Each shows the AI score (0 to 100) or
**Unscored**, badges for how complete the posting is, its source, location and remote status, the
AI's one-line reason, the start of the description, the pay if listed, and a link to the posting.

An unscored result can say why, in a line on its card:

- **Waiting for budget**: it is ranked when your [discovery budget](settings.md#models-and-budgets)
  has room.
- **Not ranked: below the cut**: a board's first run ranks only its 25 newest postings. **Rank
  these** on the [Sources](#add-a-board-source) tab sends the rest.
- **Not ranked: AI is not set up (Settings > AI)**: there is no AI key to rank it with.
- **Not ranked: the AI provider was unavailable** or **Not ranked: the AI's answer could not be
  used**: the call failed.

On any result:

- **Accept** adds it to your pipeline in New. If it matches an opportunity you already
  track, you are asked to attach it there instead, or accept it anyway (see
  [Pipeline](pipeline.md#possible-duplicates)).
- **Dismiss** asks for a reason (Seniority, Compensation, Location, Industry, Company,
  Stale, Other) and an optional note.
- Keyboard: `j`/`k` select, `i` accepts, `x` dismisses, `Enter` opens.

![The review queue with three Vandelay Industries postings to review: the top two shown, scored 92 and 70, the first one selected](images/discovery-review-queue.png)

_The review queue, ranked against the "Staff platform" role target. The selected result has a blue outline._

**Cost and limits.** Ranking spends from your [discovery budget](settings.md#models-and-budgets); over it a posting waits for the next budget day rather than being skipped, and a scored posting waiting to be ranked again says its score may change. Ranking is one `discovery.rank` call per new posting (a source with no
role target is judged against all your role targets in that one call). A busy board on a daily schedule can mean dozens of calls a day. For the first week, watch
**Posting volume and ranking cost** on the Sources tab, and **Usage** and
[**Discovery ranking cost**](settings.md#models-and-budgets) under **Settings > AI**, and narrow
your sources if needed. The score is the model reading your role target and the posting text; it misses things a posting leaves
out, so skim the low scorers occasionally.

**The title pre-filter (measuring only).** Each new posting from a job board also gets a
pass or filtered verdict from a cheap, local check: does its title match your role target, and
does its stated location and remote setting fit? It needs no AI call per posting and, for now,
changes nothing: every posting is still ranked. **Decided** shows how often it would keep the
job board postings you accepted, with the count, so you can judge it before it is ever turned on.
That figure is worked out each time against your current role targets, so it includes postings you
accepted before this existed, and it moves when you edit a target. Postings from job-alert emails
are not checked.

The location check is deliberately lenient. It filters a posting only when it names a place that
is clearly not one of yours. A posting saying "Multiple locations" or "United States" is kept, and
a target with a country, state or region among its locations (such as "Texas" or "Europe") filters
on no location at all. It does not know which towns surround a city, so a target of "Seattle" would
still filter a posting in "Bellevue, WA".

It compares titles with each role target's **title variants** (**Settings > Role targets**):
20 to 40 equivalent titles, made by one `discovery.title_variants` AI call when you add a target
or change its name or title family. That call sends the target's name, title family, seniority
range and keywords, and nothing else. A target with no list yet, because it is older than this
feature or the call found no AI key or budget, gets its call when you add a key or in a nightly
sweep, without you doing anything. You can edit the list, and a list you save or clear stays as
you left it, even if a call was already running. A new name or title family replaces it with a
fresh one, unless you edit the list in the same save.

## Decided results

Accepting or dismissing a result keeps a later sighting of the same job (same company, title
and location, however it resurfaces) from showing up in the queue again, rather than treating
it as new each time. **Decided**, with its own **Dismissed** and **Accepted** tabs, is where
those settled results live.

Dismissed a result that was wrong to skip, or a requisition reopened later? **Unsuppress**
lets the next repost through to the review queue again, instead of it being silently treated
as the same job forever. For an accepted result, unsuppressing only takes effect once the
opportunity it became is itself dismissed; while that opportunity is still active, a repost
should keep being treated as the same job.

Once unsuppressed, a result shows an **Unsuppressed** badge in place of the button. Reversing
a decision and never having made one are different states, and collapsing them into one
undifferentiated row would leave no way to tell, at a glance, which ones were already
reopened and which still hold their key.

## Capture a posting yourself

**Capture posting** (on the review queue) takes a posting link or pasted text, extracts the
company, title, location and description, and adds the result to the queue. If extraction
cannot find the essentials, it tells you to create the opportunity by hand instead.

Opportun never fetches LinkedIn or Indeed pages. A LinkedIn or Indeed link is refused with a
prompt to paste the description text instead, or capture the job with the
[browser extension](browser-extension.md) from your own browser.

![The Capture posting dialog refusing a LinkedIn link and offering Paste the text instead](images/discovery-capture-linkedin.png)

_A LinkedIn link is refused before anything is fetched; paste the text or use the extension._

### The capture extension

The **Opportun Capture** extension (Chrome, Chromium browsers and Firefox 128+) sends the
LinkedIn profile or job, or the Indeed job, you are looking at to your server, only when you
click **Capture this page**. A captured job becomes an opportunity at **Interested** and does not
pass through this queue: capturing one is how you say you want it. If the job is already
sitting here as a lead from an alert email, that lead is completed and accepted rather than
duplicated. Profiles become contacts (see [Network](network.md)). The
[browser extension](browser-extension.md) page covers what happens next.

1. Create a device token with the **Browser capture** permission under **Settings >
   Integrations > Extensions and Connectors**.
2. Install it from **Settings > Integrations > Extensions and Connectors**; the full story is
   in [Browser extension](browser-extension.md).
3. In the popup, open **Settings**, enter your server address and the token, **Save**, then
   **Test connection**.

![The Opportun Capture popup with its Capture this page button and the Settings panel open](images/extension-popup.png)

_The extension popup, with Settings open. (Captured by loading the built extension into Chromium and opening its popup page in a tab.)_

Each token can capture 30 pages per 15 minutes. Only profiles and job pages are accepted;
feeds, search results and company pages are refused.

## Ranking prompts

The **Prompts** tab shows the prompt each role target ranks with: its versions, which one is
in use, and an editor. Saving creates a new version for that role target only; your other
role targets and your default prompt are untouched. **Reset to default** goes back. Keep the
`{{...}}` placeholders: they are filled in when ranking runs.

![The Prompts tab for the Staff platform role target, showing version v1 in use and the prompt editor](images/discovery-prompts.png)

_Every prompt is visible and versioned. Edits apply to one role target._

## Dismissal learning

Your dismissal reasons are not wasted. Once a week (Wednesdays), for each role target with at
least five dismissals since the last refinement (from the review queue, or opportunities
dismissed in the pipeline), the `discovery.refine_prompt` task proposes a revised ranking
prompt. The proposal shows on the Prompts tab with a summary and a diff against the version in
use. **Accept** makes it the role target's prompt; **Discard** drops it. Nothing changes
without your accept.

<!-- nav:bottom -->

---

| [← Mail filters](mail-filters.md) | [Guide home](README.md) | [Browser extension →](browser-extension.md) |
| :-------------------------------- | :---------------------: | ------------------------------------------: |
