# Opportun Capture (browser extension)

A Manifest V3 browser extension for Chrome (and Chromium browsers) and Firefox. When you are
looking at a LinkedIn profile or job posting and click **Capture this page**, it sends that
tab's visible text to **your own** Opportun server, which turns a profile into a contact and a
job into a lead in your review queue (FR-C5).

## Compliance (C-1): why it works this way

LinkedIn's User Agreement prohibits automated retrieval of its pages, so Opportun never
fetches linkedin.com, and this extension is built so that it cannot be used as a scraper:

- **Explicit click only.** Nothing runs until you open the popup and click Capture. There is no
  background worker, no content script and no timer; the manifest declares none (a unit test
  enforces it). The page is read by one injection (`activeTab` + `scripting`) into the tab you
  clicked on, at the moment you clicked. The manifest grants host access to linkedin.com, but
  only that click path ever uses it.
- **Pages you personally visit only.** It reads the tab you are already looking at, as
  rendered for you. It never opens, navigates, scrolls, clicks or reloads pages, never follows
  links, and never reads other tabs. Tabs that are not on linkedin.com are not read at all.
- **Your own server only.** The text goes to the Opportun server address you configure, with a
  device token you create there. There is no other destination: no analytics, no telemetry,
  no third-party service, no remote code (everything the extension runs is bundled; the
  default extension Content Security Policy is unchanged).
- **No credentials.** The extension never sees or uses your LinkedIn password or session; it
  reads text the browser already shows you.

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
3. Firefox may grant the linkedin.com access only on request: open the Extensions menu (puzzle
   icon), and allow Opportun Capture on linkedin.com if asked.

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
- [ ] On a job page (`linkedin.com/jobs/view/<id>/`): "Job added to your review queue";
      again: "already in your review queue".
- [ ] On the jobs search view with a job selected (`/jobs/search/?currentJobId=<id>`): the job
      is captured (same lead as its `/jobs/view/<id>/` page).
- [ ] On the feed, a search results page and a company page: "Not captured" with the reason;
      nothing is created in Opportun.
- [ ] On a non-LinkedIn tab (and on `chrome://` or `about:` pages): "Open a LinkedIn profile or
      job page"; the browser's network panel for the popup shows no request.
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

The logic lives in small, separately tested modules under `src/`: `extract.ts` (the one
function injected into the tab; it must stay self-contained), `canonical.ts` and
`normalize.ts` (URL rewrite and text normalization), `settings.ts`, `api.ts` (the request and
response classification), `render.ts` (popup messages), `popupController.ts` (the popup with
injected browser APIs) and `manifest.ts`. `popup.ts` only wires in the real `chrome.*` APIs.
Test fixtures are synthetic pages mirroring the server's capture fixtures (no real people),
and the extraction tests run the server's own recognizer on what the extension would send.
