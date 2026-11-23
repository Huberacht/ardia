#!/usr/bin/env bash
set -euo pipefail

usage="usage: scripts/release/notarize.sh <Ardia.app or .dmg> <log dir> [<the Ardia.app the .dmg packs>]  (notarizes it and staples the ticket to it; NOTARY_STATE_DIR keeps submission ids across retries, default dist/.notary; NOTARY_WAIT_SECONDS caps the time spent polling Apple, default 14400)"
target="${1:?$usage}"
logs="${2:?$usage}"
packed_app="${3:-}"
. "$(dirname "$0")/lib.sh"
load_notary_auth
state="${NOTARY_STATE_DIR:-$root/dist/.notary}"
delay="${NOTARY_RETRY_DELAY:-20}"
budget="${NOTARY_WAIT_SECONDS:-14400}"
[[ "$budget" =~ ^[1-9][0-9]*$ ]] || die "NOTARY_WAIT_SECONDS is whole seconds, got '$budget'"
deadline=$(($(date +%s) + budget))
[ ! -L "$state" ] || die "$state is a symlink: NOTARY_STATE_DIR must be a real directory"
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
  local id="$1" log="$2" record="$3"
  xcrun notarytool log "$id" "${notary_auth[@]}" 2>&1 | tee -a "$log" || true
  die "Apple rejected submission $id of $(basename "$target") (its log is above and in $log). Fix the build: the same code gets the same answer. To submit it again anyway, delete $record."
}

wait_for() {
  local id="$1" log="$2" record="$3" tries=0 out status left
  out="$(mktemp "${TMPDIR:-/tmp}/ac-notary-wait.XXXXXX")"
  while :; do
    left=$((deadline - $(date +%s)))
    [ "$left" -gt 0 ] || { rm -f "$out"; die "Apple hasn't finished $id within NOTARY_WAIT_SECONDS ($budget s); it's recorded in $record, so running this again waits on it instead of uploading"; }
    { xcrun notarytool wait "$id" "${notary_auth[@]}" --timeout "$left" 2>&1 || true; } | tee "$out"
    status="$(status_of "$out")"
    cat "$out" >> "$log"
    case "$status" in
      Accepted) break ;;
      Invalid | Rejected) rm -f "$out"; rejected "$id" "$log" "$record" ;;
    esac
    tries=$((tries + 1))
    [ "$tries" -lt 5 ] || { rm -f "$out"; die "notarytool kept failing while waiting on $id; it's recorded in $record, so running this again picks it up"; }
    left=$((deadline - $(date +%s)))
    [ "$left" -gt "$delay" ] || { rm -f "$out"; die "Apple hasn't finished $id within NOTARY_WAIT_SECONDS ($budget s); it's recorded in $record, so running this again waits on it instead of uploading"; }
    echo "notarytool wait ended without an answer ($(tail -1 "$out")); asking again ($tries/5)"
    sleep "$delay"
  done
  rm -f "$out"
}

resume() {
  local id="$1" log="$2" record="$3" attempt out status="" missing=0
  out="$(mktemp "${TMPDIR:-/tmp}/ac-notary-info.XXXXXX")"
  for attempt in 1 2 3; do
    if xcrun notarytool info "$id" "${notary_auth[@]}" >"$out" 2>&1; then status="$(status_of "$out")"; break; fi
    if grep -q "does not exist or does not belong to your team" "$out"; then missing=1; break; fi
    [ "$attempt" = 3 ] || sleep "$delay"
  done
  cat "$out" >> "$log"
  if [ -z "$status" ] && [ "$missing" = 0 ]; then
    cat "$out" >&2
    rm -f "$out"
    die "couldn't ask Apple about submission $id (above); it stays recorded in $record, so run this again once notarytool answers"
  fi
  rm -f "$out"
  case "$status" in
    Accepted) echo "Apple already accepted submission $id of this code" ;;
    "In Progress") echo "Submission $id of this code is still in Apple's queue; waiting on it instead of uploading again"; wait_for "$id" "$log" "$record" ;;
    Invalid | Rejected) rejected "$id" "$log" "$record" ;;
    *) echo "Apple doesn't know submission $id (status '${status:-none}'); submitting again"; return 1 ;;
  esac
}

place() {
  local tmp="$1" path="$2"
  [ ! -L "$path" ] || rm -f "$path"
  [ ! -e "$path" ] || [ -f "$path" ] || { rm -f "$tmp"; die "$path isn't a file: remove it"; }
  mv -f "$tmp" "$path"
  [ -f "$path" ] && [ ! -L "$path" ] || die "couldn't write $path"
}

record_id() {
  local id="$1" record="$2" tmp
  tmp="$(mktemp "$state/.record.XXXXXX")"
  printf '%s\n' "$id" > "$tmp"
  place "$tmp" "$record"
}

keep_payload() {
  local saved="$1" tmp
  tmp="$(mktemp "$state/.payload.XXXXXX")"
  cp "$target" "$tmp"
  place "$tmp" "$saved"
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
  record_id "$id" "$record"
  echo "Submission $id recorded in $record: a retry picks it up instead of uploading again"
  wait_for "$id" "$log" "$record"
}

notarize() {
  local file="$1" key="$2" saved="${3:-}" log record id=""
  log="$logs/notary-$(basename "$target").log"
  record="$state/$key"
  echo "Notarizing $(basename "$target") ($key)"
  : > "$log"
  if [ -f "$record" ] && [ ! -L "$record" ]; then
    id="$(head -c 64 "$record" | tr -d '[:space:]')"
    valid_id "$id" || { echo "ignoring $record: '$id' isn't a submission id"; id=""; }
  fi
  if [ -n "$id" ] && [ -n "$saved" ] && { [ ! -f "$saved" ] || [ -L "$saved" ]; }; then
    echo "no kept copy of the file submission $id was made from; submitting this one"
    id=""
  fi
  if [ -n "$id" ] && resume "$id" "$log" "$record"; then
    if [ -n "$saved" ]; then
      cp "$saved" "$target"
      echo "$(basename "$target") is now the copy submission $id was made from (the same app, packed in an earlier run)"
    fi
    if staple; then
      [ -z "$saved" ] || rm -f "$saved"
      return 0
    fi
    echo "Apple accepted $id but has no ticket for this file; submitting again"
  fi
  [ -z "$saved" ] || keep_payload "$saved"
  submit "$file" "$log" "$record"
  staple || die "stapler couldn't staple $(basename "$target") after Apple accepted it"
  [ -z "$saved" ] || rm -f "$saved"
}

cdhash_of() {
  local hash
  hash="$( { codesign -d -vvv "$1" 2>&1 || true; } | sed -n 's/^CDHash=//p' | head -1)"
  [[ "$hash" =~ ^[0-9a-f]{40,64}$ ]] && echo "$hash"
}

case "$target" in
  *.app)
    if xcrun stapler staple "$target" >/dev/null 2>&1; then
      echo "$(basename "$target") is already notarized (Apple has a ticket for this exact code): stapled, nothing uploaded"
      exit 0
    fi
    zip="$logs/notarize.zip"
    ditto -c -k --keepParent "$target" "$zip"
    if cdhash="$(cdhash_of "$target")"; then key="cdhash-$cdhash"; else key="sha256-$(sha256_of "$zip")"; fi
    notarize "$zip" "$key"
    rm -f "$zip"
    ;;
  *.dmg)
    if [ -n "$packed_app" ] && cdhash="$(cdhash_of "$packed_app")"; then
      notarize "$target" "dmg-of-cdhash-$cdhash" "$state/dmg-of-cdhash-$cdhash.dmg"
    else
      notarize "$target" "sha256-$(sha256_of "$target")"
    fi
    ;;
  *) die "$usage" ;;
esac
