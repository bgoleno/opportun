#!/usr/bin/env bash
#
# Exercises scripts/merge-when-green.sh's control flow against a fake `gh` and a fake `sleep`
# on PATH, since there is no way to make the real GitHub API hold a PR in UNKNOWN on demand,
# and no test may merge a real pull request. Checks:
# - issue #128: a real red check still fails immediately (gh pr merge never called, no poll);
#   a real CONFLICTING state still fails immediately (no sleep, no retry); UNKNOWN that clears
#   partway through the poll proceeds to merge; UNKNOWN that never clears fails after the
#   bound, distinctly from CONFLICTING, without ever calling gh pr merge.
# - issue #82: the merge is pinned to the reviewed head (`--match-head-commit <sha>`, exact
#   arguments); a head that is not the reviewed one, before the wait or after it, is refused
#   without merging and named; a missing or malformed argument is a usage error that calls no
#   gh at all.
#
# Usage: scripts/merge-when-green.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="${SCRIPT_DIR}/merge-when-green.sh"

# Obviously fake commit SHAs.
REVIEWED="1111111111111111111111111111111111111111"
PUSHED_AFTER="2222222222222222222222222222222222222222"

fails=0

# Runs the target with a fake `gh` (behavior driven by the arguments below) and a fake `sleep`
# (always instant) ahead of the real PATH, and captures stdout+stderr, exit code, and every
# call the fake `gh` saw.
#
#   run <checks exit> <mergeable sequence> <head sequence> [script args...]
#
# Each sequence is space-separated: every `pr view` of that field hands back its next word,
# and the last word repeats. Script args default to `999 <REVIEWED>`; the single argument
# `--no-arguments` runs the script with none.
run() {
  local checks_exit="$1" mergeable_sequence="$2" head_sequence="$3"
  shift 3
  local args=("$@")
  if [[ ${#args[@]} -eq 0 ]]; then args=(999 "${REVIEWED}"); fi
  if [[ "${args[*]}" == "--no-arguments" ]]; then args=(); fi
  local bin
  bin="$(mktemp -d)"
  local calls="${bin}/calls.log"
  : > "$calls"

  # The fake stands in for every `gh` call the script makes. `pr view ... --json <field> -q
  # .<field>` is not reimplemented field-for-field; it just hands back the next word of that
  # field's sequence, which is all the script ever reads from it.
  cat > "${bin}/gh" <<FAKE_GH
#!/usr/bin/env bash
echo "\$*" >> "${calls}"
next_of() {
  local name="\$1" sequence="\$2"
  local state_file="${bin}/state.\${name}"
  local idx
  idx="\$(cat "\${state_file}" 2>/dev/null || echo 0)"
  read -r -a seq <<< "\${sequence}"
  local last=\$((\${#seq[@]} - 1))
  local use=\$idx
  if [[ \$use -gt \$last ]]; then use=\$last; fi
  echo "\$((idx + 1))" > "\${state_file}"
  echo "\${seq[\$use]}"
}
if [[ "\$1 \$2" == "pr checks" ]]; then
  exit "${checks_exit}"
fi
if [[ "\$1 \$2" == "pr view" && " \$* " == *" headRefOid "* ]]; then
  next_of head "${head_sequence}"
  exit 0
fi
if [[ "\$1 \$2" == "pr view" && " \$* " == *" mergeable "* ]]; then
  next_of mergeable "${mergeable_sequence}"
  exit 0
fi
if [[ "\$1 \$2" == "pr merge" ]]; then
  exit 0
fi
echo "fake gh: unhandled call: \$*" >&2
exit 99
FAKE_GH
  chmod +x "${bin}/gh"

  cat > "${bin}/sleep" <<'FAKE_SLEEP'
#!/usr/bin/env bash
exit 0
FAKE_SLEEP
  chmod +x "${bin}/sleep"

  local out status
  # ${args[@]+...}: an empty array is "unbound" under set -u in bash before 4.4 (macOS's 3.2).
  out="$(PATH="${bin}:${PATH}" bash "${TARGET}" ${args[@]+"${args[@]}"} 2>&1)" && status=0 || status=$?

  echo "${out}"
  echo "---calls---"
  cat "${calls}"
  echo "---end---"
  echo "exit:${status}"

  rm -rf "${bin}"
}

assert_contains() {
  local haystack="$1" needle="$2" label="$3"
  if [[ "${haystack}" != *"${needle}"* ]]; then
    echo "FAIL: ${label}: expected to find '${needle}'"
    fails=$((fails + 1))
  fi
}

assert_not_contains() {
  local haystack="$1" needle="$2" label="$3"
  if [[ "${haystack}" == *"${needle}"* ]]; then
    echo "FAIL: ${label}: expected NOT to find '${needle}'"
    fails=$((fails + 1))
  fi
}

# The fake gh's calls, one per line, from run's output.
calls_of() {
  sed -n '/^---calls---$/,/^---end---$/p' <<< "$1" | sed '1d;$d'
}

assert_call() {
  local out="$1" line="$2" label="$3"
  if ! calls_of "${out}" | grep -Fqx -- "${line}"; then
    echo "FAIL: ${label}: expected the exact gh call '${line}'"
    fails=$((fails + 1))
  fi
}

echo "== a red check fails immediately, never polls mergeability or calls merge =="
out="$(run 1 "MERGEABLE" "${REVIEWED}")"
assert_contains "${out}" "exit:1" "red check exit code"
assert_not_contains "${out}" "--json mergeable" "red check: no mergeable poll"
assert_not_contains "${out}" "pr merge" "red check: no merge attempt"

echo "== a real conflict fails immediately, with exactly one poll and no merge attempt =="
out="$(run 0 "CONFLICTING" "${REVIEWED}")"
assert_contains "${out}" "exit:1" "conflict exit code"
assert_contains "${out}" "merge conflict" "conflict message names the real cause"
assert_not_contains "${out}" "pr merge" "conflict: no merge attempt"
call_count="$(calls_of "${out}" | grep -c -- "--json mergeable" || true)"
if [[ "${call_count}" != "1" ]]; then
  echo "FAIL: conflict should need exactly one mergeable check, saw ${call_count}"
  fails=$((fails + 1))
fi

echo "== UNKNOWN that clears partway through the poll proceeds to merge =="
out="$(run 0 "UNKNOWN UNKNOWN MERGEABLE" "${REVIEWED}")"
assert_contains "${out}" "exit:0" "clears then merges: exit code"
assert_contains "${out}" "pr merge" "clears then merges: merge attempted"

echo "== UNKNOWN that never clears fails after the bound, distinctly from CONFLICTING =="
out="$(run 0 "UNKNOWN" "${REVIEWED}")"
assert_contains "${out}" "exit:1" "stuck unknown exit code"
assert_contains "${out}" "not having finished computing it yet, not a conflict" "stuck unknown message distinguishes itself from a real conflict"
assert_not_contains "${out}" "pr merge" "stuck unknown: no merge attempt"

echo "== the merge is pinned to the reviewed head, with exactly these arguments =="
out="$(run 0 "MERGEABLE" "${REVIEWED}")"
assert_contains "${out}" "exit:0" "pinned merge exit code"
assert_call "${out}" "pr merge 999 --squash --match-head-commit ${REVIEWED}" "pinned merge arguments"
merge_count="$(calls_of "${out}" | grep -c "^pr merge" || true)"
if [[ "${merge_count}" != "1" ]]; then
  echo "FAIL: pinned merge should call gh pr merge exactly once, saw ${merge_count}"
  fails=$((fails + 1))
fi

echo "== an upper-case SHA is the same commit: the merge is pinned to its lower-case form =="
out="$(run 0 "MERGEABLE" "abcdef0123456789abcdef0123456789abcdef01" 999 "ABCDEF0123456789ABCDEF0123456789ABCDEF01")"
assert_contains "${out}" "exit:0" "upper-case SHA exit code"
assert_call "${out}" "pr merge 999 --squash --match-head-commit abcdef0123456789abcdef0123456789abcdef01" "upper-case SHA merge arguments"

echo "== a head that is not the reviewed one is refused before the wait, and named =="
out="$(run 0 "MERGEABLE" "${PUSHED_AFTER}")"
assert_contains "${out}" "exit:1" "different head exit code"
assert_contains "${out}" "its head is ${PUSHED_AFTER}, not the reviewed ${REVIEWED}" "different head message names both commits"
assert_not_contains "${out}" "pr checks" "different head: no wait for checks"
assert_not_contains "${out}" "pr merge" "different head: no merge attempt"

echo "== a push during the wait is refused before the merge, and named =="
out="$(run 0 "MERGEABLE" "${REVIEWED} ${PUSHED_AFTER}")"
assert_contains "${out}" "exit:1" "push during the wait exit code"
assert_contains "${out}" "its head is ${PUSHED_AFTER}, not the reviewed ${REVIEWED}" "push during the wait message names both commits"
assert_contains "${out}" "pr checks" "push during the wait: the checks were waited for"
assert_not_contains "${out}" "pr merge" "push during the wait: no merge attempt"

# Each case: a label, then the arguments the script is given.
usage_case() {
  local label="$1"
  shift
  local out
  out="$(run 0 "MERGEABLE" "${REVIEWED}" "$@")"
  assert_contains "${out}" "exit:64" "${label}: exit code"
  assert_contains "${out}" "usage: scripts/merge-when-green.sh <pr-number> <head-sha>" "${label}: usage text"
  if [[ -n "$(calls_of "${out}")" ]]; then
    echo "FAIL: ${label}: expected no gh call at all"
    fails=$((fails + 1))
  fi
}

echo "== a missing or malformed argument is a usage error, and calls no gh at all =="
usage_case "no arguments" --no-arguments
usage_case "no head" 999
usage_case "empty arguments" "" ""
usage_case "abbreviated head" 999 "1111111"
usage_case "non-hex head" 999 "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz"
usage_case "41-character head" 999 "${REVIEWED}1"
usage_case "a flag for a PR number" "--admin" "${REVIEWED}"
usage_case "PR number zero" 0 "${REVIEWED}"
usage_case "an extra argument" 999 "${REVIEWED}" "--admin"

if [[ "${fails}" -gt 0 ]]; then
  echo "${fails} assertion(s) failed"
  exit 1
fi
echo "All assertions passed."
