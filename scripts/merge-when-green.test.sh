#!/usr/bin/env bash
#
# Exercises scripts/merge-when-green.sh's control flow (issue #128) against a fake `gh` and a
# fake `sleep` on PATH, since there is no way to make the real GitHub API hold a PR in UNKNOWN
# on demand. Checks: a real red check still fails immediately (gh pr merge never called, no
# poll); a real CONFLICTING state still fails immediately (no sleep, no retry); UNKNOWN that
# clears partway through the poll proceeds to merge; UNKNOWN that never clears fails after the
# bound, distinctly from CONFLICTING, without ever calling gh pr merge.
#
# Usage: scripts/merge-when-green.test.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="${SCRIPT_DIR}/merge-when-green.sh"

fails=0

# Runs the target with a fake `gh` (behavior driven by env vars the fake reads) and a fake
# `sleep` (always instant) ahead of the real PATH, and captures stdout+stderr, exit code, and
# every call the fake `gh` saw.
run() {
  local checks_exit="$1" mergeable_sequence="$2"
  local bin
  bin="$(mktemp -d)"
  local calls="${bin}/calls.log"
  : > "$calls"

  # The fake stands in for every `gh` call the script makes. `pr view ... --json mergeable -q
  # .mergeable` is not reimplemented field-for-field; it just hands back the next word of the
  # sequence this test case was given, which is all the script ever reads from it.
  cat > "${bin}/gh" <<FAKE_GH
#!/usr/bin/env bash
echo "\$*" >> "${calls}"
if [[ "\$1 \$2" == "pr checks" ]]; then
  exit "${checks_exit}"
fi
if [[ "\$1 \$2" == "pr view" ]]; then
  state_file="${bin}/state"
  idx="\$(cat "\${state_file}" 2>/dev/null || echo 0)"
  read -r -a seq <<< "${mergeable_sequence}"
  last=\$((\${#seq[@]} - 1))
  use=\$idx
  if [[ \$use -gt \$last ]]; then use=\$last; fi
  echo "\$((idx + 1))" > "\${state_file}"
  echo "\${seq[\$use]}"
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
  out="$(PATH="${bin}:${PATH}" bash "${TARGET}" 999 2>&1)" && status=0 || status=$?

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

echo "== a red check fails immediately, never polls mergeability or calls merge =="
out="$(run 1 "MERGEABLE")"
assert_contains "${out}" "exit:1" "red check exit code"
assert_not_contains "${out}" "pr view" "red check: no mergeable poll"
assert_not_contains "${out}" "pr merge" "red check: no merge attempt"

echo "== a real conflict fails immediately, with exactly one poll and no merge attempt =="
out="$(run 0 "CONFLICTING")"
assert_contains "${out}" "exit:1" "conflict exit code"
assert_contains "${out}" "merge conflict" "conflict message names the real cause"
assert_not_contains "${out}" "pr merge" "conflict: no merge attempt"
call_count="$(echo "${out}" | grep -c "^pr view" || true)"
if [[ "${call_count}" != "1" ]]; then
  echo "FAIL: conflict should need exactly one mergeable check, saw ${call_count}"
  fails=$((fails + 1))
fi

echo "== UNKNOWN that clears partway through the poll proceeds to merge =="
out="$(run 0 "UNKNOWN UNKNOWN MERGEABLE")"
assert_contains "${out}" "exit:0" "clears then merges: exit code"
assert_contains "${out}" "pr merge" "clears then merges: merge attempted"

echo "== UNKNOWN that never clears fails after the bound, distinctly from CONFLICTING =="
out="$(run 0 "UNKNOWN")"
assert_contains "${out}" "exit:1" "stuck unknown exit code"
assert_contains "${out}" "not having finished computing it yet, not a conflict" "stuck unknown message distinguishes itself from a real conflict"
assert_not_contains "${out}" "pr merge" "stuck unknown: no merge attempt"

if [[ "${fails}" -gt 0 ]]; then
  echo "${fails} assertion(s) failed"
  exit 1
fi
echo "All assertions passed."
