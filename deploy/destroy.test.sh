#!/usr/bin/env bash
#
# Exercises deploy/destroy.sh (issue #139) against real, disposable compose stacks, not
# fakes: the thing being tested is whether it correctly reads real `docker inspect` /
# `docker volume ls` / `docker network ls` output filtered by the real
# com.docker.compose.project label, which a fake docker would just assume away. Each stack
# uses a throwaway alpine image (no need to build the real app) and a unique project name
# per CONTRIBUTING.md's "Testing deploy/compose.yml locally" rule, and is torn down in a
# trap regardless of how the test exits, so a failed assertion never leaves a stack behind.
#
# Requires Docker. Skips (exit 0) if it is not available, rather than failing: this is meant
# to run in CI's `docker` job (which already has it) and optionally by hand, not to block
# plain `pnpm test` runs that have no Docker on PATH.
#
# Usage: deploy/destroy.test.sh
set -euo pipefail

if ! command -v docker >/dev/null 2>&1 || ! docker info >/dev/null 2>&1; then
  echo "destroy.test.sh: no working Docker on this machine, skipping."
  exit 0
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="${SCRIPT_DIR}/destroy.sh"
WORK="$(mktemp -d)"
fails=0

cleanup() {
  # Best-effort: a project that was never created, or already torn down by the test
  # itself, has nothing to remove. Errors here are swallowed on purpose so one leftover
  # stack from a failed assertion never masks another test's own failure.
  for p in "${ALL_PROJECTS[@]:-}"; do
    [[ -n "$p" ]] && (cd "$WORK" && docker compose -p "$p" down -v --remove-orphans >/dev/null 2>&1 || true)
  done
  rm -rf "$WORK"
}
ALL_PROJECTS=()
trap cleanup EXIT

# The :-/tmp/destroy-test-unused fallback matters beyond this one `up`: destroy.sh itself
# later runs `docker compose config` (to decide whether to remove .env), as a fresh
# process with no memory of the TEST_DATA_DIR this test set only for its own `up -d`
# below. Without a fallback that later config call resolves an empty bind-mount source
# and compose's own validation rejects it -- not a destroy.sh bug, a fixture one.
cat > "${WORK}/compose.yml" <<'EOF'
name: opportun-set-compose-project-name
services:
  opportun:
    image: alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc
    command: ["sleep", "infinity"]
    volumes:
      - ${TEST_DATA_DIR:-/tmp/destroy-test-unused}:/data
      - sqlite_data:/sqlite
  caddy:
    image: alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc
    command: ["sleep", "infinity"]
volumes:
  sqlite_data:
  caddy_data:
EOF

check() {
  local desc="$1" got="$2" want="$3"
  if [[ "$got" != "$want" ]]; then
    echo "FAIL: ${desc}"
    echo "  got:  ${got}"
    echo "  want: ${want}"
    fails=$((fails + 1))
  fi
}

check_empty() {
  local desc="$1" got="$2"
  if [[ -n "$got" ]]; then
    echo "FAIL: ${desc} (expected empty, got: ${got})"
    fails=$((fails + 1))
  fi
}

NS_PROJECT=""
NS_DATA_DIR=""
new_stack() {
  # Sets NS_PROJECT/NS_DATA_DIR directly rather than echoing for the caller to capture:
  # a $(...) capture runs this function in a subshell, where the ALL_PROJECTS+=(...)
  # below would vanish with it, silently breaking the cleanup trap for every stack this
  # creates. Called plainly (no substitution), so it runs in this same shell instead.
  local tag="$1"
  NS_PROJECT="opportun-destroy-test-${tag}-$$-${RANDOM}"
  # stacks/ as an extra nesting level, not directly under $WORK: plain `mktemp -d` on
  # Linux can return something as shallow as /tmp/tmp.XXXXXXXXXX (2 components), which
  # would put ${WORK}/${tag}-data exactly on the dangerous-path guard's >= 3 boundary
  # with no margin. One more level of nesting costs nothing and keeps every test fixture
  # unambiguously on the "real data directory" side of that line regardless of how deep
  # any given platform's mktemp happens to nest.
  NS_DATA_DIR="${WORK}/stacks/${tag}-data"
  mkdir -p "$NS_DATA_DIR"
  echo "seed" > "${NS_DATA_DIR}/master.key"
  ALL_PROJECTS+=("$NS_PROJECT")
  ( cd "$WORK" && TEST_DATA_DIR="$NS_DATA_DIR" docker compose -p "$NS_PROJECT" up -d >/dev/null 2>&1 )
}

echo "== refuses with no project name and no COMPOSE_PROJECT_NAME =="
out="$(env -u COMPOSE_PROJECT_NAME bash "$TARGET" --dry-run 2>&1)" && code=0 || code=$?
check "exit code" "$code" "1"
check "mentions no default" "$(echo "$out" | grep -c 'no project name given')" "1"

echo "== refuses when nothing carries the given project label =="
out="$(bash "$TARGET" -p "opportun-destroy-test-nonexistent-$$" --dry-run 2>&1)" && code=0 || code=$?
check "exit code" "$code" "1"
check "mentions nothing found" "$(echo "$out" | grep -c 'nothing found for project')" "1"

echo "== dry-run against a real stack: resolves project, volumes and data dir, touches nothing =="
new_stack dryrun
project="$NS_PROJECT"
data_dir="$NS_DATA_DIR"
out="$(bash "$TARGET" -p "$project" --dry-run 2>&1)" && code=0 || code=$?
check "dry run on a freshly created stack exits 0" "$code" "0"
[[ $code -ne 0 ]] && echo "$out"
check "names the project" "$(echo "$out" | grep -c "Project:    ${project}")" "1"
check "names the sqlite volume" "$(echo "$out" | grep -c "${project}_sqlite_data")" "1"
# A suffix match, not the full path: docker inspect's reported mount source has been seen
# to switch, run to run, between /var/folders/... and realpath's /private/var/folders/...
# for the same real directory (Docker's own non-determinism in that report, not something
# destroy.sh needs to resolve differently -- both spell the same directory and -d/rm -rf
# work correctly against either). "dryrun-data" is the part that actually distinguishes
# this from a literal deploy/data, which is what this check needs to confirm.
check "resolves the real (non-deploy/data) data dir" "$(echo "$out" | grep -c 'Data dir:.*dryrun-data ')" "1"
check "says dry run" "$(echo "$out" | grep -c 'Dry run: nothing was touched')" "1"
check "data dir survives a dry run" "$([[ -f "${data_dir}/master.key" ]] && echo yes)" "yes"
check "container survives a dry run" "$(docker ps -a --filter "label=com.docker.compose.project=${project}" --format '{{.Names}}' | wc -l | tr -d ' ')" "2"

echo "== a mismatched confirmation refuses and leaves everything in place =="
out="$(echo "not-the-project-name" | bash "$TARGET" -p "$project" 2>&1)" && code=0 || code=$?
check "exit code" "$code" "1"
check "says confirmation did not match" "$(echo "$out" | grep -c 'confirmation did not match')" "1"
check "data dir still there" "$([[ -f "${data_dir}/master.key" ]] && echo yes)" "yes"
check "container still there" "$(docker ps -a --filter "label=com.docker.compose.project=${project}" --format '{{.Names}}' | wc -l | tr -d ' ')" "2"

echo "== a matching confirmation tears down the stack and the real (non-default) data dir =="
destroy_out="$(echo "$project" | bash "$TARGET" -p "$project" 2>&1)" && destroy_code=0 || destroy_code=$?
check "real run exits 0" "$destroy_code" "0"
[[ $destroy_code -ne 0 ]] && echo "$destroy_out"
check_empty "no containers remain" "$(docker ps -a --filter "label=com.docker.compose.project=${project}" --format '{{.Names}}')"
check_empty "no volumes remain" "$(docker volume ls --filter "label=com.docker.compose.project=${project}" --format '{{.Name}}')"
check_empty "no networks remain" "$(docker network ls --filter "label=com.docker.compose.project=${project}" --format '{{.Name}}')"
check "data dir is gone" "$([[ -e "$data_dir" ]] && echo still-there || echo gone)" "gone"

echo "== removes .env from the invocation directory, alongside the data dir =="
new_stack envfile
project2="$NS_PROJECT"
data_dir2="$NS_DATA_DIR"
echo "OPPORTUN_PEPPER=test" > "${WORK}/.env"
destroy_out2="$(cd "$WORK" && echo "$project2" | bash "$TARGET" -p "$project2" 2>&1)" && destroy_code2=0 || destroy_code2=$?
check "real run exits 0" "$destroy_code2" "0"
[[ $destroy_code2 -ne 0 ]] && echo "$destroy_out2"
check "env file is gone" "$([[ -e "${WORK}/.env" ]] && echo still-there || echo gone)" "gone"
check "data dir is gone" "$([[ -e "$data_dir2" ]] && echo still-there || echo gone)" "gone"

echo "== --data-dir pointing at a path this shell cannot see is refused, not silently no-op'd =="
new_stack baddatadir
project3="$NS_PROJECT"
data_dir3="$NS_DATA_DIR"
out="$(bash "$TARGET" -p "$project3" --data-dir /definitely/not/a/real/path --dry-run 2>&1)" && code=0 || code=$?
check "exit code" "$code" "1"
check "refuses rather than guessing" "$(echo "$out" | grep -c 'does not exist from here')" "1"
( cd "$WORK" && docker compose -p "$project3" down -v --remove-orphans >/dev/null 2>&1 )
rm -rf "$data_dir3"

echo "== refuses a catastrophically short, root, or home --data-dir, existing or not =="
# /usr, not /Users: this needs a path that is both shallow AND actually exists on
# whatever's running the test, to exercise the dangerous-path guard specifically rather
# than the separate "doesn't exist" refusal. /Users is real on macOS and absent on CI's
# Linux runners (caught there: the refusal still happened, just via the other message,
# since a path that doesn't exist on Linux isn't the thing this loop means to check).
for bad in / "$HOME" /usr /tmp; do
  out="$(bash "$TARGET" -p "opportun-destroy-test-danger-$$" --data-dir "$bad" --dry-run 2>&1)" && code=0 || code=$?
  check "exit code for '${bad}'" "$code" "1"
  check "refuses '${bad}' rather than warning" "$(echo "$out" | grep -c 'refusing to delete')" "1"
done

echo "== refuses a relative --data-dir even when it exists =="
out="$(cd "$WORK" && bash "$TARGET" -p "opportun-destroy-test-relative-$$" --data-dir "." --dry-run 2>&1)" && code=0 || code=$?
check "exit code" "$code" "1"
check "refuses as not absolute" "$(echo "$out" | grep -c 'not an absolute path')" "1"

echo "== refuses a --data-dir built from .. that collapses to something shallow =="
# Ten ".." is deliberately more than needed (dirname("/") is "/", so overshooting is
# safe and sidesteps hand-computing the exact count through a symlink hop like /tmp's):
# this is the exact bypass a literal-string component count misses, since the string
# itself has well over 3 segments while it actually collapses to the filesystem root.
mkdir -p "${WORK}/dotdot/a/b/c"
out="$(bash "$TARGET" -p "opportun-destroy-test-dotdot-$$" \
  --data-dir "${WORK}/dotdot/a/b/c/../../../../../../../../../.." --dry-run 2>&1)" && code=0 || code=$?
check "exit code" "$code" "1"
check "refuses rather than accepting a long string that actually collapses to /" \
  "$(echo "$out" | grep -c 'refusing to delete')" "1"
rm -rf "${WORK}/dotdot"

echo "== a --data-dir with harmless .. that does not collapse anywhere dangerous still works =="
mkdir -p "${WORK}/legit/deep/data/sub"
out="$(bash "$TARGET" -p "opportun-destroy-test-legitdotdot-$$" --data-dir "${WORK}/legit/deep/data/sub/../../data" --dry-run 2>&1)" && code=0 || code=$?
check "exit code" "$code" "0"
check "normalizes and accepts it" "$(echo "$out" | grep -c 'Data dir:.*legit/deep/data')" "1"
rm -rf "${WORK}/legit"

echo "== refuses a --data-dir containing a newline =="
out="$(bash "$TARGET" -p "opportun-destroy-test-newline-$$" --data-dir "$(printf '/tmp/a\nb')" --dry-run 2>&1)" && code=0 || code=$?
check "exit code" "$code" "1"
check "refuses the newline rather than printing a lying summary" \
  "$(echo "$out" | grep -c 'contains a newline')" "1"

echo "== a deployment with only compose.override.yml (no local compose.yml) still gets its .env removed =="
BASE_DIR="${WORK}/override-only-base"
LOCAL_DIR="${WORK}/override-only-local"
# Pre-created rather than left for Docker to auto-create: that auto-creation turned out to
# be inconsistent for this specific cross-file override shape (confirmed directly -- simpler
# variants of the same idea auto-created reliably, this one didn't, for reasons chasing down
# further wasn't worth it). What this block tests is destroy.sh's own resolution, not
# Docker's directory-creation behavior, so give it a known-good precondition instead.
# Relative paths across merged compose files resolve against the *first* file's directory
# (here, BASE_DIR, since it's first in COMPOSE_FILE below) regardless of which file actually
# declares the volume -- so the real directory is ${BASE_DIR}/data, not anywhere under
# LOCAL_DIR, which is exactly the shape this checks.
mkdir -p "${BASE_DIR}/data" "$LOCAL_DIR"
project4="opportun-destroy-test-overrideonly-$$-${RANDOM}"
ALL_PROJECTS+=("$project4")
cat > "${BASE_DIR}/compose.yml" <<EOF
name: opportun-set-compose-project-name
services:
  opportun:
    image: alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc
    command: ["sleep", "infinity"]
    volumes:
      - sqlite_data:/sqlite
volumes:
  sqlite_data:
EOF
cat > "${LOCAL_DIR}/compose.override.yml" <<EOF
services:
  opportun:
    volumes:
      - ./data:/data
EOF
echo "OPPORTUN_PEPPER=test" > "${LOCAL_DIR}/.env"
echo "COMPOSE_FILE=${BASE_DIR}/compose.yml:compose.override.yml" >> "${LOCAL_DIR}/.env"
( cd "$LOCAL_DIR" && docker compose -p "$project4" up -d >/dev/null 2>&1 )
destroy_out4="$(cd "$LOCAL_DIR" && echo "$project4" | bash "$TARGET" -p "$project4" 2>&1)" && destroy_code4=0 || destroy_code4=$?
check "real run exits 0" "$destroy_code4" "0"
[[ $destroy_code4 -ne 0 ]] && echo "$destroy_out4"
# A suffix match, not the full path: docker inspect's reported mount source has been seen
# to switch, run to run, between /var/folders/... and realpath's /private/var/folders/...
# for the exact same directory (verified directly, inconsistent across repeated attempts
# with nothing else different) -- Docker's own non-determinism in that report, not
# something destroy.sh needs to resolve differently, since both spell the same real
# directory and -d/rm -rf work correctly against either. What this check actually needs is
# the distinguishing suffix: the base directory's data, not the local directory's.
check "resolved the base compose.yml's data dir, not a literal deploy/data" \
  "$(echo "$destroy_out4" | grep -c 'Data dir:.*override-only-base/data ')" "1"
check "did not resolve to the local directory instead" \
  "$(echo "$destroy_out4" | grep -c 'Data dir:.*override-only-local/data')" "0"
check "removed .env despite no local compose.yml" \
  "$([[ -e "${LOCAL_DIR}/.env" ]] && echo still-there || echo gone)" "gone"

echo "== a directory that doesn't resolve as the project leaves its .env alone and says so =="
# A fresh mktemp OUTSIDE $WORK, not a subdirectory of it: docker compose config searches
# parent directories for a compose file (verified directly), and $WORK's own root holds
# this test's compose.yml fixture, which a descendant of $WORK would find and falsely
# "resolve" against.
UNRELATED_DIR="$(mktemp -d)"
UNRELATED_DATA="${UNRELATED_DIR}-data/x/y"
mkdir -p "$UNRELATED_DATA"
echo "OPPORTUN_PEPPER=should-survive" > "${UNRELATED_DIR}/.env"
# --data-dir so the run gets past the "nothing found for this project" gate and actually
# reaches the .env decision this is testing, rather than refusing earlier for an unrelated
# reason.
out="$(cd "$UNRELATED_DIR" && bash "$TARGET" -p "opportun-destroy-test-norelation-$$" --data-dir "$UNRELATED_DATA" --dry-run 2>&1)" && code=0 || code=$?
check "says not removed" "$(echo "$out" | grep -c 'NOT REMOVED')" "1"
check "unrelated .env untouched by a dry run regardless" \
  "$([[ -e "${UNRELATED_DIR}/.env" ]] && echo yes || echo no)" "yes"
rm -rf "$UNRELATED_DIR" "${UNRELATED_DIR}-data"

if [[ $fails -gt 0 ]]; then
  echo "FAILED: ${fails} check(s)."
  exit 1
fi
echo "All destroy.sh checks passed."
