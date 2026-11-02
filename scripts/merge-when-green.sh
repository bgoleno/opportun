#!/usr/bin/env bash
#
# Merge a pull request, but only once every check has passed.
#
# `main`'s branch protection is the real gate: every check its ruleset requires (listed in
# CONTRIBUTING.md, Merging) must pass and administrators are included, so a premature merge is
# refused by GitHub rather than by this script. What this adds is the waiting and the
# reporting in one place, and the pin to the reviewed head commit described below. GitHub's
# auto-merge is turned off in the repository settings.
#
# It was written when protection was unavailable on a private repository's plan, after #43
# merged with sixteen checks still queued. That gap is closed; the convenience is not.
#
# Usage: scripts/merge-when-green.sh <pr-number> <head-sha>
#
# <head-sha> is the full 40-character commit the pull request was reviewed and verified at.
# The script merges exactly that commit or nothing (issue #82): a commit pushed after the
# review must not ride into `main` on the strength of a review of its parent. So it refuses
# when the pull request's head is not <head-sha>, both before waiting for the checks (a stale
# head fails at once, not after the wait) and again just before merging, and the merge itself
# is pinned with --match-head-commit, so a push in the moment between that last look and the
# merge is refused by GitHub rather than merged.
#
# Exits non-zero without merging if any check fails, or if the pull request reports no
# checks at all, which is itself a reason not to merge.
set -euo pipefail

usage() {
  echo "usage: scripts/merge-when-green.sh <pr-number> <head-sha>" >&2
  echo "  <head-sha>: the full 40-character SHA of the head commit that was reviewed" >&2
  exit 64
}

# Both arguments go into gh commands, so each must be exactly what it claims to be: a PR
# number (not, say, a flag like --admin) and a full SHA (an abbreviated one cannot be compared
# with the head GitHub reports, and --match-head-commit needs the full SHA).
if [[ $# -ne 2 ]]; then
  usage
fi
pr="$1"
head="$2"
if [[ ! "$pr" =~ ^[1-9][0-9]*$ || ! "$head" =~ ^[0-9a-fA-F]{40}$ ]]; then
  usage
fi
head="$(printf '%s' "$head" | tr 'A-F' 'a-f')"

# Refuses, without merging, when the pull request's head is not the reviewed commit.
require_reviewed_head() {
  local found
  found="$(gh pr view "$pr" --json headRefOid -q .headRefOid)"
  if [[ "$found" != "$head" ]]; then
    echo "Not merging #${pr}: its head is ${found}, not the reviewed ${head}. Review ${found}, then run this again with it." >&2
    exit 1
  fi
}

require_reviewed_head

echo "Waiting for checks on #${pr} at ${head}..."
gh pr checks "$pr" --watch --fail-fast

echo "All checks passed."

# GitHub computes a pull request's mergeable state (UNKNOWN | MERGEABLE | CONFLICTING)
# asynchronously, and right after its checks turn green it can still answer UNKNOWN for a few
# seconds even though nothing is wrong (issue #128: #110 and #116 both failed here the same
# night, and a direct retry a few seconds later succeeded immediately with nothing else
# changed). UNKNOWN is not CONFLICTING: a real conflict is reported straight away and must
# still fail the script on the spot, with no retry, same as a red check already does above.
# A bounded poll tells the two apart instead of treating "not yet known" as "not mergeable".
#
# 5 attempts, 2 seconds apart (10s total): both false UNKNOWNs seen in #128 cleared well
# within that window, and a script that sits waiting on a genuine problem is worse than one
# that occasionally makes someone type the merge command twice, so the bound stays short.
poll_attempts=5
poll_interval=2

attempt=0
mergeable="$(gh pr view "$pr" --json mergeable -q .mergeable)"
while [[ "$mergeable" == "UNKNOWN" && "$attempt" -lt "$poll_attempts" ]]; do
  sleep "$poll_interval"
  attempt=$((attempt + 1))
  mergeable="$(gh pr view "$pr" --json mergeable -q .mergeable)"
done

if [[ "$mergeable" == "CONFLICTING" ]]; then
  echo "#${pr} is not mergeable: GitHub reports a merge conflict. Resolve it and try again." >&2
  exit 1
fi

if [[ "$mergeable" != "MERGEABLE" ]]; then
  echo "#${pr}'s mergeable state is still ${mergeable} after $((poll_attempts * poll_interval))s. That is GitHub not having finished computing it yet, not a conflict; try the merge again shortly." >&2
  exit 1
fi

require_reviewed_head

echo "Squash-merging #${pr} at ${head}..."
# No --delete-branch: the repository already deletes the merged branch on the remote, and the
# flag also tries to delete the LOCAL branch, which fails whenever the author merges from a
# worktree that still has it checked out. That failure reads like the merge failed, when the
# merge has in fact succeeded.
gh pr merge "$pr" --squash --match-head-commit "$head"
