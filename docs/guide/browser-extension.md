# Browser extension

Opportun never visits LinkedIn, or any other job site, on its own. When you are looking at a
profile or a job posting and you want it in Opportun, you click the extension and it sends
that page's visible text to **your own** server. A profile becomes a contact; a job posting
becomes an opportunity at Interested, because you only capture what you have already decided
you want.

The extension is called **Opportun Capture**, and it works in Chrome, Edge, Brave and
Firefox 128 or later.

## Setting it up

Everything happens in one place. Open **Settings > Integrations > Extensions and
Connectors**, find **Browser extension**, and press **Set up**.

The dialog walks the whole way through:

1. Confirm your password. Creating a token needs more than a logged-in browser.
2. Opportun creates a token, named for the browser and for you, and shows it. Copy it and
   keep it somewhere safe: it is shown here once and never again, because the server stores
   only a hash of it. You can rename it in the same step.
3. Download the extension for the browser you are using.
4. Install it from the folder you downloaded, following the steps on screen. They differ
   between Chrome and Firefox.
5. Open the extension, paste the token and press Save. The server address is already filled
   in, because the download came from your server and knows where it lives.
6. The last step turns green by itself the first time the extension talks to your server.

If you run two browsers, or two computers, set each one up separately. **Set up** stays
available, and each browser gets its own token you can revoke on its own.

## Using it

Open a LinkedIn profile or job posting, or an Indeed job, click the Opportun icon, and press
**Capture this page**.

- A **profile** (`linkedin.com/in/...`) becomes a contact, with company and position. Capturing
  the same person again updates them.
- A **job posting** (`linkedin.com/jobs/view/...`, or the jobs search view with a posting
  selected) becomes an **opportunity at Interested**.
- An **Indeed job** (`indeed.com/viewjob?jk=...`, or an Indeed search or the Indeed home page
  with a job open on the right) becomes an **opportunity at Interested** too, with the job's title, company and
  description and the link `https://www.indeed.com/viewjob?jk=...`. With an AI key, the
  location and pay the posting states are filled in too; anything the posting does not show is
  left empty. Every view of one job gives the same result, and nothing from the lists beside it
  is sent. On the home page, click the job you want first: it shows a job as it loads, but
  only clicking one puts it in the page's address. Indeed's country sites are not supported yet.

Capturing a job is treated as a decision, not as filing something to look at later: you are
reading the posting and you want it. So a captured job never lands in the review queue. If the
job was already sitting there as a lead from a job alert email, that lead is filled in and
accepted rather than duplicated, and if you already track the job, the capture fills in
whatever the opportunity was missing. An opportunity you had dismissed comes back to
Interested, because capturing it means you changed your mind. One you have already applied to,
or are interviewing for, keeps its stage and only gains the details.

A different job that only looks like one you track is kept apart instead: for example a
Principal role on the same site as the Staff role you track at that company and location,
whose titles match once the seniority word is set aside. It gets its own opportunity, flagged as a possible
duplicate, with a **Kept apart** entry on its timeline. See
[Possible duplicates](pipeline.md#possible-duplicates) for exactly when that happens and what
you can do about it.

## What happens after a capture

Opportun then looks for the same job on the **company's own job board**, which is the version
that carries the full description and stays correct when the company edits it.

- Found: the company's copy becomes the description, and anything the captured page said that
  the company's posting does not cover is kept underneath it, under a heading naming where it
  came from. Nothing is rewritten; the employer's words stay the employer's words.
- Not settled: nothing is changed, and the opportunity is flagged. You will see a note in the
  **Description** card and a **Posting unconfirmed** mark on its card in the pipeline. The note
  says what happened (several postings on the board could be this one, the posting is not on
  the board, the company has no board Opportun can find, or the check did not finish) and
  offers the button that resolves it.

If you edit the description yourself before the board check finishes, your text is kept and the
check is flagged for you to decide about: the note then offers **Review board copy**, which
looks the posting up so you can take the company's version if you want it. Nothing replaces
your own writing unless you ask for it.

Feeds, search result lists, company pages and the signed-out page are refused, and the popup
says why. On Indeed, a search or the home page with no job opened and a company page are refused in the popup
before anything is read. Pages on other sites are not read at all.

There is a limit of 30 captures every 15 minutes per token, and 60 every 15 minutes for your
account, counting every browser and the web app's Capture posting dialog. Both are far above
normal use and exist so a mistake cannot turn into a flood. When one is reached, the popup says
which, and when you can capture again.

A capture can also be refused for a moment, not for a limit: Opportun saves one of your
captures at a time, so while an earlier one is still being saved, a second waits a few seconds
and is then turned away. The popup says "Opportun is still saving another capture of yours" and
to try again in a few seconds. Nothing is wrong: this attempt saved nothing, so wait a moment
and click **Capture this page** again.

## Filling an application (assisted apply)

Where assisted apply is on, the extension can fill a Greenhouse application form with what you
reviewed in Opportun. It needs a token with the **Assisted apply** permission: create one, or
set the extension up, under **Settings > Integrations > Extensions and Connectors**.

1. In Opportun, review the application and press **Confirm review and open**. The form opens
   in a new tab.
2. On that tab, click the Opportun icon in your browser's toolbar, or press its keyboard
   shortcut (see below). If the icon is not there, open your browser's Extensions menu and pin
   Opportun.
3. The first time you open it on that form, the extension says which application it is
   filling, and fills in what you reviewed. Open it there again later and it does not fill by
   itself: press **Fill in this application** to fill again. Where the
   form asks with a list (the phone's country code, Location (City), the first School and
   Degree, or a question such as "How did you hear about this role?"), it chooses the one
   option that reads exactly as your value, waiting a few seconds for each list. If you type or
   choose in a list while it waits, it leaves that list to you. Keep the popup open until it
   shows its report. Your resume is uploaded to Greenhouse at this step, not when you submit
   (see below).
4. The report lists every option it chose first, then what it filled and what it left for you,
   with the reason. A list it could not choose in (no option, or more than one, matches your
   value) is left empty for you.
5. Check every field, fill in anything it left, and press the site's own Submit button. The
   extension never submits.

**The keyboard shortcut.** Alt+Shift+O opens the extension, exactly as a click on its icon does,
and does nothing more. To change it, or turn it off, open `chrome://extensions/shortcuts` in
Chrome, Edge or Brave. In Firefox, open **about:addons**, choose the gear menu, then **Manage
Extension Shortcuts**.

**Your resume reaches Greenhouse before you press Submit.** When the form's resume field is
empty and takes a PDF, the extension attaches your Final resume to it, and Greenhouse's own form
then uploads the file to Greenhouse at once, exactly as it does when you choose a file yourself.
So Greenhouse can hold your resume even if you then decide not to apply. Open the extension on
the form, or press **Fill in this application**, only when you mean to apply. When the field has
a file already, or does not take a PDF, the extension leaves it and lists the resume among what
it did not fill. The extension
still never presses Submit.

It fills only a Greenhouse form on Greenhouse's own pages (`boards.greenhouse.io` or
`job-boards.greenhouse.io`), and only the application you reviewed and opened from Opportun.
Opportun's last step says which applies: where the extension cannot fill the form, or you have
no such token, it tells you to copy your details instead. A Greenhouse job shown on the
company's own careers page is not filled while Opportun has only the careers link. Press **Find
posting** on the opportunity: once Greenhouse's API shows the job is on one of the company's
boards, the review opens its Greenhouse page, and the extension can fill that. If no such board
holds the job, you apply on the careers page and copy your details yourself.

## Why it works this way

LinkedIn's User Agreement prohibits automated retrieval of its pages, and Opportun takes that
seriously rather than working around it. Opportun treats Indeed the same way: the server never
fetches an Indeed page, so the extension is how an Indeed job you are reading gets in. The extension is built so it **cannot** be used as a
scraper, and the project's tests enforce it:

- **Nothing runs until you click.** There is no background process, no code injected into
  pages as you browse, and no timer. The extension's manifest declares none of those, and a
  test fails the build if that ever changes.
- **It reads the page you are already looking at**, as your browser has already rendered it.
  It never opens, navigates, scrolls, clicks or reloads anything, never follows a link, and
  never reads another tab.
- **It talks only to your server.** The address is the one you configure, and there is no
  analytics, no telemetry and no third party anywhere in the path.
- **It never sees your password or your session.** It reads text your browser is already
  showing you.

The same reasoning is why Opportun asks you to [import your LinkedIn export](network.md)
rather than fetching your connections: the official export is a supported path, and scraping
is not.

## When something is wrong

- **The popup says it was added to your pipeline**: that is where a captured job goes now. It
  is not in the review queue. An extension built before this change says "review queue"
  instead; update it from Settings > Integrations > Extensions and Connectors.
- **"Open a supported page"**: the tab is not a profile or posting the server recognizes.
- **"Open a single Indeed job"**: the Indeed tab is a search or the home page with no job
  opened, a company page, or another page that is not one job. Open the job (or click it in the
  list), then capture.
- **"Indeed's layout was not recognized"**: the extension could not find the job's title,
  company or description on the page, so it sent nothing rather than guess. Reload the job and
  try again. If it keeps happening, Indeed has changed its page and the extension needs an
  update.
- **The token was rejected**: it was revoked, or mistyped. Create another under Settings >
  Integrations > Extensions and Connectors.
- **"Could not reach the server"**: the address is wrong, the server is down, or your device
  cannot reach it from where you are. If your server is on your home network, you have to be
  on that network.
- **The extension disappeared (Firefox)**: Firefox removes temporary add-ons when it
  restarts. Load it again from `about:debugging`.
- **Settings are empty after installing a new download (Chrome)**: the extension's storage
  belongs to its id, so a copy with a different id starts empty and reloading will not bring
  anything back. Run **Set up** again to get a new token. From this release on the id is
  pinned, so later upgrades keep the address and token; after re-downloading an upgrade,
  press the reload icon on its card in `chrome://extensions`.
- **Indeed is not captured after upgrading**: the release that added Indeed also asks for
  access to `www.indeed.com`. If the browser asks when you reload or first use the extension
  on Indeed, allow it. Firefox may grant site access only on request: open the Extensions
  menu (puzzle icon) and allow Opportun Capture on indeed.com.

<!-- nav:bottom -->

---

| [← Discovery](discovery.md) | [Guide home](README.md) | [Network →](network.md) |
| :-------------------------- | :---------------------: | ----------------------: |
