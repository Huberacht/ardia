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
scratch=""
held_lock=""
trap '[ -z "$scratch" ] || rm -rf "$scratch"; [ -z "$held_lock" ] || rm -rf "$held_lock"' EXIT

started_at() { ps -o lstart= -p "$1" 2>/dev/null | sed 's/[[:space:]]*$//'; }

lock_key() {
  local lock="$state/$1.lock" attempt holder holder_start stale
  for attempt in 1 2 3; do
    if mkdir "$lock" 2>/dev/null; then
      printf '%s\n%s\n' "$$" "$(started_at $$)" > "$lock/holder"
      held_lock="$lock"
      return 0
    fi
    holder="$(sed -n 1p "$lock/holder" 2>/dev/null)"
    holder_start="$(sed -n 2p "$lock/holder" 2>/dev/null)"
    if [[ "$holder" =~ ^[0-9]+$ ]] && [ -n "$holder_start" ] && [ "$(started_at "$holder")" = "$holder_start" ]; then
      die "another notarize.sh (pid $holder) is working on $1 in $state; run one at a time"
    fi
    stale="$lock.stale.$$"
    if mv "$lock" "$stale" 2>/dev/null; then
      if [ "$(sed -n 1p "$stale/holder" 2>/dev/null)" = "$holder" ]; then rm -rf "$stale"; else mv "$stale" "$lock" 2>/dev/null || rm -rf "$stale"; fi
    fi
  done
  die "couldn't take the lock $lock"
}

sha256_of() {
  if command -v shasum >/dev/null; then shasum -a 256 "$1" | awk '{ print $1 }'; else sha256sum "$1" | awk '{ print $1 }'; fi
}

valid_id() { [[ "$1" =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; }

status_of() { awk '$1 == "status:" { sub(/^[[:space:]]*status:[[:space:]]*/, ""); print; exit }' "$1"; }

staple() {
  local path="${1:-$target}" attempt
  for attempt in 1 2 3 4 5; do
    xcrun stapler staple "$path" && return 0
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
    *)
      [ "$missing" = 1 ] || die "Apple answered '$status' about submission $id, which this script doesn't know; it stays recorded in $record, so nothing is uploaded again"
      echo "Apple doesn't know submission $id; submitting again"
      return 1
      ;;
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
  local id="$1" record="$2" kept="${3:-}" tmp
  tmp="$(mktemp "$state/.record.XXXXXX")"
  printf '%s\n' "$id" > "$tmp"
  [ -z "$kept" ] || printf '%s\n' "$kept" >> "$tmp"
  place "$tmp" "$record"
}

keep_payload() {
  local saved="$1" tmp
  tmp="$(mktemp "$state/.payload.XXXXXX")"
  cp "$target" "$tmp"
  place "$tmp" "$saved"
}

submit() {
  local file="$1" log="$2" record="$3" kept="${4:-}" id="" attempt out
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
  record_id "$id" "$record" "$kept"
  echo "Submission $id recorded in $record: a retry picks it up instead of uploading again"
  wait_for "$id" "$log" "$record"
}

team_of() { { codesign -d -vv "$1" 2>&1 || true; } | sed -n 's/^TeamIdentifier=//p' | head -1; }

kept_matches() {
  local saved="$1" expected="$2" team mnt ok=1
  team="$(team_of "$packed_app")"
  [[ "$team" =~ ^[A-Z0-9]{10}$ ]] || return 1
  codesign --verify --strict -R="anchor apple generic and certificate leaf[subject.OU] = \"$team\"" "$saved" >/dev/null 2>&1 || return 1
  mnt="$(mktemp -d "${TMPDIR:-/tmp}/ac-notary-kept.XXXXXX")"
  hdiutil attach "$saved" -readonly -nobrowse -noautoopen -noverify -mountpoint "$mnt" >/dev/null 2>&1 || { rmdir "$mnt"; return 2; }
  [ "$(cd "$mnt" && ls -A | sort | tr '\n' ' ')" = ".DS_Store .VolumeIcon.icns .background.tiff .fseventsd Applications Ardia.app " ] || ok=0
  [ "$(readlink "$mnt/Applications")" = /Applications ] || ok=0
  [ "$(cdhash_of "$mnt/Ardia.app")" = "$expected" ] || ok=0
  hdiutil detach "$mnt" >/dev/null 2>&1 || hdiutil detach "$mnt" -force >/dev/null 2>&1 || true
  rmdir "$mnt" 2>/dev/null || true
  [ "$ok" = 1 ]
}

notarize() {
  local file="$1" key="$2" saved="${3:-}" expected="${4:-}" log record id="" kept_sha=""
  log="$logs/notary-$(basename "$target").log"
  record="$state/$key"
  lock_key "$key"
  echo "Notarizing $(basename "$target") ($key)"
  : > "$log"
  if [ -f "$record" ] && [ ! -L "$record" ]; then
    id="$(head -c 4096 "$record" | sed -n 1p | tr -d '[:space:]')"
    kept_sha="$(head -c 4096 "$record" | sed -n 2p | tr -d '[:space:]')"
    valid_id "$id" || { echo "ignoring $record: '$id' isn't a submission id"; id=""; }
  fi
  if [ -n "$id" ] && [ -n "$saved" ]; then
    if [ ! -f "$saved" ] || [ -L "$saved" ]; then
      echo "no kept copy of the file submission $id was made from; submitting this one"
      id=""
    elif ! [[ "$kept_sha" =~ ^[0-9a-f]{64}$ ]] || [ "$(sha256_of "$saved")" != "$kept_sha" ]; then
      echo "the kept copy isn't the file $record names for submission $id (its sha256 differs); submitting this one"
      rm -f "$saved"
      id=""
    else
      local verdict=0
      kept_matches "$saved" "$expected" || verdict=$?
      if [ "$verdict" = 2 ]; then
        die "hdiutil couldn't mount $saved, the kept copy submission $id was made from, to check it; it and $record stay as they are, so run this again once it mounts"
      elif [ "$verdict" != 0 ]; then
        echo "the kept copy for submission $id isn't this app packed by this team (another app, another signer or other files); submitting this one"
        rm -f "$saved"
        id=""
      fi
    fi
  fi
  if [ -n "$id" ] && resume "$id" "$log" "$record"; then
    if [ -z "$saved" ]; then
      staple && return 0
    else
      local restored
      scratch="$(mktemp -d "$logs/.kept.XXXXXX")"
      restored="$scratch/$(basename "$target")"
      cp "$saved" "$restored"
      if staple "$restored"; then
        mv -f "$restored" "$target"
        rm -rf "$scratch"
        keep_stapled "$id" "$record" "$saved"
        echo "$(basename "$target") is now the copy submission $id was made from (the same app and packing inputs, packed in an earlier attempt)"
        return 0
      fi
      rm -rf "$scratch"
    fi
    die "Apple accepted submission $id, but stapler couldn't fetch its ticket for $(basename "$target") (above): run this again once Apple's ticket service answers. If the ticket really isn't this file's, delete $record to submit it fresh."
  fi
  local sent=""
  if [ -n "$saved" ]; then
    rm -f "$record"
    keep_payload "$saved"
    sent="$(sha256_of "$saved")"
  fi
  submit "$file" "$log" "$record" "$sent"
  staple || die "stapler couldn't staple $(basename "$target") after Apple accepted it"
  [ -z "$saved" ] || keep_stapled "$(sed -n 1p "$record")" "$record" "$saved"
}

keep_stapled() {
  local id="$1" record="$2" saved="$3"
  keep_payload "$saved"
  record_id "$id" "$record" "$(sha256_of "$saved")"
  find "$state" -maxdepth 1 -type f -name 'dmg-of-*.dmg' ! -path "$saved" -mtime +3 -exec rm -f {} + 2>/dev/null || true
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
    packing_of() {
      local input digest inputs
      inputs="$(basename "$target")"$'\n'"$(git -C "$root" rev-parse HEAD 2>/dev/null || echo none)"$'\n'"chunk ${ARDIA_DMG_CHUNK:-on}"
      for input in scripts/release/package.sh scripts/dmg/background.tiff scripts/dmg/DS_Store; do
        if [ -f "$root/$input" ]; then
          digest="$(sha256_of "$root/$input")" && [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || return 1
          inputs+=$'\n'"$input $digest"
        else
          inputs+=$'\n'"$input missing"
        fi
      done
      digest="$(printf '%s\n' "$inputs" | { if command -v shasum >/dev/null; then shasum -a 256; else sha256sum; fi; } | cut -c1-16)" && [[ "$digest" =~ ^[0-9a-f]{16}$ ]] || return 1
      echo "$digest"
    }
    if [ -n "$packed_app" ] && cdhash="$(cdhash_of "$packed_app")" && packing="$(packing_of)"; then
      key="dmg-of-cdhash-$cdhash-packing-$packing"
      notarize "$target" "$key" "$state/$key.dmg" "$cdhash"
    else
      notarize "$target" "sha256-$(sha256_of "$target")"
    fi
    ;;
  *) die "$usage" ;;
esac
