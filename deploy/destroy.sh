#!/usr/bin/env bash
#
# Tears down an Opportun deployment entirely: containers, network, every named volume
# compose created for it (database, Postgres if the profile was on, Caddy state), the bind-
# mounted data directory (attachments, backups, exports, master.key), and the local .env.
# This is the "erase my data and let me start over" reading of NFR-PRV4's account-deletion
# requirement (issue #139): a single-user self-hosted instance has no multi-tenant row to
# remove, so deletion means removing everything on the local system, not an in-app route.
#
# Two things this script refuses to guess at, both incident-driven:
#
# - The compose PROJECT NAME. A project name is a global namespace on the Docker host
#   (issue #203): `docker compose down -v` with no explicit `-p` can find and destroy a
#   stack this invocation never created, which is exactly what happened to the owner's live
#   deployment. This script never falls back to compose.yml's own `name:` or to the current
#   directory; it requires `-p <project>` or COMPOSE_PROJECT_NAME, and refuses to run
#   without one.
#
# - The DATA DIRECTORY. deploy/compose.yml bind-mounts `./data:/data` by default, but a
#   real deployment can override that (a `compose.override.yml`, or any other mechanism
#   compose supports) to point somewhere else entirely. Hardcoding `deploy/data` would
#   either do nothing on such a deployment (the data survives, silently) or, worse, delete
#   the wrong directory on someone else's. This script resolves the real bind-mount source
#   from the actually-running container's own mounts (`docker inspect`), which reflects
#   whatever override is in effect, and refuses to delete anything if that resolution fails
#   and no --data-dir override was given. Whatever the resolved path, it is still refused
#   (not warned about) if it is `/`, `$HOME`, relative, or fewer than 3 path components:
#   existing is not the same as safe to `rm -rf`.
#
# What counts as ".env to remove" is likewise not a literal `compose.yml` check: a real
# deployment can hold only a `compose.override.yml`, with the base file and its own
# `.env`-driven COMPOSE_FILE pointing elsewhere. This asks `docker compose config` whether
# this directory actually resolves as the given project before trusting its `.env`, rather
# than guessing from one filename.
#
# Usage:
#   deploy/destroy.sh -p <project> [--data-dir <path>] [--dry-run]
#
# --dry-run prints exactly what a real run would do (project, containers, network, volumes,
# resolved data directory) and exits without touching anything. Run it first.
#
# A real run prints the same summary, then requires the operator to type the project name
# back (not y/n, and not a flag: a flag can be baked into a habit or a saved command and
# typed without reading what it is about to do). Backups live inside the data directory and
# are deleted with everything else; if you want a way back, copy the data directory
# somewhere outside this host before confirming.
#
# What this script cannot do, and will not pretend to: revoke the Google OAuth grant. That
# lives on Google's side, not this machine's, so deleting local tokens does not touch it.
# The last thing this script prints is the one manual step that makes removal complete.
set -euo pipefail

PROJECT="${COMPOSE_PROJECT_NAME:-}"
DATA_DIR_OVERRIDE=""
DRY_RUN=0

usage() {
  cat <<'USAGE'
Usage: deploy/destroy.sh -p <project> [--data-dir <path>] [--dry-run]

  -p, --project <name>   The compose project to destroy. Required: also settable via
                          COMPOSE_PROJECT_NAME, but there is no other default. This never
                          falls back to compose.yml's own name or to the current directory.
  --data-dir <path>      Use this path instead of auto-detecting the /data bind-mount
                          source from the running container. Only needed if detection
                          fails (e.g. the stack was already torn down without -v).
  --dry-run              Print what would be destroyed and exit. Nothing is touched.
  -h, --help             Show this message.
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -p|--project)
      PROJECT="${2:?--project needs a value}"
      shift 2
      ;;
    --data-dir)
      DATA_DIR_OVERRIDE="${2:?--data-dir needs a value}"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "destroy.sh: unrecognized argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$PROJECT" ]]; then
  echo "destroy.sh: no project name given." >&2
  echo "Pass -p <project> or set COMPOSE_PROJECT_NAME. There is no default: a compose" >&2
  echo "project name is a global namespace on this Docker host (issue #203), and" >&2
  echo "guessing one here is exactly how a teardown reaches the wrong deployment." >&2
  exit 1
fi

label="com.docker.compose.project=${PROJECT}"

# Not `mapfile`: the default /bin/bash on macOS is 3.2 (no mapfile, added in 4.0), and
# Docker Desktop for Mac running this script directly on the host shell is a documented
# scenario (docs/install.md), not an edge case to assume away.
containers=()
while IFS= read -r line; do
  [[ -n "$line" ]] && containers+=("$line")
done < <(docker ps -a --filter "label=${label}" --format '{{.Names}}')

volumes=()
while IFS= read -r line; do
  [[ -n "$line" ]] && volumes+=("$line")
done < <(docker volume ls --filter "label=${label}" --format '{{.Name}}')

networks=()
while IFS= read -r line; do
  [[ -n "$line" ]] && networks+=("$line")
done < <(docker network ls --filter "label=${label}" --format '{{.Name}}')

resolved_data_dir=""
detection_note=""
if [[ -n "$DATA_DIR_OVERRIDE" ]]; then
  resolved_data_dir="$DATA_DIR_OVERRIDE"
  detection_note="(given with --data-dir, not verified against a running mount)"
else
  opportun_cid="$(docker ps -a \
    --filter "label=${label}" \
    --filter "label=com.docker.compose.service=opportun" \
    --format '{{.ID}}' | head -n1)"
  if [[ -n "$opportun_cid" ]]; then
    # Two independent reasons a freshly-created container's reported mount can momentarily
    # not check out, retried together: Docker can still be finishing creating a bind
    # mount's source directory right after `up` returns (a startup race, resolves on
    # retry), and separately, on Docker Desktop for Mac, `docker inspect` can report the
    # source through that VM's own /host_mnt addressing, which never exists from the host
    # shell and does not resolve on retry alone -- stripping that documented prefix is a
    # known correction, checked on every attempt, not a guess made once and hoped for.
    attempt=1
    while [[ $attempt -le 5 ]]; do
      resolved_data_dir="$(docker inspect --format \
        '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}' \
        "$opportun_cid")"
      if [[ -n "$resolved_data_dir" && "$resolved_data_dir" == /host_mnt/* && ! -d "$resolved_data_dir" ]]; then
        stripped="${resolved_data_dir#/host_mnt}"
        [[ -d "$stripped" ]] && resolved_data_dir="$stripped"
      fi
      [[ -n "$resolved_data_dir" && -d "$resolved_data_dir" ]] && break
      sleep 0.5
      attempt=$((attempt + 1))
    done
  fi
  if [[ -n "$resolved_data_dir" ]]; then
    detection_note="(read from the running container's own /data mount)"
  fi
fi

# A path containing a newline would make every later log line and the confirmation
# summary lie about what is being deleted. The whole premise of requiring the operator to
# type the project name back is that they can read what they are confirming; a value that
# can't be printed honestly defeats that before the confirmation even happens.
if [[ -n "$resolved_data_dir" && "$resolved_data_dir" == *$'\n'* ]]; then
  echo "destroy.sh: refusing a data directory whose path contains a newline." >&2
  exit 1
fi

if [[ -n "$resolved_data_dir" && "$resolved_data_dir" != /* ]]; then
  echo "destroy.sh: refusing to delete '${resolved_data_dir}' -- not an absolute path." >&2
  echo "A relative path resolves against whatever directory this happens to be run" >&2
  echo "from, which is not something to trust for a recursive delete." >&2
  exit 1
fi

# Existence and normalization together, deliberately: counting path components on the
# literal string is not enough on its own, since `/a/b/c/../../..` counts as 6 components
# by that method while it normalizes to `/` -- six passes a ">= 3" check cleanly and -d is
# true because it genuinely is /. `cd -P` walks the path exactly as the filesystem would,
# collapsing `..` and `.` and resolving symlinks along the way, the same move the .env fix
# above makes: stop pattern-matching the string, ask what it actually resolves to. A `cd
# -P` that fails means the path isn't real from here, the same signal a separate existence
# check used to give, so folding them together means every check after this one, and
# everything printed from here on, runs against the real target, not a string that merely
# looks like it.
if [[ -n "$resolved_data_dir" ]]; then
  # `|| true`: a plain `var="$(cmd)"` assignment propagates cmd's own failure under
  # set -e and exits right here, silently, before the explicit "doesn't exist" message
  # below ever runs. A nonexistent path is an expected outcome this script handles
  # itself, not an error to let the shell's own errexit short-circuit around it.
  normalized_path="$(cd -P -- "$resolved_data_dir" 2>/dev/null && pwd)" || true
  if [[ -z "$normalized_path" ]]; then
    echo "destroy.sh: the resolved data directory does not exist from here:" >&2
    echo "  ${resolved_data_dir} ${detection_note}" >&2
    echo "This can happen when the path is reported from a different filesystem view" >&2
    echo "than this shell has (seen with some Docker Desktop configurations). Refusing" >&2
    echo "to guess: pass --data-dir with the real path as this shell would spell it." >&2
    exit 1
  fi
  if [[ "$normalized_path" != "$resolved_data_dir" ]]; then
    detection_note="${detection_note} -- normalized from '${resolved_data_dir}'"
  fi
  resolved_data_dir="$normalized_path"
fi

# Existing is not the same as safe to recursively delete: -d is true for `/`, `/Users`,
# `/home` and $HOME just as much as for a real data directory. A slipped `--data-dir /`
# (or one built from `..`, now resolved above), or detection ever returning something
# unexpected, must not reach `rm -rf` just because the path happens to exist. Refuse
# outright -- not warn -- rather than trust a value this absolutely anywhere else in the
# script has been refused rather than guessed at.
if [[ -n "$resolved_data_dir" ]]; then
  component_count=0
  rest="$resolved_data_dir"
  while [[ -n "$rest" && "$rest" != "/" ]]; do
    component_count=$((component_count + 1))
    rest="$(dirname "$rest")"
  done
  # Same `|| true` reasoning as above: HOME being unset or not a real directory is
  # handled explicitly below (the comparison simply skips), not something to let
  # errexit abort the script over.
  home_normalized="$(cd -P -- "${HOME:-/nonexistent}" 2>/dev/null && pwd)" || true
  dangerous=0
  [[ "$resolved_data_dir" == "/" ]] && dangerous=1
  [[ -n "$home_normalized" && "$resolved_data_dir" == "$home_normalized" ]] && dangerous=1
  [[ $component_count -lt 3 ]] && dangerous=1
  if [[ $dangerous -eq 1 ]]; then
    echo "destroy.sh: refusing to delete '${resolved_data_dir}'." >&2
    echo "This is \$HOME, /, or too shallow a path to trust as a deployment's own data" >&2
    echo "directory (fewer than 3 components). A real data directory is never this" >&2
    echo "close to the filesystem root; this is refused rather than warned about," >&2
    echo "since the only other option here is an unattended rm -rf of the wrong tree." >&2
    exit 1
  fi
fi

if [[ ${#containers[@]} -eq 0 && ${#volumes[@]} -eq 0 && ${#networks[@]} -eq 0 && -z "$resolved_data_dir" ]]; then
  echo "destroy.sh: nothing found for project '${PROJECT}'." >&2
  echo "No containers, volumes or networks carry that project label, and no data" >&2
  echo "directory could be resolved. Check the project name; if you are certain this is" >&2
  echo "right and only the data directory survives, pass --data-dir explicitly." >&2
  exit 1
fi

echo "Project:    ${PROJECT}"
echo "Containers: ${containers[*]:-(none)}"
echo "Networks:   ${networks[*]:-(none)}"
echo "Volumes:    ${volumes[*]:-(none)}"
if [[ -n "$resolved_data_dir" ]]; then
  echo "Data dir:   ${resolved_data_dir} ${detection_note}"
else
  echo "Data dir:   NOT RESOLVED -- pass --data-dir <path> if you are sure where it is."
fi

# What identifies "the deployment's own directory" is not a literal `compose.yml` here:
# a real deployment can hold only a `compose.override.yml`, with the base file and its
# own `.env`-driven `COMPOSE_FILE` pointing elsewhere (seen directly: the owner's own
# layout is exactly this, and a check for `compose.yml` by name would silently never
# remove his .env, which holds the password pepper this is supposed to be removing).
# Checking for a .env first, before asking compose anything, matters beyond ordering:
# `docker compose config` also searches parent directories for a compose file (verified
# directly), so running it from a directory with no .env of its own risks a false match
# against an unrelated ancestor's compose file. Skipping that check entirely when there is
# no local .env to protect removes that risk for the one case it would otherwise bite.
env_file=""
env_present_but_unremoved=0
if [[ ! -f "${PWD}/.env" ]]; then
  echo "Env file:   (no .env in this directory)"
elif docker compose -p "$PROJECT" config >/dev/null 2>&1; then
  env_file="${PWD}/.env"
  echo "Env file:   ${env_file}"
else
  env_present_but_unremoved=1
  echo "Env file:   NOT REMOVED -- this directory has a .env but does not resolve as"
  echo "            project '${PROJECT}' via docker compose config. Run destroy.sh from"
  echo "            the deployment's own directory (wherever its compose files actually"
  echo "            live) to have its .env removed too."
fi

if [[ $DRY_RUN -eq 1 ]]; then
  echo
  echo "Dry run: nothing was touched."
  exit 0
fi

if [[ -z "$resolved_data_dir" ]]; then
  echo >&2
  echo "destroy.sh: refusing to continue without a resolved data directory." >&2
  echo "Pass --data-dir explicitly if you are certain of the path." >&2
  exit 1
fi

echo
echo "This permanently deletes the above: every container, network and volume under"
echo "project '${PROJECT}', and everything under ${resolved_data_dir} (database,"
echo "attachments, backups, master.key). Backups live inside that directory and are"
echo "deleted along with it -- copy it somewhere outside this host first if you want a"
echo "way back. This cannot be undone."
echo
read -r -p "Type the project name (${PROJECT}) to continue: " confirmation
if [[ "$confirmation" != "$PROJECT" ]]; then
  echo "destroy.sh: confirmation did not match. Nothing was touched." >&2
  exit 1
fi

docker compose -p "$PROJECT" down -v --remove-orphans
rm -rf -- "$resolved_data_dir"
if [[ -n "$env_file" && -f "$env_file" ]]; then
  rm -f -- "$env_file"
  echo "Removed ${env_file}."
fi

echo
echo "Done: project '${PROJECT}' and ${resolved_data_dir} are gone."
if [[ $env_present_but_unremoved -eq 1 ]]; then
  echo
  echo "NOT removed: this directory's .env, because it didn't resolve as project"
  echo "'${PROJECT}'. Remove it by hand if it belongs to this deployment -- it may hold"
  echo "OPPORTUN_PEPPER, which is part of what this was supposed to remove."
fi

cat <<EOF

One step remains and nothing on this machine can do it for you: the Google OAuth
grant this deployment held outlives all of the above. Revoke it at
https://myaccount.google.com/permissions (sign in with the account you connected),
or Opportun keeps a live grant on an account that no longer exists here.
EOF
