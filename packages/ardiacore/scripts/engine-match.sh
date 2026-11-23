#!/bin/bash
# Reads and acts on an engine match line, the one fetch-engine.sh writes to engine-match beside the framework it fetched:
#   match=exact|nearest|local key=<engine key> version=<release> source=<commit> public=same|changed
# exact: the engine published for this checkout's engine key; nearest: one published for an earlier key; local: a
# framework with no such line (an engine built here, or ARDIACORE_FRAMEWORK pointing at one).
#
#   engine-match.sh get <field> <line>        prints one field (match is local when the line has none)
#   engine-match.sh check <line>              fails when a nearest engine's public headers differ from this checkout's
#   engine-match.sh plist <line> <Info.plist> checks, then writes ArdiaEngineMatch, ArdiaEngineKey, ArdiaEngineVersion
#                                             and ArdiaEngineSource into the built app's Info.plist
#
# ARDIACORE_ALLOW_PUBLIC_MISMATCH=1 lets check and plist pass a mismatch: for engine work that builds against an
# older engine on purpose, and for CI, which compiles anyway and fails after the build.
set -euo pipefail
public_dir=engine/ardiacore/src/ardia/core/public
die() { echo "error: $*" >&2; exit 1; }

field() {
  local want=$1 pair
  for pair in $2; do
    if [[ "${pair%%=*}" == "$want" ]]; then
      printf '%s\n' "${pair#*=}"
      return 0
    fi
  done
  [[ "$want" == match ]] && echo local
  return 0
}

match_of() {
  local match
  match=$(field match "$1")
  case "$match" in
    exact | nearest | local) echo "$match" ;;
    *) die "engine match line has match=$match, not exact, nearest or local: $1" ;;
  esac
}

check() {
  local line=$1 match public
  match=$(match_of "$line")
  [[ "$match" == nearest ]] || return 0
  public=$(field public "$line")
  [[ "$public" == same ]] && return 0
  if [[ "${ARDIACORE_ALLOW_PUBLIC_MISMATCH:-}" == 1 ]]; then
    echo "warning: building against engine $(field version "$line"), older than this checkout's, though $public_dir changed since (ARDIACORE_ALLOW_PUBLIC_MISMATCH=1)" >&2
    return 0
  fi
  echo "error: this checkout's $public_dir differs from engine $(field version "$line")'s (built from $(field source "$line" | cut -c1-10)), the nearest published Mac engine it was given, so the app can't match it." >&2
  echo "error: build the engine (docs/engine-build.md) and set ARDIACORE_FRAMEWORK to it, check out a commit with a published engine, or set ARDIACORE_ALLOW_PUBLIC_MISMATCH=1 to build anyway." >&2
  return 1
}

plist() {
  local line=$1 file=$2 match name value
  [[ -f "$file" ]] || die "no Info.plist at $file"
  check "$line"
  match=$(match_of "$line")
  plutil -replace ArdiaEngineMatch -string "$match" "$file"
  for name in key version source; do
    value=$(field "$name" "$line")
    local plist_key="ArdiaEngine$(tr '[:lower:]' '[:upper:]' <<<"${name:0:1}")${name:1}"
    if [[ "$match" != local && -n "$value" ]]; then
      plutil -replace "$plist_key" -string "$value" "$file"
    else
      plutil -remove "$plist_key" "$file" >/dev/null 2>&1 || true
    fi
  done
}

case "${1:-}" in
  get) [[ $# -eq 3 ]] || die "usage: engine-match.sh get <field> <line>"; field "$2" "$3" ;;
  check) [[ $# -eq 2 ]] || die "usage: engine-match.sh check <line>"; check "$2" ;;
  plist) [[ $# -eq 3 ]] || die "usage: engine-match.sh plist <line> <Info.plist>"; plist "$2" "$3" ;;
  -h | --help) awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0" ;;
  *) die "usage: engine-match.sh get|check|plist … (--help)" ;;
esac
