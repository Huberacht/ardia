#!/usr/bin/env bash
set -euo pipefail

usage="usage: scripts/release/notarize.sh <Ardia.app or .dmg> <log dir>  (notarizes it and staples the ticket to it; NOTARY_STATE_DIR keeps submission ids across retries, default dist/.notary)"
target="${1:?$usage}"
logs="${2:?$usage}"
. "$(dirname "$0")/lib.sh"
load_notary_auth
state="${NOTARY_STATE_DIR:-$root/dist/.notary}"
delay="${NOTARY_RETRY_DELAY:-20}"
mkdir -p "$state" "$logs"

sha256_of() {
  if command -v shasum >/dev/null; then shasum -a 256 "$1" | awk '{ print $1 }'; else sha256sum "$1" | awk '{ print $1 }'; fi
}

valid_id() { [[ "$1" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; }

status_of() { awk '$1 == "status:" { sub(/^[[:space:]]*status:[[:space:]]*/, ""); print; exit }' "$1"; }

staple() {
  local attempt
  for attempt in 1 2 3 4 5; do
    xcrun stapler staple "$target" && return 0
    [ "$attempt" = 5 ] || { echo "stapler couldn't fetch the ticket yet (attempt $attempt); asking again"; sleep "$delay"; }
  done
  return 1
}

rejected() {
  local id="$1" log="$2"
  xcrun notarytool log "$id" "${notary_auth[@]}" 2>&1 | tee -a "$log" || true
  die "Apple rejected submission $id of $(basename "$target") (its log is above and in $log). Fix the build; resubmitting the same file gets the same answer."
}

wait_for() {
  local id="$1" log="$2" tries=0 out status
  out="$(mktemp "${TMPDIR:-/tmp}/ac-notary-wait.XXXXXX")"
  until { xcrun notarytool wait "$id" "${notary_auth[@]}" --timeout 1h 2>&1 || true; } | tee "$out"; status="$(status_of "$out")"; cat "$out" >> "$log"; [ "$status" = Accepted ]; do
    case "$status" in Invalid | Rejected) rm -f "$out"; rejected "$id" "$log" ;; esac
    tries=$((tries + 1))
    [ "$tries" -lt 5 ] || { rm -f "$out"; die "notarytool kept failing while waiting on $id; run this again to pick it up where it left off"; }
    echo "notarytool wait ended without an answer ($(tail -1 "$out")); asking again ($tries/5)"
    sleep "$delay"
  done
  rm -f "$out"
}

resume() {
  local id="$1" log="$2" attempt out status=""
  out="$(mktemp "${TMPDIR:-/tmp}/ac-notary-info.XXXXXX")"
  for attempt in 1 2 3; do
    if xcrun notarytool info "$id" "${notary_auth[@]}" >"$out" 2>&1; then status="$(status_of "$out")"; break; fi
    [ "$attempt" = 3 ] || sleep "$delay"
  done
  cat "$out" >> "$log"
  rm -f "$out"
  case "$status" in
    Accepted) echo "Apple already accepted submission $id of this exact file" ;;
    "In Progress") echo "Submission $id of this exact file is still in Apple's queue; waiting on it instead of uploading again"; wait_for "$id" "$log" ;;
    Invalid | Rejected) rejected "$id" "$log" ;;
    *) echo "Apple doesn't know submission $id (status '${status:-none}'); submitting again"; return 1 ;;
  esac
}

submit() {
  local file="$1" log="$2" record="$3" id="" attempt out
  out="$(mktemp "${TMPDIR:-/tmp}/ac-notary-submit.XXXXXX")"
  for attempt in 1 2 3; do
    if xcrun notarytool submit "$file" "${notary_auth[@]}" | tee "$out"; then
      id="$(awk '$1 == "id:" { print $2; exit }' "$out")"
    fi
    cat "$out" >> "$log"
    valid_id "$id" && break
    id=""
    [ "$attempt" = 3 ] || { echo "notarytool submit failed (attempt $attempt), likely an upload cut off; submitting again"; sleep "$delay"; }
  done
  rm -f "$out"
  [ -n "$id" ] || die "notarytool couldn't submit $(basename "$file") (3 attempts)"
  printf '%s\n' "$id" > "$record.tmp"
  mv "$record.tmp" "$record"
  echo "Submission $id recorded in $record: a retry picks it up instead of uploading again"
  wait_for "$id" "$log"
}

notarize() {
  local file="$1" log digest record id=""
  log="$logs/notary-$(basename "$target").log"
  digest="$(sha256_of "$file")"
  record="$state/$digest"
  echo "Notarizing $(basename "$target") (sha256 ${digest:0:12})"
  : > "$log"
  if [ -f "$record" ] && [ ! -L "$record" ]; then
    id="$(head -c 64 "$record" | tr -d '[:space:]')"
    valid_id "$id" || { echo "ignoring $record: '$id' isn't a submission id"; id=""; }
  fi
  if [ -n "$id" ] && resume "$id" "$log"; then
    staple && return 0
    echo "Apple accepted $id but has no ticket for this file; submitting again"
  fi
  submit "$file" "$log" "$record"
  staple || die "stapler couldn't staple $(basename "$target") after Apple accepted it"
}

case "$target" in
  *.app)
    if xcrun stapler staple "$target" >/dev/null 2>&1; then
      echo "$(basename "$target") is already notarized (Apple has a ticket for this exact code): stapled, nothing uploaded"
      exit 0
    fi
    zip="$logs/notarize.zip"
    ditto -c -k --keepParent "$target" "$zip"
    notarize "$zip"
    rm -f "$zip"
    ;;
  *.dmg) notarize "$target" ;;
  *) die "$usage" ;;
esac
