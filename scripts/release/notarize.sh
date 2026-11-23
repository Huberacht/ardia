#!/usr/bin/env bash
set -euo pipefail

usage="usage: scripts/release/notarize.sh <Ardia.app or .dmg> <log dir> [<the Ardia.app the .dmg packs>]  (notarizes it and staples the ticket to it; NOTARY_STATE_DIR keeps submission ids across retries, default dist/.notary, one run at a time; NOTARY_WAIT_SECONDS caps the time spent polling Apple, default 14400; NOTARY_LOCK_SECONDS caps the wait for another run's lock, default 600)"
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
staged=""
trap '[ -z "$scratch" ] || rm -rf "$scratch"; [ -z "$staged" ] || rm -f "$staged"' EXIT

lock_wait="${NOTARY_LOCK_SECONDS:-600}"
[[ "$lock_wait" =~ ^[0-9]+$ ]] || die "NOTARY_LOCK_SECONDS is whole seconds, got '$lock_wait'"
[ ! -L "$state/.lock" ] || die "$state/.lock is a symlink"
exec 9>>"$state/.lock"
perl -MFcntl=:flock -e 'open(my $fh, ">&=", 9) or die "fd 9: $!\n"; my $end = time + $ARGV[0]; until (flock($fh, LOCK_EX | LOCK_NB)) { exit 1 if time >= $end; select(undef, undef, undef, 0.25); } exit 0;' "$lock_wait" \
  || die "another notarize.sh holds $state/.lock (waited $lock_wait s, NOTARY_LOCK_SECONDS); run one at a time per state directory"

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

write_record() {
  local record="$1" id="$2" digest="${3:-}" complete="${4:-}" tmp
  tmp="$(mktemp "$state/.record.XXXXXX")"
  printf '%s\n' "$id" > "$tmp"
  [ -z "$digest" ] || printf '%s\n' "$digest" >> "$tmp"
  [ -z "$complete" ] || printf '%s\n' "$complete" >> "$tmp"
  place "$tmp" "$record"
}

read_record() {
  rec_id="" rec_digest="" rec_complete=""
  [ -f "$1" ] && [ ! -L "$1" ] || return 0
  rec_id="$(head -c 4096 "$1" | sed -n 1p | tr -d '[:space:]')"
  rec_digest="$(head -c 4096 "$1" | sed -n 2p | tr -d '[:space:]')"
  rec_complete="$(head -c 4096 "$1" | sed -n 3p | tr -d '[:space:]')"
  valid_id "$rec_id" || { [ -z "$rec_id" ] || echo "ignoring $1: '$rec_id' isn't a submission id"; rec_id=""; }
  [[ "$rec_digest" =~ ^[0-9a-f]{64}$ ]] || rec_digest=""
}

submit() {
  local file="$1" log="$2" attempt out
  submitted_id=""
  out="$(mktemp "${TMPDIR:-/tmp}/ac-notary-submit.XXXXXX")"
  for attempt in 1 2 3; do
    if xcrun notarytool submit "$file" "${notary_auth[@]}" | tee "$out"; then
      submitted_id="$(awk '$1 == "id:" { print $2; exit }' "$out")"
    fi
    cat "$out" >> "$log"
    valid_id "$submitted_id" && break
    submitted_id=""
    [ "$attempt" = 3 ] || { echo "notarytool submit failed (attempt $attempt), likely an upload cut off; submitting again"; sleep "$delay"; }
  done
  rm -f "$out"
  [ -n "$submitted_id" ] || die "notarytool couldn't submit $(basename "$file") (3 attempts)"
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

notarize_app() {
  local zip="$1" key="$2" log record
  log="$logs/notary-$(basename "$target").log"
  record="$state/$key"
  echo "Notarizing $(basename "$target") ($key)"
  : > "$log"
  read_record "$record"
  if [ -n "$rec_id" ] && resume "$rec_id" "$log" "$record"; then
    staple && return 0
    die "Apple accepted submission $rec_id, but stapler couldn't fetch its ticket for $(basename "$target") (above): run this again once Apple's ticket service answers. If the ticket really isn't this app's, delete $record to submit it fresh."
  fi
  submit "$zip" "$log"
  write_record "$record" "$submitted_id"
  echo "Submission $submitted_id recorded in $record: a retry picks it up instead of uploading again"
  wait_for "$submitted_id" "$log" "$record"
  staple || die "stapler couldn't staple $(basename "$target") after Apple accepted it"
}

deliver() {
  local image="$1" copy
  scratch="$(mktemp -d "$logs/.kept.XXXXXX")"
  copy="$scratch/$(basename "$target")"
  cp "$image" "$copy"
  staple "$copy" || { rm -rf "$scratch"; scratch=""; return 1; }
  mv -f "$copy" "$target"
  rm -rf "$scratch"
  scratch=""
}

notarize_dmg() {
  local key="$1" expected="${2:-}" log record digest kept="" image previous=""
  log="$logs/notary-$(basename "$target").log"
  record="$state/$key"
  echo "Notarizing $(basename "$target") ($key)"
  : > "$log"
  staged="$(mktemp "$state/.staged.XXXXXX")"
  cp "$target" "$staged"
  digest="$(sha256_of "$staged")"
  read_record "$record"
  if [ -n "$rec_id" ] && [ -z "$rec_digest" ] && [ "$key" = "sha256-$digest" ]; then rec_digest="$digest"; fi
  if [ -n "$rec_id" ] && [ -n "$rec_digest" ]; then
    previous="$state/$key.$rec_digest.dmg"
    for candidate in "$previous" "$state/$key.dmg"; do
      if [ -f "$candidate" ] && [ ! -L "$candidate" ] && [ "$(sha256_of "$candidate")" = "$rec_digest" ]; then kept="$candidate"; break; fi
    done
    if [ -z "$kept" ] && [ "$digest" = "$rec_digest" ]; then kept="$staged"; fi
  fi
  if [ -n "$kept" ] && [ -n "$expected" ]; then
    local verdict=0
    kept_matches "$kept" "$expected" || verdict=$?
    if [ "$verdict" = 2 ]; then
      die "hdiutil couldn't mount $kept, the copy submission $rec_id was made from, to check it; it and $record stay as they are, so run this again once it mounts"
    elif [ "$verdict" != 0 ]; then
      echo "the kept copy for submission $rec_id isn't this app packed by this team (another app, another signer or other files); submitting this one"
      [ "$kept" = "$staged" ] || rm -f "$kept"
      kept=""
    fi
  fi
  if [ -n "$rec_id" ] && [ -z "$kept" ]; then
    echo "no kept copy is the file $record names for submission $rec_id (missing, or its sha256 differs); submitting this one"
  elif [ -n "$kept" ] && resume "$rec_id" "$log" "$record"; then
    deliver "$kept" || die "Apple accepted submission $rec_id, but stapler couldn't fetch its ticket (above): run this again once Apple's ticket service answers; $record and its copy stay. If the ticket really isn't that file's, delete $record to submit it fresh."
    write_record "$record" "$rec_id" "$rec_digest" complete
    echo "$(basename "$target") is now the copy submission $rec_id was made from (sha256 ${rec_digest:0:12}), stapled"
    return 0
  fi
  image="$state/$key.$digest.dmg"
  if [ -f "$image" ] && [ ! -L "$image" ] && [ "$(sha256_of "$image")" = "$digest" ]; then
    rm -f "$staged"
  else
    place "$staged" "$image"
  fi
  staged=""
  submit "$image" "$log"
  write_record "$record" "$submitted_id" "$digest"
  echo "Submission $submitted_id of $(basename "$image") recorded in $record: a retry picks it up instead of uploading again"
  for old in "$previous" "$state/$key.dmg"; do
    if [ -n "$old" ] && [ "$old" != "$image" ]; then rm -f "$old"; fi
  done
  wait_for "$submitted_id" "$log" "$record"
  deliver "$image" || die "stapler couldn't staple $(basename "$target") after Apple accepted it; $record and its copy stay, so run this again"
  write_record "$record" "$submitted_id" "$digest" complete
}

prune_kept() {
  local current="$1" image name key digest
  for image in "$state"/*.dmg; do
    [ -f "$image" ] && [ ! -L "$image" ] || continue
    [ -n "$(find "$image" -mtime +3 -print 2>/dev/null)" ] || continue
    name="$(basename "$image" .dmg)"
    if [[ "$name" =~ ^(.+)\.([0-9a-f]{64})$ ]]; then key="${BASH_REMATCH[1]}" digest="${BASH_REMATCH[2]}"; else key="$name" digest=""; fi
    [ "$key" != "$current" ] || continue
    read_record "$state/$key"
    if [ -n "$rec_id" ] && { [ -z "$digest" ] || [ "$digest" = "$rec_digest" ]; } && [ "$rec_complete" != complete ]; then continue; fi
    rm -f "$image"
  done
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
    notarize_app "$zip" "$key"
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
      dmg_key="dmg-of-cdhash-$cdhash-packing-$packing"
      notarize_dmg "$dmg_key" "$cdhash"
    else
      dmg_key="sha256-$(sha256_of "$target")"
      notarize_dmg "$dmg_key"
    fi
    prune_kept "$dmg_key"
    ;;
  *) die "$usage" ;;
esac
