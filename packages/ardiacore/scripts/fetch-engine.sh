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
    *) die "usage: fetch-engine.sh [--nearest] [--describe] | fetch-engine.sh --arch linux-x86_64 [--nearest]" ;;
  esac
fi

nearest=0 describe=0
for arg in "$@"; do
  case "$arg" in
    --nearest) nearest=1 ;;
    --describe) describe=1 ;;
    *) die "usage: fetch-engine.sh [--nearest] [--describe]" ;;
  esac
done
public_dir=engine/ardiacore/src/ardia/core/public

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
  if [ -z "$line" ]; then
    [ -n "$remote_table" ] || remote_table=$(curl -fsL --retry 2 "https://raw.githubusercontent.com/$repo/main/packages/ardiacore/prebuilt-engines.tsv" || echo "#")
    line=$(awk -v t="$1" '$1 == t { print; exit }' <<<"$remote_table")
  fi
  echo "$line"
}
release_tag() {
  case "$1" in engine-*) echo "$1" ;; *) echo "v$1" ;; esac
}

entry=$(lookup "$tree")
match=exact
source_commit=$(git -C "$root" rev-list -1 HEAD -- "${key_paths[@]}" 2>/dev/null || true)
public=same
if [ -z "$entry" ]; then
  skipped=0 found=""
  while read -r commit; do
    candidate_key=$(key "$commit" 2>/dev/null || true)
    [ "$candidate_key" != "$tree" ] || continue
    candidate=$(lookup "$candidate_key")
    if [ -n "$candidate" ]; then found=$candidate source_commit=$commit; break; fi
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
  [ -z "$(git -C "$root" diff --no-renames --name-only "$source_commit" HEAD -- "$public_dir")" ] || public=changed
  if [ "$public" = same ]; then
    echo "warning: using $version's engine; the engine's sources changed in $skipped commits since, and the app may not match it" >&2
  else
    echo "warning: using $version's engine; the engine's sources changed in $skipped commits since, $public_dir among them, so the app build stops unless ARDIACORE_ALLOW_PUBLIC_MISMATCH=1" >&2
  fi
  entry=$found
fi
read -r tree version sha built <<<"$entry"
built=${built:-$tree}
short=${tree:0:12}
dest="$store/$short"
match_line="match=$match key=$tree version=$version source=$source_commit public=$public"
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
