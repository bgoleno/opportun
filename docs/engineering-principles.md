# Engineering principles

`CONTRIBUTING.md` covers mechanics: how to merge, which gates to run, how to test against
Postgres. This file covers judgement.

Every rule here was paid for. Each one names the issue or pull request that produced it, because a
principle without its incident reads as a preference and gets argued with. These are not style
preferences and they are not exhaustive; they are the specific mistakes this project has already
made, written down so it stops making them.

---

## 1. Verifying a claim

### Never assert a universal negative from a truncated search

A pipeline ending in `head` can support "here are some matches". It can never support "there are
none". Count first, then page.

> **#279.** An issue was filed to build admin user management — listing accounts, resetting
> passwords — on the stated grounds that no such surface existed. It had shipped five days
> earlier. The search was `grep -rn 'isAdmin' apps/server/src | grep -v test | head -30`, and the
> matches in `routes/auth.ts`, the one file holding those routes, fell past the cutoff. An
> engineer checked before writing code and found the feature already built, better than specified.

### `grep` tells you the code; `git log -S` tells you the history

For "was this ever implemented", "when did this change", "is this comment still true", search the
history. The current tree cannot answer a question about the past.

> **#321.** `unsupported_store` returns nothing from a grep of `apps/`, which was reported as "an
> error code that was never implemented". `git log -S` showed it introduced by the original Google
> Docs store and removed by #302, the pull request that implemented `local_file`. The accurate
> version is more useful: the checklist item tests for a failure mode that #284 _eliminated_, so
> it can now only pass.

### Search for the operation, not the noun

> **#272.** "Does anything prune job rows" was answerable by grepping `purge` and `prune`, which
> finds `jobs/purge.ts` (content purging) and `pruneBackups` (snapshot files), neither of which
> touches the table in question. Grepping `delete(jobs)` found the single call site and settled it.

### Search both forms of a flag: where it is assigned and where it is read

A pattern matching `isAdmin:` finds object literals and cannot match `if (!ctx.isAdmin)`. The read
sites usually answer the question.

### A filename is not a description of what a file tests

> **#308, #322.** A failure reported as `FAIL searchParity.test.ts` was assumed to be a
> SQLite/Postgres divergence. It was a pure-CPU timing assertion on `pgSnippet` that happened to
> live in the same file, already documented as load-sensitive since #56. The misattribution
> misled the reporter, then misled the manager briefing the investigation, and settling it took 25
> full-suite runs. The file now holds one concern per file.

---

## 2. Intermittent failures

### Reproduce with output captured before changing anything, then classify

Run until it fails, each run's output to its own log. Then decide what _kind_ of failure it is
before deciding what to do about it.

> Three "it passed on rerun" dismissals in two days resolved as: **#294**, a real production race
> in `isMatchStale` affecting the live endpoint; **#287**, a GitHub runner DNS outage; and
> **#308**, a load-sensitive CPU-ratio assertion. In none of them did the number of subsequent
> green runs carry information, and in two of the three the eventual cause was not among the
> hypotheses anyone started with.

### The three signatures point at different causes

- **A timeout** (`Test timed out in 30000ms`) usually measures the machine, not the code.
  `apps/server/vitest.config.ts` documents this: a parallel run on a busy developer machine failed
  14 tests across 11 files, every one a timeout, none near a real hang. Both timeouts there are
  raised to 30 seconds for that reason (#36).
- **An assertion failure** is a behavioural claim and is the one that matters.
- **An ordering or data dependency between files** is the third, and the easiest to miss.

### Check whether the investigation manufactures its own result

Running a suite repeatedly to catch a load-sensitive failure adds load. Ask what your method does
to the thing you are measuring.

---

## 3. Tests

### A test must prove the absence of damage, not the presence of an error

> **#280's reset guard.** The acceptance criterion for a nightly job that deletes and re-seeds
> five accounts is that a real database survives it. Asserting only that `UnexpectedUsersError`
> was thrown would pass against a guard that threw _after_ deleting. The test registers a real
> user through the real path, captures the row, asserts the error, then asserts the row is
> byte-identical afterwards **and** that the total user count is unchanged. A guard that regressed
> into throwing late fails the third and fourth assertions regardless of the second.

### Red-green by hand

Revert the fix, watch the new test fail, restore it, watch it pass. A test written alongside a fix
proves nothing about whether it tests the fix (#324).

### Construct what production cannot

> **#286.** The keyset pagination bug needed ids whose order disagreed with their timestamps. The
> real write path can never produce that, because `uuidv7()` and `Date.now()` rise together. The
> test builds the state production cannot, which is the only way to exercise the invariant.
> Likewise **#320**: "never signed in" requires a user row with no session, which is exactly how
> `seedDemo` creates accounts and not how registration does.

### Test the boundary

A wrong `AND`/`OR` in a tuple comparison is invisible within one page and appears only at a page
split (#286).

### Beware the compliant-but-hollow fix

> **#324.** Told to call `needsReviewFor()` rather than hardcode `true`, the hollow version is to
> pick `outreachKind` and `confidence` values tuned to make it return `true`. The inputs should be
> what the fixture honestly is, and the output should follow. Here it does: the `true` comes from
> the helper's "job-related and unlinked" branch, which is structurally true of an unlinked
> recruiter solicitation regardless of the confidence number.

### Verify a configuration change by what stopped working

> **#305.** A pull request whose entire purpose was adding a lint guard silently removed two
> others. ESLint's flat config _replaces_ an array-valued rule rather than merging it, so a later
> block re-specifying `no-restricted-syntax` discarded the earlier array for every overlapping
> file. Its own verification confirmed the five new selectors fired. Nobody checked what had
> stopped firing. The only visible trace was a now-**unused** `eslint-disable` comment — treat an
> unused-directive report as a signal, not noise.

---

## 4. Destructive and irreversible operations

### Bound the operation by construction; do not merely guard it with a check

> **#280.** The nightly demo reset was first designed as "restore a golden snapshot, gated by a
> marker row proving this is the demo database". It became "delete five pinned, literal user ids,
> then re-seed". The difference: a marker is a check that can be wrong, and it _travels with a
> backup_, so restoring the demo dump anywhere carries the marker with it. A delete naming five
> ids cannot reach anything else, because on a real database those users do not exist. It finds
> nothing and does nothing.

### Configuration is not identity

An environment variable records what an operator intended, not which database is connected. Config
is copied between files, inherited by worktrees, exported in shells. A destructive job must prove
its target from inside the target.

### Check at the dangerous moment, not at startup

A boot-time check can be satisfied once and the target swapped afterwards, and it cannot stop a
flag being set against an existing real database.

### Prefer "nothing was attempted" to "it rolled back"

> **#280.** `requireOnlyPinnedUsers` runs _before_ the transaction opens and is a read-only
> `SELECT` with a `LIMIT 1`. So the guarantee is not that a partial write was undone; it is that
> no write was ever attempted. That does not depend on transaction semantics being correct.

### Order operations so failure leaves the safe state

Write new content before repointing a reference; back up before pruning. **State the ordering as
an invariant in a comment.**

> **#272.** Job-row pruning runs at 04:00, after the 03:00 backup, so every pruned row exists in
> at least one snapshot before deletion. Without that sentence in the code, someone "spreading out
> the maintenance jobs" would silently start deleting rows that were never backed up.

### A namespace shared between development and production is a loaded gun

> **#203 / #208.** `deploy/compose.yml` pinned `name: opportun`. A compose project name is a
> namespace on the Docker host, not a property of a directory, so a worktree running the
> repository's own documented smoke test adopted and destroyed the live stack with
> `docker compose down -v`. Recovery came from a verified backup taken eighteen minutes earlier.
> The fallback name in that file is now deliberately one no real deployment would use, and names
> itself after the remedy so it appears in `docker ps` at the moment someone is confused.

---

## 5. Reporting

### Report what you observed, not what you inferred

"Signing in as demo-user-2 returned 401" is actionable. "The credential wiring is broken" is a
conclusion that may be wrong and hides the observation behind it.

### Distinguish "not checked yet" from "could not be checked" from "failed"

They look similar in a summary and mean entirely different things to the person reading it.

### Two green ticks can mean opposite things

> **#321.** A checklist item passed because the error it tested for had been _eliminated_ by a
> fix; an adjacent one passed because _nothing exercised the path at all_. Both showed green.
> Say which.

### A partial report, labelled partial, beats silence

Silence is indistinguishable from "still working" and from "stuck".

### Say what you did not verify

> The demo acceptance run exercised `deploy/compose.demo.yml` for its environment passthrough and
> its key gate, in both the positive and negative case, and **not** for its pull-only behaviour,
> because no image had ever been pushed to the registry. A report reading as "the compose
> configuration passed" would have implied otherwise.

---

## 6. Data and modelling

### A derived value cannot answer a historical question when its source rows are deleted

> **#320.** `lastSeenAt` was computed as `max(sessions.last_seen_at)`, and sign-out hard-deletes
> the session row. So it recorded "has a session right now", not "has ever visited" — and reported
> "Never" for exactly the one-time visitor the column existed to detect. Before deriving a value,
> ask what deletes the rows underneath it and whether that deletion is meaningful to the question.
>
> Its fix carried the same shape one level down: piggybacking on the existing throttled session
> touch costs nothing, but the throttle cannot fire during the first interval of a session, so a
> visitor who left within a minute still recorded nothing. The write also has to happen at session
> creation. **A mechanism that keeps a value fresh does not necessarily record that it exists.**

### Data present but unreachable is worse than data absent

> **#324.** Two seeded categories were invisible to a visitor while being correct in the database.
> A message was seeded without the derived `needsReview` flag the production path computes, so it
> matched no inbox tab. Companies were seeded without the `status` the follow action sets, so the
> only component rendering their ATS metadata never saw them. Both looked complete from the
> seeder's side and empty from the visitor's, and no test failed, because the rows were exactly as
> the seeder intended.

### Prefer calling the production helper to setting the derived field literally

The literal is correct once. The helper stays correct when the definition changes.

### Per-user isolation is not multi-tenancy

> Row-level isolation through a scoping context is the _mechanism_; multi-tenancy is an
> organisational model with groups and per-group administration. Diagnose by looking for a team or
> workspace entity and a per-group admin flag, not for `userId` columns. This codebase is
> multi-user with enforced per-user isolation (FR-S5) and has no tenant model.

---

## 7. Secrets

### Never put a credential in a message, a transcript, a report, or a commit

Say that it worked and where it came from. To show two values differ, say they differ.

### Placing a live credential into a running application is the owner's step

This is about activating a billable production credential, not about who sees the bytes. Ask them
to run it. Test values for a local development instance are a different matter; a real provider
key is not.

### Prefer a reference to a value, and a file to an environment variable

A secret-manager reference (`op://…`) is not sensitive and can be shared freely; resolve it
straight to a file, never to stdout. Environment variables are readable by anything that can
inspect the process, which is why this repository has `OPPORTUN_MASTER_KEY_FILE`,
`DATABASE_URL_FILE` and `OPPORTUN_DEMO_AI_KEY_FILE` (#314).

### Nothing credential-shaped goes in the tree

This repository publishes as a fresh snapshot (`docs/pre-publication-checklist.md`). A committed
demo password would be published alongside a live instance that accepts it.

---

## 8. Change and CI

### A branch green on its own is not green with the others

> **#313.** Without strict branch protection, each branch is tested against the base it was cut
> from, never against what merges alongside. #300 added a test fixture hardcoding `DATA_DIR:
'/data'`, harmless because nothing touched that directory. #307 then made `seedDemo` construct
> storage from `cfg.dataDir`. Each was green. Together they produced `EACCES: permission denied,
mkdir '/data'` and a red default branch. **A semantic conflict needs no textual overlap**, so no
> merge tool would have flagged it.

### Whoever asks for a force-push owes a check for dependents

Rebasing a branch someone has stacked on makes their next rebase replay old commits against
rewritten ones and conflict in files neither party touched. The fix on their side is to reset to
the new tip and reapply only their own diff, rather than rebasing through the rewritten history.

### Run every gate, not the subset you remember

> **#318.** Lint, typecheck, format and tests are independent and none implies another. Two
> engineers each ran four commands carefully and lost an hour each; they were not the same four.
> `pnpm verify` now runs all of them, fastest first.

### Close issues from the pull request

`Closes #N` in the body keeps the board honest. Six issues in one day stayed open after their fix
merged, and the cost is the window where finished work looks outstanding — during which work was
nearly assigned twice for things already shipped (#326).

---

## 9. Writing it down

### Put the reason in the code, not only in the pull request

A comment explaining why a `build: !reset null`, an `ignores` entry, or an unusual ordering exists
is what stops the next person tidying it away. Pull request discussion is not where anyone looks
while editing.

### An exemption that outlives its reason is how a guard stops guarding

Point it at an issue, and remove it when that issue closes.

### Write acceptance criteria against behaviour, not layout

> A redesign (#317) landed in the middle of the demo acceptance run and invalidated nothing,
> because `docs/demo-acceptance.md` asks whether the assistant's reply names the specific score
> rather than where the panel sits. A checklist describing where to click would have had to be
> rewritten mid-run.

### A principle without its incident reads as preference

Keep the cost attached. That is why every rule above names one.
