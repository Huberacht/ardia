#!/usr/bin/env bash
# Publishes one Windows build as the update the app offers, on the GitHub prerelease windows-alpha (never latest): its
# two installers under this build's own names (Ardia-Setup-<cpu>-<build>.exe), the engine's source, then the signed feed
# windows-update.json and its raw 64-byte Ed25519 signature windows-update.json.sig, then the same installers under the
# names people download (Ardia-Setup-<cpu>.exe). The feed only ever names files that are already there and never change.
# The build before this one keeps its files, so an update the app offered from the last feed can still be downloaded;
# older builds' files go last.
#
#   scripts/windows/publish-alpha.sh [--dry-run] [--out <dir>] [--key <pem>] [--public-key <pem>] [--verify-bin <bin>] <Windows workflow run id>
#   scripts/windows/publish-alpha.sh [--dry-run] [--out <dir>] [--key <pem>] [--public-key <pem>] [--verify-bin <bin>] [--commit <rev>] --installers <dir>
#   scripts/windows/publish-alpha.sh -h | --help
#
# A run id publishes the Ardia-Setup-x64 and Ardia-Setup-arm64 artifacts of a green Windows workflow run, as an alpha.
# --installers publishes a release's Windows files, as the Release workflow does after it publishes v<version>:
# Ardia-<version>-windows-<cpu>-setup.exe for x64 and arm64, Ardia-<version>-windows-source.tar.xz, their .sha256
# files and Ardia.build.json, as the Windows workflow leaves them in its windows-release-* artifacts when it runs with a
# version. They were built at --commit (default HEAD). A run id's source is packed here by engine-source.sh, from the
# engine its commit pins; a release's is the archive it already carries.
# The version and build come from Ardia.build.json, the identity the build carries. The build is the number of
# commits in the built commit's history, so a release outranks every build before it. A build below the live
# feed's is refused, and a build equal to the live feed's is refused unless the live feed's windows-update.json.sig
# is missing or invalid (allowing a retry to repair a partial publish).
# Signing uses --key <pem> (or WINDOWS_UPDATE_KEY_FILE / WINDOWS_UPDATE_ED_PRIVATE_KEY), refused if its public half
# doesn't match --public-key (default scripts/windows/windows-update.pem), and self-verifies windows-update.json,
# windows-update.json.sig and both installers with ardia-update-verify before uploading windows-update.json.sig and
# then windows-update.json sequentially. A live publish without a signing key fails closed. --dry-run downloads,
# packs and signs into <dir> (default dist/windows-alpha-<build>, which must not hold files yet), using an ephemeral
# test key when no signing key is provided, prints the gh commands and publishes nothing.
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd -P)"
repo="ardia-browser/ardia"
tag="windows-alpha"
published="https://github.com/$repo/releases/download/$tag"
published_under="https://github.com/$repo/releases/download/"
die() { echo "error: $*" >&2; exit 1; }
dry=0 out="" run_id="" installers="" commit_rev="" key_file="${WINDOWS_UPDATE_KEY_FILE:-}" public_key="$root/scripts/windows/windows-update.pem" verify_bin=""
while [ $# -gt 0 ]; do
  case "$1" in
    -h | --help) awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"; exit 0 ;;
    --dry-run) dry=1 ;;
    --out) out="${2:?--out takes a directory}"; shift ;;
    --installers) installers="${2:?--installers takes a directory}"; shift ;;
    --commit) commit_rev="${2:?--commit takes a revision}"; shift ;;
    --key) key_file="${2:?--key takes a PEM file}"; shift ;;
    --public-key) public_key="${2:?--public-key takes a PEM file}"; shift ;;
    --verify-bin) verify_bin="${2:?--verify-bin takes an executable path}"; shift ;;
    -*) die "unknown option $1 (--help)" ;;
    *) run_id="$1" ;;
  esac
  shift
done
[ -n "$run_id" ] || [ -n "$installers" ] || die "which Windows workflow run, or which --installers folder? (--help)"
[ -z "$run_id" ] || [ -z "$installers" ] || die "a run id or --installers, not both"
[ -z "$commit_rev" ] || [ -n "$installers" ] || die "--commit goes with --installers; a run names its own commit"
run() {
  printf '+'; printf ' %q' "$@"; echo
  [ "$dry" = 1 ] || "$@"
}
identity() {
  python3 -I - "$1" <<'PY'
import json, re, sys
try:
    with open(sys.argv[1]) as file:
        stamped = json.load(file)
except (OSError, ValueError) as error:
    sys.exit(f"error: {sys.argv[1]}: {error}")
version = stamped.get("version") if isinstance(stamped, dict) else None
build = stamped.get("build") if isinstance(stamped, dict) else None
if not isinstance(version, str) or not re.fullmatch(r"[0-9A-Za-z][0-9A-Za-z.+-]{0,63}", version) or type(build) is not int or build < 1:
    sys.exit(f"error: {sys.argv[1]} names no version and build")
print(f"{version}\t{build}")
PY
}
sha256_of() {
  python3 -I - "$1" <<'PY'
import hashlib, sys
digest = hashlib.sha256()
with open(sys.argv[1], "rb") as file:
    for block in iter(lambda: file.read(1 << 20), b""):
        digest.update(block)
print(digest.hexdigest())
PY
}
resolve_verifier() {
  if [ -n "$verify_bin" ]; then
    [ -x "$verify_bin" ] || die "--verify-bin $verify_bin is not executable"
    printf '%s\n' "$verify_bin"
    return
  fi
  local target_dir="${CARGO_TARGET_DIR:-$root/packages/core-rs/target}"
  local candidate="$target_dir/release/ardia-update-verify"
  if [ ! -x "$candidate" ]; then
    PATH="$PATH:$HOME/.cargo/bin" command -v cargo >/dev/null || die "cargo or --verify-bin is required to self-verify windows-update.json"
    (cd "$root/packages/core-rs" && PATH="$PATH:$HOME/.cargo/bin" cargo build --locked --release --quiet -p ardia-update-verify)
  fi
  [ -x "$candidate" ] || die "couldn't build ardia-update-verify at $candidate"
  printf '%s\n' "$candidate"
}

stage="$(mktemp -d "${TMPDIR:-/tmp}/ardia-windows-alpha.XXXXXX")"
stage="$(cd "$stage" && pwd -P)"
trap 'rm -rf "$stage"' EXIT

if [ -z "$key_file" ] && [ -n "${WINDOWS_UPDATE_ED_PRIVATE_KEY:-}" ]; then
  key_file="$stage/windows-update-key.pem"
  install -m 600 /dev/null "$key_file"
  printf '%s\n' "$WINDOWS_UPDATE_ED_PRIVATE_KEY" >"$key_file"
fi
if [ -z "$key_file" ] && [ "$dry" != 1 ]; then
  die "a signing key is required to publish (--key, WINDOWS_UPDATE_KEY_FILE or WINDOWS_UPDATE_ED_PRIVATE_KEY)"
fi

if [ -n "$run_id" ]; then
  info="$(gh run view "$run_id" -R "$repo" --json workflowName,conclusion,headSha -q '[.workflowName, .conclusion, .headSha] | @tsv')"
  IFS=$'\t' read -r workflow conclusion commit <<<"$info"
  [ "$workflow" = Windows ] || die "run $run_id is the $workflow workflow, not Windows"
  [ "$conclusion" = success ] || die "run $run_id ended $conclusion: only a green run is published"
  git -C "$root" cat-file -e "$commit^{commit}" 2>/dev/null || git -C "$root" fetch -q origin "$commit" || die "commit $commit of run $run_id isn't in this checkout"
  echo "==> Download the installers of run $run_id ($commit)"
  for cpu in x64 arm64; do
    gh run download "$run_id" -R "$repo" -n "Ardia-Setup-$cpu" -D "$stage/artifact-$cpu"
    [ -f "$stage/artifact-$cpu/Ardia-Setup-$cpu.exe" ] || die "the Ardia-Setup-$cpu artifact holds no Ardia-Setup-$cpu.exe"
    [ -f "$stage/artifact-$cpu/Ardia.build.json" ] || die "the Ardia-Setup-$cpu artifact holds no Ardia.build.json: run $run_id predates it, so publish a newer run"
    mv "$stage/artifact-$cpu/Ardia-Setup-$cpu.exe" "$stage/Ardia-Setup-$cpu.exe"
  done
  stamped="$(identity "$stage/artifact-x64/Ardia.build.json")"
  [ "$stamped" = "$(identity "$stage/artifact-arm64/Ardia.build.json")" ] || die "run $run_id's x64 and arm64 installers carry different builds"
  IFS=$'\t' read -r version build <<<"$stamped"
  about="Ardia for Windows, alpha build $build ($version, commit $commit). For testing: expect rough edges."
  status="What works and what is known not to: https://github.com/$repo/blob/main/docs/windows.md"
else
  [ -d "$installers" ] || die "--installers $installers is not a folder"
  commit="$(git -C "$root" rev-parse --verify "${commit_rev:-HEAD}^{commit}")" || die "no commit ${commit_rev:-HEAD} in this checkout"
  [ -f "$installers/Ardia.build.json" ] || die "$installers has no Ardia.build.json"
  stamped="$(identity "$installers/Ardia.build.json")"
  IFS=$'\t' read -r version build <<<"$stamped"
  echo "==> Take the installers of Ardia $version, build $build, from $installers"
  for cpu in x64 arm64; do
    name="Ardia-$version-windows-$cpu-setup.exe"
    [ -f "$installers/$name" ] || die "$installers has no $name"
    [ -f "$installers/$name.sha256" ] || die "$installers has no $name.sha256"
    read -r expected listed <"$installers/$name.sha256"
    [ "$listed" = "$name" ] || die "$name.sha256 is for ${listed:-no file}"
    [ "$(sha256_of "$installers/$name")" = "$expected" ] || die "$name doesn't match its .sha256"
    cp "$installers/$name" "$stage/Ardia-Setup-$cpu.exe"
  done
  about="Ardia $version for Windows, build $build (commit $commit)."
  status="Its release, with the Mac and Linux downloads and the notes: https://github.com/$repo/releases/tag/v$version"
fi

verifier=""
live_json="$stage/live-windows-update.json"
live_sig="$stage/live-windows-update.json.sig"
if curl -fsSL --retry 3 --max-time 30 -o "$live_json" "$published/windows-update.json" 2>/dev/null && [ -s "$live_json" ]; then
  live_build="$(python3 -I -c 'import json, sys; print(int(json.load(open(sys.argv[1]))["build"]))' "$live_json" 2>/dev/null)" || die "the live windows-update.json names no build"
  if [ "$build" -lt "$live_build" ]; then
    [ "$dry" = 1 ] || die "build $build isn't above the live feed's build $live_build, so no installed app would take it"
    echo "warning: build $build isn't above the live feed's build $live_build: a real run would stop here" >&2
  elif [ "$build" -eq "$live_build" ]; then
    live_sig_ok=0
    if curl -fsSL --retry 3 --max-time 30 -o "$live_sig" "$published/windows-update.json.sig" 2>/dev/null && [ -s "$live_sig" ]; then
      verifier="$(resolve_verifier)"
      if "$verifier" windows-manifest --key "$public_key" --manifest "$live_json" --signature "$live_sig" --published-under "$published_under" --cpu x64 --current-build 0 >/dev/null 2>&1 \
        && "$verifier" windows-manifest --key "$public_key" --manifest "$live_json" --signature "$live_sig" --published-under "$published_under" --cpu arm64 --current-build 0 >/dev/null 2>&1; then
        live_sig_ok=1
      fi
    fi
    if [ "$live_sig_ok" = 1 ]; then
      [ "$dry" = 1 ] || die "build $build isn't above the live feed's build $live_build, so no installed app would take it"
      echo "warning: build $build isn't above the live feed's build $live_build: a real run would stop here" >&2
    else
      echo "warning: live build $build has no valid windows-update.json.sig; repairing incomplete publish" >&2
    fi
  fi
fi

out="${out:-$root/dist/$tag-$build}"
mkdir -p "$out"
out="$(cd "$out" && pwd -P)"
[ -z "$(ls -A "$out")" ] || die "$out already holds files: remove it or pass another --out"
mv "$stage/Ardia-Setup-x64.exe" "$stage/Ardia-Setup-arm64.exe" "$out/"

echo "==> Feed"
python3 -I - "$out" "$published" "$version" "$build" <<'PY'
import hashlib, json, os, sys
out, published, version, build = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
feed = {"version": version, "build": build}
for cpu in ("x64", "arm64"):
    name = f"Ardia-Setup-{cpu}-{build}.exe"
    path = os.path.join(out, f"Ardia-Setup-{cpu}.exe")
    digest = hashlib.sha256()
    with open(path, "rb") as file:
        for block in iter(lambda: file.read(1 << 20), b""):
            digest.update(block)
    feed[cpu] = {"url": f"{published}/{name}", "sha256": digest.hexdigest(), "bytes": os.path.getsize(path)}
with open(os.path.join(out, "windows-update.json"), "w") as file:
    json.dump(feed, file, indent=2)
    file.write("\n")
PY
cat "$out/windows-update.json"

echo "==> Sign and verify feed"
[ -n "$verifier" ] || verifier="$(resolve_verifier)"
sign_args=(
  "$root/scripts/windows/sign-update.mjs"
  --manifest "$out/windows-update.json"
  --published-under "$published_under"
  --verify-bin "$verifier"
  --package-dir "$out"
)
if [ -n "$key_file" ]; then
  sign_args+=(--key "$key_file" --public-key "$public_key")
else
  echo "warning: dry run signed with a throwaway key; a live publish requires --key or WINDOWS_UPDATE_ED_PRIVATE_KEY" >&2
  sign_args+=(--ephemeral-key-out "$stage/dry-run-public.pem")
fi
node "${sign_args[@]}"

echo "==> Source"
name="ardia-windows-source-$build"
if [ -n "$installers" ]; then
  release_source="Ardia-$version-windows-source.tar.xz"
  [ -f "$installers/$release_source" ] || die "$installers has no $release_source"
  [ -f "$installers/$release_source.sha256" ] || die "$installers has no $release_source.sha256"
  read -r expected listed <"$installers/$release_source.sha256"
  [ "$listed" = "$release_source" ] || die "$release_source.sha256 is for ${listed:-no file}"
  [ "$(sha256_of "$installers/$release_source")" = "$expected" ] || die "$release_source doesn't match its .sha256"
  cp "$installers/$release_source" "$out/$name.tar.xz"
  echo "the release's $release_source, as $name.tar.xz"
else
  "$root/scripts/windows/engine-source.sh" "$commit" "$version" "$build" "$out/$name.tar.xz"
fi

echo "==> Publish"
notes="$out/notes.md"
cat >"$notes" <<EOF
$about

- Intel or AMD PC: [Ardia-Setup-x64.exe]($published/Ardia-Setup-x64.exe)
- Snapdragon or other ARM PC: [Ardia-Setup-arm64.exe]($published/Ardia-Setup-arm64.exe)

The installer is not signed yet, so Windows shows "Windows protected your PC": choose More info, then Run anyway.
It installs for your user only, with no admin prompt. Once installed, Ardia checks this page for newer builds:
Settings, General, Updates, Check Now.

$status

The engine is Chromium with Helium's patches (GPL-3.0); $name.tar.xz is its source.
Not a Mac release.
EOF
if [ "$dry" = 1 ] || ! gh release view "$tag" -R "$repo" >/dev/null 2>&1; then
  run gh release create "$tag" -R "$repo" --prerelease --latest=false --target "$commit" --title "Ardia for Windows (alpha)" --notes-file "$notes"
fi
before=""
[ "$dry" = 1 ] || before="$(gh release view "$tag" -R "$repo" --json assets -q '.assets[].name')"
for cpu in x64 arm64; do cp "$out/Ardia-Setup-$cpu.exe" "$out/Ardia-Setup-$cpu-$build.exe"; done
run gh release upload "$tag" -R "$repo" --clobber "$out/Ardia-Setup-x64-$build.exe" "$out/Ardia-Setup-arm64-$build.exe" "$out/$name.tar.xz"
run gh release upload "$tag" -R "$repo" --clobber "$out/windows-update.json.sig"
run gh release upload "$tag" -R "$repo" --clobber "$out/windows-update.json"
run gh release upload "$tag" -R "$repo" --clobber "$out/Ardia-Setup-x64.exe" "$out/Ardia-Setup-arm64.exe"
run gh release edit "$tag" -R "$repo" --prerelease --latest=false --notes-file "$notes"
previous="$(printf '%s\n' "$before" | sed -n -E 's/^Ardia-Setup-(x64|arm64)-([0-9]+)\.exe$/\2/p' | grep -v -x "$build" | sort -n | tail -1 || true)"
for stale in $(printf '%s\n' "$before" | grep -E '^(Ardia-Setup-(x64|arm64)-[0-9]+\.exe|ardia-windows-source-[0-9]+\.tar\.xz)$' | grep -v -E -e "-($build${previous:+|$previous})\.(exe|tar\.xz)$" || true); do
  run gh release delete-asset "$tag" "$stale" -R "$repo" --yes
done
if [ "$dry" = 1 ]; then
  echo "dry run: nothing published."
else
  [ "$(gh release view "$tag" -R "$repo" --json isPrerelease -q .isPrerelease)" = true ] || die "$tag isn't a prerelease"
  echo "Published Windows build $build ($version): https://github.com/$repo/releases/tag/$tag"
fi
du -sh "$out/Ardia-Setup-x64.exe" "$out/Ardia-Setup-arm64.exe" "$out/$name.tar.xz"
