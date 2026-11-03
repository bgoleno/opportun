# Opportun Capture (browser extension)

A Manifest V3 browser extension for Chrome (and Chromium browsers) and Firefox. When you are
looking at a LinkedIn profile or job posting, or an Indeed job, and click **Capture this page**,
it sends that tab's text to **your own** Opportun server, which turns a profile into a contact
and a job into an opportunity (FR-C5).

## Compliance (C-1): why it works this way

LinkedIn's User Agreement prohibits automated retrieval of its pages, so Opportun never
fetches linkedin.com, and this extension is built so that it cannot be used as a scraper:

- **Explicit click only.** Nothing runs until you open the popup and click Capture. There is no
  background worker, no content script and no timer; the manifest declares none (a unit test
  enforces it). The page is read by one injection (`activeTab` + `scripting`) into the tab you
  clicked on, at the moment you clicked. The manifest grants host access to linkedin.com and
  indeed.com, but only that click path ever uses it.
- **Pages you personally visit only.** It reads the tab you are already looking at, as
  rendered for you. It never opens, navigates, scrolls, clicks or reloads pages, never follows
  links, and never reads other tabs. Tabs that are not on linkedin.com or indeed.com are not
  read at all; which reader runs is decided from the tab's address alone.
- **Your own server only.** The text goes to the Opportun server address you configure, with a
  device token you create there. There is no other destination: no analytics, no telemetry,
  no third-party service, no remote code (everything the extension runs is bundled; the
  default extension Content Security Policy is unchanged).
- **No credentials.** The extension never sees or uses your LinkedIn or Indeed password or
  session; it reads text the browser already shows you.

Indeed is captured the same way (C-2): the Opportun server never fetches indeed.com pages, so a
job you are looking at reaches it only through this click, or as text you paste
([#74](https://github.com/bgoleno/opportun/issues/74)).

## What is sent

`POST <server>/api/v1/connector/capture` with `Authorization: Bearer <device token>` and a JSON
body `{ url, title, text }`:

- `url`: the tab's address. The jobs search split view
  (`/jobs/search/?currentJobId=<id>`, and the `/jobs/search-results/...` and
  `/jobs/collections/...` lists) is rewritten to
  the posting's canonical `https://www.linkedin.com/jobs/view/<id>/` before sending, because the
  server only accepts single profile and job pages. The text is still the visible tab's text,
  that is the list plus the detail pane you are looking at.
- `title`: the tab's title (up to 500 characters).
- `text`: the visible text of the page's `<main>` region (the whole page when there is none),
  whitespace-normalized and cut to 200,000 characters. Navigation bars, scripts and hidden
  elements are not included.

The server decides what the page is. Feeds, search results, company pages, the sign-in wall
and half-loaded pages are refused (`422 unrecognized_page`) and the popup tells you why.

### Indeed

Indeed jobs are read on `www.indeed.com` (and `indeed.com`) only, on a single job page
(`/viewjob?jk=<jk>`) or in the search split view with a job open in the pane
(`/jobs?...&vjk=<jk>`). Indeed's country sites are not read. The body differs from LinkedIn's,
following the Indeed capture text contract
(https://github.com/bgoleno/opportun/issues/73#issuecomment-6568000179):

- `url`: always `https://www.indeed.com/viewjob?jk=<jk>`, for both layouts. A tab with no valid
  job key (search results with no job open, a company page) is not read, and nothing is sent.
- `title`: the job's title, read from the job itself. The tab title is never sent: in the split
  view it names your search.
- `text`: composed from named parts of the job, one per line: the title, the company, the
  company's metadata lines (rating, location, work setting), the "Job details" block if there
  is one, the line `Full job description`, then the description. Nothing else is sent: not the
  site's navigation or account menu, the search form, the buttons, the results list or the
  recommended jobs under the description.

If the job's parts cannot be found (Indeed changed its page), the popup says Indeed's layout was
not recognized and sends nothing. It never falls back to the whole page.

## Assisted apply: filling a Greenhouse application

With assisted apply on, and a token set up with **Also let it fill in applications you hand
off** (the `apply:assist` scope), the popup offers **Fill in this application** over a
Greenhouse posting (`job-boards.greenhouse.io/<board>/jobs/<id>`, or the same on
`boards.greenhouse.io`). It fills only what you reviewed in Opportun, and you press the site's
own Submit button ([#183](https://github.com/bgoleno/opportun/issues/183)).

On the click, and only then:

1. **The popup asks your server for the application.**
   - It calls `GET <server>/api/v1/connector/apply/current?url=<the tab's address>`, which
     returns the one application you handed off to this posting.
   - It checks that the tab is that application's pinned posting: the same board and the same
     job id. Any other tab is not filled, and the popup says why.
2. **It fetches the resume copy,** with `GET <server>/api/v1/connector/apply/<id>/snapshot`,
   only when the copy is ready. The file must be a PDF of the announced size.
3. **It runs the filler once, in that tab's top frame.** The filler's only argument is the
   plan: the reviewed values and the PDF as base64.
4. **The filler checks the page's address again** before it changes anything.
5. **It fills each empty field it has a value for:**
   - first and last name, email and phone, by the form's own field ids;
   - your LinkedIn and website, by a question labelled exactly "LinkedIn Profile" (or
     "LinkedIn") or "Website";
   - each answer you reviewed, by a question whose label is exactly the same, ignoring case,
     spacing and a trailing `*`.

   Each value is written once with the browser's own value setter, followed by a plain `input`
   and `change` event. A field that already has something in it is left as it was, and so is
   a field the form does not show: one that is hidden, or inside a hidden part of the form.

   A detail you saved before Opportun's current checks, which no longer passes them, is left
   out of the fill. The server withholds it, and the popup lists it under "Not filled in" with
   the reason: correct it in Opportun, or fill it in yourself
   ([#196](https://github.com/bgoleno/opportun/issues/196)).

6. **It attaches the resume** to the form's file input through `DataTransfer`. The page side
   keeps no timer, so the popup then looks, read-only and for about 1.5 seconds, for the form
   to show the file's name where you can see it: a copy inside hidden content does not count.
   If it never does, the popup takes the file back out (only if it is still exactly the one it
   set) and says to attach it yourself.

   **Keep the popup open until it says it is done.** Chrome closes a popup when you click
   elsewhere, and the check ends with it. If that happens, the next time you open the popup on
   that tab it tells you the resume was not confirmed, so look at the form yourself. That note
   is kept in the extension's session storage only while the check runs; nothing else runs in
   the page, and there is no background worker.

7. **The popup lists** what was filled in and what was not, with the reason.

It never chooses an option in a dropdown, checkbox or radio button, and never sets a hidden
field other than the resume input. It also never does any of the following:

- presses a button or submits the form;
- sends a key, mouse, pointer or focus event;
- reaches into another frame or the captcha;
- makes a network request from the page.

A test scans the filler's own source to enforce this. It needs no new permission, and still
adds no content script and no background worker: `activeTab` covers the tab you clicked in.

## Assisted apply: recording the confirmation page

With the same token, the popup offers **Record confirmation page** over any https page
([#121](https://github.com/bgoleno/opportun/issues/121)). Use it on the thank-you page an
application site shows after you submit, once you have told Opportun you submitted it (**I
submitted it**). The extension never records that for you.

On the click, and only then:

1. **The popup asks your server which application this page may confirm.**
   - It calls `GET <server>/api/v1/connector/apply/confirmable?url=<the tab's address>`.
   - The server answers with one application's id, title and company, and nothing else. Or it
     gives only a reason code for why there is none: you have not said you submitted it yet,
     its page is already recorded, more than one application matches, or none is on this site.
   - A token gets 10 of these questions per 15 minutes: the question names which employers'
     boards match, so a token that leaked cannot sweep for them.
2. **It reads the page once, in that tab's top frame:** its title and visible text. A tab that
   moved to another address since the question is not recorded.
3. **It sends the page** with `POST <server>/api/v1/connector/apply/<id>/confirmation`: the
   tab's own address as the browser reports it, the title, and at most 20,000 characters of
   text.

The server checks everything again before storing anything:

- the application is one you said you submitted;
- the page is on that application's own site and board;
- the page does not name another job.

It stores the text on the opportunity's timeline as a **Confirmation page** entry, without the
address's query. The entry is never sent to an AI provider, and you can delete it.

## Installing it normally

Nobody has to read this file to use the extension. A running Opportun hands it over:
**Settings > Integrations > Extensions and Connectors > Browser extension > Set up** creates
the token, offers the download for the browser in use, and walks through the install. That
download also carries the server's own address, so the only thing a user pastes is the token.

What follows is the contributor path: building from a checkout, which is what you want when
you are changing the extension itself.

## Building

From the repository root:

```sh
npx -y pnpm@9 install
npx -y pnpm@9 --filter @opportun/extension build
```

This writes two unpacked extensions: `packages/extension/dist/chrome/` and
`packages/extension/dist/firefox/`. They contain the same code; only `manifest.json` differs
(Firefox gets an add-on id and minimum version). The bundle is not minified, so you can read
exactly what runs.

## Installing (load unpacked)

First, in Opportun go to **Settings > Integrations > Extensions and Connectors**, create a device token with the
**Browser capture** permission, and copy it (it is shown once).

### Chrome, Edge, Brave

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and pick `packages/extension/dist/chrome`.
3. Pin **Opportun Capture** to the toolbar.

The extension stays installed across browser restarts; after rebuilding, click the reload
icon on its card.

### Firefox (128 or later)

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on...** and pick `packages/extension/dist/firefox/manifest.json`.
3. Firefox may grant the linkedin.com and indeed.com access only on request: open the
   Extensions menu (puzzle icon), and allow Opportun Capture on those sites if asked.

Temporary add-ons are removed when Firefox restarts. For a permanent install, the add-on has
to be signed by Mozilla (for example as an unlisted add-on via `web-ext sign`).

The Firefox manifest declares, in `data_collection_permissions`, the data that leaves your
device: website content (the captured page text) and authentication information (the device
token), both sent only to your own server. That declaration matters only for Mozilla's add-on
signing (AMO) and the install prompt of Firefox 140 and later; earlier versions ignore it.

### Configure

1. Click the toolbar icon, open **Settings**, enter your server address (for example
   `https://opportun.example.com`; plain `http` is accepted only for `localhost` and
   `127.0.0.1`) and paste the token.
2. Click **Save**. The browser asks you to allow access to that one server address; allow it
   (without it the extension cannot reach your server).
3. Click **Test connection**. "Connected" means the server is reachable and accepted the
   token. The test sends a page the server always refuses, so it creates nothing, but it
   counts toward the capture limit (30 captures per 15 minutes per token).

The settings live in this browser profile's extension storage (not synced). The token is never
shown again in the popup, logged, or sent anywhere but your server. To revoke it, delete it
under Settings > Integrations > Extensions and Connectors; the extension then reports that the token was
rejected.

## Manual QA checklist

Use a test account or your own profile; check each item in Chrome and Firefox.

- [ ] Fresh install: the popup opens with Settings expanded; Capture says to save settings
      first and sends nothing.
- [ ] Save with `http://example.com` (or `http://[::1]:8080`) shows the https message;
      nothing is stored.
- [ ] Save with a valid https server: the browser asks for that host only; declining shows
      the permission message and nothing is stored; accepting shows "Settings saved." and the
      token field is empty with a "Saved" placeholder.
- [ ] Firefox: save `http://localhost:8080` (a ported localhost). The prompt asks for
      `localhost` access, accepting saves, and Test connection reaches the server.
- [ ] Reopen the popup: the address is filled in, the token is not. Save again with the token
      blank: the saved token is kept. Change the address to another server with the token
      blank: "Server changed: re-enter the token" and no permission prompt.
- [ ] Test connection with a valid token: "Connected". With a revoked token: the token
      rejected message. With a mail-only token: the missing permission message. With the
      server stopped: "Could not reach the server".
- [ ] On a profile (`linkedin.com/in/<someone>/`) after it has loaded: "Contact added"; capture
      again: "Contact updated"; the contact appears in Opportun.
- [ ] On a job page (`linkedin.com/jobs/view/<id>/`): "Added to your pipeline as Interested.";
      the opportunity appears in Opportun at Interested, not in the review queue.
- [ ] On the jobs search view with a job selected (`/jobs/search/?currentJobId=<id>`): the job
      is captured (the same opportunity as its `/jobs/view/<id>/` page).
- [ ] On the feed, a search results page and a company page: "Not captured" with the reason;
      nothing is created in Opportun.
- [ ] On an Indeed job page (`indeed.com/viewjob?jk=<jk>`): "Added to your pipeline"; the
      opportunity's posting link is `https://www.indeed.com/viewjob?jk=<jk>`.
- [ ] On an Indeed search with a job open on the right (`/jobs?...&vjk=<jk>`): the same job and
      the same result as its `/viewjob` page; nothing from the results list in the description.
- [ ] On an Indeed search with no job open, and on a company page: "Open a single Indeed job";
      no request.
- [ ] On a tab that is neither LinkedIn nor Indeed (and on `chrome://` or `about:` pages): "Open
      a LinkedIn profile or job page, or an Indeed job"; the browser's network panel for the
      popup shows no request.
- [ ] Signed out of LinkedIn on a profile URL: the sign-in message.
- [ ] 31 captures within 15 minutes: the capture limit message with a wait time.
- [ ] Inspect the popup (right-click > Inspect): the console shows no token, and the only
      request is the POST to your server.
- [ ] With the popup closed, browsing LinkedIn produces no requests to your server and no
      extension activity.

## Development

```sh
npx -y pnpm@9 --filter @opportun/extension test       # vitest (happy-dom fixtures)
npx -y pnpm@9 --filter @opportun/extension typecheck
npx -y pnpm@9 --filter @opportun/extension lint
```

The logic lives in small, separately tested modules under `src/`: `extract.ts` (the functions
injected into the tab, `extractPage` for LinkedIn and `extractIndeedJob` for Indeed; each must
stay self-contained), `canonical.ts` and
`normalize.ts` (URL rewrite and text normalization), `settings.ts`, `api.ts` (the request and
response classification), `render.ts` (popup messages), `popupController.ts` (the popup with
injected browser APIs) and `manifest.ts`. `popup.ts` only wires in the real `chrome.*` APIs.
Test fixtures are synthetic pages mirroring the server's capture fixtures (no real people,
companies or job keys), and the extraction tests run the server's own recognizer on what the
extension would send.
