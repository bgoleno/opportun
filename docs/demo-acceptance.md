# Demo acceptance checklist

What "this demo is ready to show an employer" means, as checks specific enough to get a yes or
no — not "the data looks reasonable" (issue #297).

#280 (the seeded dataset and nightly reset), #284 (the `local_file` document store), and #290
(the deployment) each satisfy part of what was asked for, and each is reviewed and merged on its
own terms. Nothing else checks the assembled whole against the actual ask, which is how four
individually-correct pieces produce a demo that is missing something. This is that check.

**Run this only once every piece below is on `main`.** As of this revision: #290 (#293) and
#284 (#302) are merged; #280 landed in two PRs (#291 the seeder, #307 the resume/tailored-
variant/match-report fixtures #291 deferred); #280's nightly reset job is #300; #303/#306 feeds
the match report into the tailoring chat's own context, a capability §5 below checks for
directly. Confirm all of these are actually on `main` before starting, not just merged into
their own branches. Run every box below in order against the actual deployed demo host, not a
local dev server — several of them (the real spend limit, the actual shared passwords, a real
reset) are specifically about things that only exist on that host.

**Checked boxes below were verified 2026-10-23, from-source (not Docker), on SQLite** (the
decided engine for this demo; see #280). Full evidence for each is in #280's comment thread, not
repeated here. The items still unchecked are the ones that genuinely need the real deployed host,
the provider's own console, or the registry path a from-source run can't exercise — see each
one's own note.

## Where this checklist differs from what #280's own text says

Both of these are the design as it stands today, confirmed against the issue's own comment
thread, not an interpretation of this checklist's author. Recorded here because the issue's
body text itself still says the opposite of each, which is exactly the kind of thing worth
catching before it causes an implementer to read the wrong section:

- **AI: a real model, not mock.** #280's own body recommends `mockAi` behind the demo flag "with
  the production guard extended narrowly." A later comment on the same issue overrides this
  explicitly: "Decision on section 4: real model, low budget cap. Not mockAi... Canned mock
  output would undercut the point of showing it at all." PR #291 implements the override (a
  real Anthropic key, installed per account, with an explicit low `ai_budget`), not the body's
  original recommendation. §5 below tests for the real model.
- **Reset: scoped delete and re-seed, not a snapshot restore.** The body proposes the nightly
  reset as "a scheduled wrapper around `cli/restore.ts`." A later comment found this cannot work
  (`restore.ts` refuses while any other connection holds the database, so an in-process job can
  never run it against itself) and replaced it with deleting the five pinned demo users and
  re-seeding. §7 below tests the _outcome_ ("does it look the same as before"), which should
  hold regardless of which mechanism produced it, but is written against the mechanism that was
  actually built.

## 0. Before anything else

- [ ] A hard spend limit is set on the Anthropic key in the provider's console
      (`docs/demo-deployment.md`). Do this **before** §5 below, which deliberately spends real
      money against it. The in-app per-user `ai_budget` does not bound this on its own: the
      nightly reset wipes the ledger it is checked against.
- [ ] `OPPORTUN_DEMO_IMAGE_TAG` in the host's `.env` names the build actually being tested, and
      you know what the previous tag was (for rollback) before you start finding problems.
- [ ] The publish-and-pull path itself has actually been exercised on this host, not just
      documented: `docker login ghcr.io` succeeds against the private package with whatever
      token is configured, the pull for the tag in `.env` actually resolves to an image (not a
      stale local one, not a 404), and the container that comes up is the build you intended.
      Nobody has run this path for real yet (not the from-source runs, not the Docker run this
      checklist's own history describes) — the owner's first deploy is the first real test of
      it, so treat it as one.
- [ ] The running instance is actually on the engine this deployment decided on (#280 settled
      SQLite), checked by behavior rather than by reading which config key is set, so this
      survives a dialect decision changing later without the check itself going stale:

      ```sh
      docker compose -f deploy/compose.yml -f deploy/compose.demo.yml ps
      docker compose -f deploy/compose.yml -f deploy/compose.demo.yml \
        exec opportun sqlite3 /sqlite/opportun.db 'PRAGMA integrity_check;'
      ```

      The first lists only `opportun` and `caddy` — no `db` service, confirming the `postgres`
      compose profile never activated. The second prints `ok`, confirming the data the app is
      actually serving lives in SQLite, not merely that Postgres is absent.

## 1. An employer opens the link, signed out

- [ ] The URL loads over HTTPS with no certificate warning.
- [x] The page is a sign-in screen with **no visible way to register a new account.**
      Registration closes after the first account on every deployment; a stranger landing here
      must not be able to create their own.
- [ ] `GET /healthz`'s **body** (not just its HTTP status) reports `"status":"ok"`. The status
      code stays 200 even when the body flags a problem (`docs/install.md`), so a status-only
      check here would pass on a broken instance.

## 2. All five accounts work with the credentials actually shared

The thing most likely to be wrong at assembly time, named explicitly for that reason. Not "the
seeder ran without error" — log in as each one, with the literal password from whatever you are
about to hand an invitee, and confirm it works:

- [x] Admin account signs in with its shared password.
- [x] User 1 through User 4 each sign in with their own shared password.
- [x] Exactly one of the five (the admin) sees admin-only UI (Settings → Users); the other four
      do not.
- [x] A wrong password on any of the five is rejected normally (confirms these are real
      credentials the app checks, not a bypass).

## 3. The admin surface

- [x] Settings → Users lists exactly five accounts.
- [x] Each non-admin row's last-session timestamp is populated after that user's sign-in above
      (not blank, not an error) — this is how the owner will tell whether someone he invited
      actually opened the link.
- [x] From Settings → Users, reset a non-admin account's password. Confirm the dialog, get the
      one-time password shown, and confirm that **new** password actually signs that user in.
      (This is the admin-UI path, not the `resetPassword.ts` CLI fallback #280's body describes:
      that fallback predates #279, which has since shipped and is what an admin will actually
      use.)

## 4. The pipeline board

- [x] Opportunities exist in all eight stages: discovered, interested, preparing, applied,
      in_process, offer, dismissed, closed.
- [x] One pair is flagged as a possible duplicate, and the duplicate-review UI shows it as such.
- [x] One dismissed opportunity shows a dismissal reason (not blank).
- [x] One closed opportunity's reason is specifically "accepted" (not just "closed").
- [x] One opportunity has an unconfirmed posting, and the posting-confirmation affordance
      appears for it.
- [x] At least one opportunity's job description reads as a real, multi-paragraph posting in
      the semi-formatted markdown shape — not placeholder or lorem-ipsum text.
- [x] At least one company shows a specific ATS surface (not every company showing "none";
      that would mean the ATS-kind variety the seed is supposed to carry didn't land).

## 5. Resumes and tailoring — the capability the whole demo exists to show

The second thing named explicitly as most likely to be wrong, because it is the one that
depends on #280, #284 and #290 all being correct at once: #284's store, #280's seeded resume
rows and budget, and #290's provider key and spend limit, all in the same request.

- [x] A base resume opens with no `unsupported_store` error (confirms #284 actually backs it,
      not a route still hitting the Google-only path).
- [x] That resume has no broken "open externally" link. `local_file`'s `copyFrom` returns a null
      `url` by design (#284); the UI must read as "no external link," not as a dead one.
- [x] At least one opportunity shows a pre-existing tailored resume variant that looks already
      complete — this is pre-seeded history, not something that should trigger a new AI call
      just to display.
- [x] Starting a **new** tailoring session against a _different_ opportunity calls the real
      model: the response is not the canned mock output, arrives in a realistic amount of time
      for a live model call (not instant), and is specific to that opportunity's actual
      description.
- [x] At least one suggested edit from that session is applied to the resume, and the edit
      actually lands in the document text (exercises #284's `applyEdits`, not just `readText`).
- [x] That session's cost appears in the account's AI usage (`task_runs`), confirming it drew
      against the per-user budget rather than failing with `no_key` or silently not being
      metered.
- [x] On an opportunity with a scored match report, ask the assistant directly what the match
      score and missing keywords are. The reply must name the specific score and specific
      keywords from that report (#303/#306), not a generic answer — confirms `match_report` is
      actually reaching the model's context, not just that the session runs at all.

## 6. Mock communications

- [x] The inbox/communications view shows an inbound recruiter message, a rejection, and a
      scheduling thread, each with a populated snippet, for the account you are checking.

## 7. The nightly reset returns to the same state, not an approximately similar one

Do this against an account you changed something on earlier in this checklist (the password
reset in §3, at minimum).

- [x] After a reset, the opportunity and resume ids you noted earlier still resolve — a
      bookmarked URL the owner shows someone must not 404 the next day.
- [x] A change made during the day (the password reset in §3, or a note/stage change you make
      for this check) is gone after the reset — confirms this is a real reset, not a no-op.
- [x] Immediately after the reset, all five accounts' **original** shared passwords work again.
      A password you changed via §3's reset does not carry over: the account comes back with
      the same password it started the day with, not the one you set partway through this
      checklist.
- [x] Immediately after the reset, tailoring still works end to end (§5's checks again, briefly):
      confirms the AI provider key was reinstalled, not silently dropped by the account
      delete-and-recreate.
- [x] Dates are fresh relative to today rather than frozen at whenever the instance was first
      seeded. The UI renders absolute dates ("Oct 16, 12:13 PM"), not relative phrasing, so
      check the spacing rather than the wording: a fixture applied "9 days ago" should sit nine
      days before today, and after a reset the same opportunity should have moved forward with
      it rather than staying pinned to the original seed date.

## 8. Operational visibility, not employer-visible but worth confirming before go-live

- [x] Settings → Jobs shows the nightly reset schedule registered. Its _absence_ here should be
      visible by looking, not something only noticed when the data unexpectedly stops resetting
      (the #270 lesson this requirement exists to avoid repeating).

## What this checklist does not cover

Whether the demo is reachable at all — DNS, a certificate, the host existing — is #232's
decision and infrastructure, deliberately excluded from #290 and from this checklist. §1 assumes
that part already works. Whether the reset mechanism itself is _safe_ against a real database
(the pinned-id and marker guards) is #280's own PR-level test coverage, not something a
walkthrough of a working demo can usefully re-verify; this checklist tests the outcome a correct
implementation produces, not the guards that make a wrong one impossible.
