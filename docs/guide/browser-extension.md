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

Open a LinkedIn profile or job posting, click the Opportun icon, and press **Capture this
page**.

- A **profile** (`linkedin.com/in/...`) becomes a contact, with company and position. Capturing
  the same person again updates them.
- A **job posting** (`linkedin.com/jobs/view/...`, or the jobs search view with a posting
  selected) becomes an **opportunity at Interested**.

Capturing a job is treated as a decision, not as filing something to look at later: you are
reading the posting and you want it. So a captured job never lands in the review queue. If the
job was already sitting there as a lead from a job alert email, that lead is filled in and
accepted rather than duplicated, and if you already track the job, the capture fills in
whatever the opportunity was missing. An opportunity you had dismissed comes back to
Interested, because capturing it means you changed your mind. One you have already applied to,
or are interviewing for, keeps its stage and only gains the details.

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
says why. Pages on other sites are not read at all.

There is a limit of 30 captures every 15 minutes per token, which is far above normal use and
exists so a mistake cannot turn into a flood.

## Why it works this way

LinkedIn's User Agreement prohibits automated retrieval of its pages, and Opportun takes that
seriously rather than working around it. The extension is built so it **cannot** be used as a
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

<!-- nav:bottom -->

---

| [← Discovery](discovery.md) | [Guide home](README.md) | [Network →](network.md) |
| :-------------------------- | :---------------------: | ----------------------: |
