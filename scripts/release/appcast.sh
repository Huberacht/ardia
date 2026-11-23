#!/usr/bin/env bash
set -euo pipefail

usage="usage: SPARKLE_BIN=<dir> SPARKLE_KEY_FILE=<file> [APPCAST_DELTAS=<count, default 3>] scripts/release/appcast.sh <dist> <version> <headline> <notes body file> <published appcast or empty file> [<phased rollout seconds>]"
dist="${1:?$usage}"
version="${2:?$usage}"
headline="${3:?$usage}"
body="${4:?$usage}"
base_feed="${5:?$usage}"
phased="${6:-}"
sparkle="${SPARKLE_BIN:?$usage}"
key="${SPARKLE_KEY_FILE:?$usage}"
delta_count="${APPCAST_DELTAS:-3}"
. "$(dirname "$0")/lib.sh"
case "$delta_count" in '' | *[!0-9]*) die "APPCAST_DELTAS is a whole number of deltas, got '$delta_count'" ;; esac

annotate() {
  local level="$1"
  shift
  if [ -n "${GITHUB_ACTIONS:-}" ]; then echo "::$level::$*"; else echo "$level: $*" >&2; fi
}
summary() { [ -z "${GITHUB_STEP_SUMMARY:-}" ] || echo "- $*" >> "$GITHUB_STEP_SUMMARY"; }
size_of() { wc -c < "$1" | tr -d ' '; }

echo "==> Appcast"
channel="$(channel_of "$version")"
zip="$dist/Ardia-$version.zip"
download_prefix="$REPO_URL/releases/download/v$version/"
updates="$dist/updates"
rm -rf "$updates" "$updates.home"
rm -f "$dist"/*.delta "$dist/appcast.built.xml"
mkdir -p "$updates" "$updates.home"
cp "$zip" "$updates/"
{ printf '**%s**\n\n' "$headline"; cat "$body"; } > "$updates/Ardia-$version.md"

wanted=0
bases=()
fetch_deadline=$((SECONDS + ${APPCAST_DELTA_FETCH_SECONDS:-1800}))
if [ "$delta_count" = 0 ]; then
  annotate warning "APPCAST_DELTAS=0: $version ships without Sparkle deltas, so every update downloads the whole zip"
elif [ ! -s "$base_feed" ]; then
  echo "note: no published appcast to build deltas from: $version ships without them"
else
  base_lines="$(appcast delta-bases "$base_feed" "$version" "$delta_count")" || die "couldn't read the published appcast for the zips to build deltas from"
  while read -r base_build base_url base_length base_signature; do
    [ -n "$base_build" ] || continue
    wanted=$((wanted + 1))
    base_zip="$updates/${base_url##*/}"
    fetched=0
    for attempt in 1 2 3; do
      budget=$((fetch_deadline - SECONDS))
      [ "$budget" -ge 30 ] || break
      if curl -fsSL --connect-timeout 20 --max-time "$budget" -o "$base_zip" "$base_url"; then
        fetched=1
        break
      fi
      [ "$attempt" = 3 ] || [ $((fetch_deadline - SECONDS)) -lt 35 ] || sleep 5
    done
    if [ "$fetched" = 0 ]; then
      if [ $((fetch_deadline - SECONDS)) -lt 30 ]; then
        annotate warning "out of time for earlier zips (APPCAST_DELTA_FETCH_SECONDS): no delta from build $base_build"
      else
        annotate warning "couldn't download build $base_build ($base_url) to build a delta from"
      fi
      rm -f "$base_zip"
      continue
    fi
    if [ "$(size_of "$base_zip")" != "$base_length" ] \
      || ! "$sparkle/sign_update" --verify --ed-key-file "$key" "$base_zip" "$base_signature" >/dev/null 2>&1; then
      annotate warning "build $base_build's zip ($base_url) doesn't match the length and EdDSA signature the published appcast lists: no delta from it"
      rm -f "$base_zip"
      continue
    fi
    bases+=("$base_build")
  done <<<"$base_lines"
fi

phased_args=()
[ -n "$phased" ] && phased_args=(--phased-rollout-interval "$phased")
[ "$channel" = nightly ] && phased_args+=(--channel nightly)
HOME="$updates.home" CFFIXED_USER_HOME="$updates.home" \
  "$sparkle/generate_appcast" --ed-key-file "$key" ${phased_args[@]+"${phased_args[@]}"} \
  --maximum-deltas "${#bases[@]}" \
  --download-url-prefix "$download_prefix" \
  --embed-release-notes --full-release-notes-url "$RELEASE_NOTES_URL" \
  --link "$REPO_URL" -o "$updates/appcast.xml" "$updates"
appcast only "$updates/appcast.xml" "$version" "$updates/built.xml"
if [ -s "$base_feed" ]; then
  appcast merge "$base_feed" "$updates/built.xml" "$version" "$dist/appcast.xml"
else
  mv "$updates/built.xml" "$dist/appcast.xml"
fi
appcast item "$dist/appcast.xml" "$version" >/dev/null || die "appcast.xml has no single item for $version"

zip_size="$(size_of "$zip")"
made=()
delta_lines="$(appcast deltas "$dist/appcast.xml" "$version")" || die "couldn't read $version's deltas from appcast.xml"
while read -r from url length signature; do
  [ -n "$from" ] || continue
  name="${url##*/}"
  file="$updates/$name"
  [ "$url" = "$download_prefix$name" ] || die "the delta from build $from points at $url, not at v$version's release"
  [[ "$name" =~ ^[A-Za-z0-9._-]+\.delta$ ]] || die "the delta from build $from is named $name, not <app><build>-<build>.delta"
  [ -f "$file" ] || die "the appcast lists $name, but generate_appcast didn't write it"
  [ "$signature" != - ] || die "$name has no sparkle:edSignature in the appcast"
  [[ "$length" =~ ^[0-9]+$ ]] && [ "$length" = "$(size_of "$file")" ] || die "the appcast's length for $name is $length, the file is $(size_of "$file")"
  [ "$length" -gt 0 ] && [ "$length" -lt "$zip_size" ] || die "$name is $length bytes, not smaller than the $zip_size-byte zip"
  "$sparkle/sign_update" --verify --ed-key-file "$key" "$file" "$signature" >/dev/null 2>&1 \
    || die "$name's EdDSA signature in the appcast doesn't verify"
  mv "$file" "$dist/$name"
  made+=("$from")
done <<<"$delta_lines"

if [ "${#made[@]}" -gt 0 ]; then
  echo "PASS  ${#made[@]} signed Sparkle delta(s) for $version, from build(s) ${made[*]}"
  summary "Sparkle deltas: ${#made[@]} (from builds ${made[*]})"
  [ "${#made[@]}" -ge "${#bases[@]}" ] || echo "note: ${#bases[@]} earlier build(s) were there (${bases[*]}); generate_appcast skips a delta that isn't smaller than the zip"
elif [ "${#bases[@]}" -gt 0 ]; then
  annotate warning "generate_appcast made no delta for $version from build(s) ${bases[*]}: every update downloads the whole zip"
  summary "Sparkle deltas: none, although builds ${bases[*]} were there to build them from"
elif [ "$wanted" -gt 0 ]; then
  annotate warning "none of the $wanted earlier zips to build deltas from could be used (above): $version ships without deltas"
  summary "Sparkle deltas: none (the earlier zips couldn't be downloaded or verified)"
else
  summary "Sparkle deltas: none (no earlier $channel release to build them from)"
fi
rm -rf "$updates" "$updates.home"
