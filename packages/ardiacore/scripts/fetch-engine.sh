#!/bin/bash
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../../.." && pwd)
repo=${ARDIACORE_PREBUILT_REPO:-ardia-browser/ardia}
assets=${ARDIACORE_PREBUILT_ASSETS:-https://github.com/$repo/releases/download}
table="$here/../prebuilt-engines.tsv"
store="$root/apps/browser/build-ardiacore/prebuilt"
name="Chromium Framework"
die() { echo "error: $*" >&2; exit 1; }

if [ "${1:-}" = --arch ]; then
  case "${2:-}" in
    linux-x86_64) shift 2; exec "$root/scripts/linux/fetch-engine.sh" "$@" ;;
    *) die "usage: fetch-engine.sh [--nearest] | fetch-engine.sh --arch linux-x86_64 [--nearest]" ;;
  esac
fi

nearest=0 describe=0
offline=0
for arg in "$@"; do
  case "$arg" in
    --nearest) nearest=1 ;;
    --describe) describe=1 ;;
    --offline) offline=1 ;;
    *) die "usage: fetch-engine.sh [--nearest] [--describe [--offline]]" ;;
  esac
done
[ "$offline" = 0 ] || [ "$describe" = 1 ] || die "--offline only goes with --describe"
match_script="$here/engine-match.sh"

key_script="$root/engine/engine-key.sh"
key() { "$key_script" --platform macos "$@"; }
git -C "$root" rev-parse --git-dir >/dev/null 2>&1 || die "$root isn't a git checkout: a prebuilt engine is matched to its engine key (engine/engine-key.sh --platform macos)"
key_paths=($(key --paths))
dirty=$(git -C "$root" status --porcelain -- "${key_paths[@]}" | cut -c4- | awk 'NR <= 5' | paste -sd ',' - | sed 's/,/, /g')
[ -z "$dirty" ] || die "$dirty (in the macOS engine key) have uncommitted changes, and no prebuilt has them: build the engine (docs/engine-build.md)"
tree=$(key)

remote_table=""
lookup() {
  local line
  [ -n "$1" ] || return 0
  line=$(awk -v t="$1" '$1 == t { print; exit }' "$table" 2>/dev/null || true)
  if [ -z "$line" ] && [ "$offline" = 0 ]; then
    [ -n "$remote_table" ] || remote_table=$(curl -fsL --retry 2 --max-time 30 "https://raw.githubusercontent.com/$repo/main/packages/ardiacore/prebuilt-engines.tsv" || echo "#")
    line=$(awk -v t="$1" '$1 == t { print; exit }' <<<"$remote_table")
  fi
  echo "$line"
}
release_tag() {
  case "$1" in engine-*) echo "$1" ;; *) echo "v$1" ;; esac
}
published_source() {
  local tag=$1 key=$2 known listed
  known=$(cat "$store/${key:0:12}/engine-match" 2>/dev/null || true)
  if [ "$("$match_script" get key "$known")" = "$key" ] && [ -n "$("$match_script" get source "$known")" ] && [ -n "$("$match_script" get public_hash "$known")" ]; then
    "$match_script" get source "$known"
    return 0
  fi
  if git -C "$root" rev-parse -q --verify "refs/tags/$tag^{commit}" 2>/dev/null; then return 0; fi
  [ "$offline" = 0 ] || return 0
  listed=$(GIT_TERMINAL_PROMPT=0 git -c http.lowSpeedLimit=1 -c http.lowSpeedTime=20 ls-remote \
    "${ARDIACORE_ENGINE_TAG_REMOTE:-https://github.com/$repo.git}" "refs/tags/$tag" "refs/tags/$tag^{}" 2>/dev/null || true)
  awk -v deref="refs/tags/$tag^{}" -v tag="refs/tags/$tag" '$2 == deref { d = $1 } $2 == tag { t = $1 } END { print (d != "" ? d : t) }' <<<"$listed"
}

entry=$(lookup "$tree")
match=exact
base=$(git -C "$root" rev-list -1 HEAD -- "${key_paths[@]}" 2>/dev/null || true)
if [ -z "$entry" ] && [ "$offline" = 1 ]; then
  echo "match=unknown key=$tree"
  exit 0
fi
if [ -z "$entry" ]; then
  skipped=0 found=""
  while read -r commit; do
    candidate_key=$(key "$commit" 2>/dev/null || true)
    [ "$candidate_key" != "$tree" ] || continue
    candidate=$(lookup "$candidate_key")
    if [ -n "$candidate" ]; then found=$candidate base=$commit; break; fi
    skipped=$((skipped + 1))
    [ "$skipped" -lt 200 ] || break
  done < <(git -C "$root" rev-list HEAD -- "${key_paths[@]}")
  [ -n "$found" ] || die "no prebuilt engine for this checkout or any earlier one: build the engine (docs/engine-build.md)"
  version=$(awk '{ print $2 }' <<<"$found")
  if [ "$nearest" = 0 ]; then
    die "no prebuilt engine for this checkout's engine key ($skipped engine commits since $version's). Check out \
$(release_tag "$version"), or run packages/ardiacore/scripts/fetch-engine.sh --nearest to build against \
$version's engine anyway, or build the engine"
  fi
  match=nearest
  if [ "$("$match_script" public-hash "$root" "$base")" = "$("$match_script" public-hash "$root")" ]; then
    echo "warning: using $version's engine; the engine's sources changed in $skipped commits since, and the app may not match it" >&2
  else
    echo "warning: using $version's engine; the engine's sources changed in $skipped commits since, engine/ardiacore/src/ardia/core/public among them, so the app build stops unless ARDIACORE_ALLOW_PUBLIC_MISMATCH=1" >&2
  fi
  entry=$found
fi
read -r tree version sha built <<<"$entry"
built=${built:-$tree}
short=${tree:0:12}
dest="$store/$short"
match_line="match=$match key=$tree version=$version source=$(published_source "$(release_tag "$version")" "$tree") public_hash=$("$match_script" public-hash "$root" "$base")"
if [ "$describe" = 1 ]; then
  echo "$match_line"
  exit 0
fi
if [ ! -f "$dest/.complete" ]; then
  file="ArdiaCore-${built:0:12}.tar.xz"
  url="$assets/$(release_tag "$version")/$file"
  tmp="$store/.tmp-$$"
  rm -rf "$tmp" && mkdir -p "$tmp"
  trap 'rm -rf "$tmp"' EXIT
  echo "downloading the engine from $version ($url)" >&2
  curl -fL --retry 3 --progress-bar -o "$tmp/$file" "$url" || die "couldn't download $url"
  [ "$(shasum -a 256 "$tmp/$file" | awk '{ print $1 }')" = "$sha" ] || die "$file doesn't match its SHA-256 in prebuilt-engines.tsv"
  tar -xJf "$tmp/$file" -C "$tmp" || die "couldn't unpack $file"
  [ -f "$tmp/$name.framework/Versions/Current/$name" ] || die "$file holds no $name.framework"
  rm -f "$tmp/$file"
  touch "$tmp/.complete"
  rm -rf "$dest"
  mv "$tmp" "$dest"
  trap - EXIT
  for old in "$store"/*/; do
    [ "${old%/}" = "$dest" ] || rm -rf "${old%/}"
  done
fi
if [ "$(cat "$dest/engine-match" 2>/dev/null)" != "$match_line" ]; then
  echo "$match_line" >"$dest/engine-match.tmp-$$"
  mv "$dest/engine-match.tmp-$$" "$dest/engine-match"
fi
echo "$dest/$name.framework"
