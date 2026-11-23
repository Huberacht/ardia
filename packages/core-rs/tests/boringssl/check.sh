#!/usr/bin/env bash
# Runs ardia-crypto's known answers and the shared update vectors through the BoringSSL backend under cargo.
#
#   tests/boringssl/check.sh
#
# Chromium's GN build is the only other place the boringssl backend compiles. This builds BoringSSL at the pinned
# release (with its Rust bindings) into target/boringssl-src and target/boringssl-build, then builds the same
# crates/ardia-crypto and crates/ardia-update-core sources as tests/boringssl/{crypto,update} with the boringssl and
# ed25519 features and runs their tests. Needs git, cmake, ninja, a C and C++ compiler, libclang and bindgen
# (cargo install bindgen-cli). Nothing here is an engine key input.
set -euo pipefail

for arg in "$@"; do
  case "$arg" in -h | --help) awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"; exit 0 ;; esac
done

boringssl_commit=d3bf4795ad5b79d646cddf2fec687da5b9b502db
here=$(cd "$(dirname "$0")" && pwd -P)
core=$(cd "$here/../.." && pwd -P)
source_dir="$core/target/boringssl-src"
build_dir="$core/target/boringssl-build"

for tool in git cmake ninja bindgen cargo; do
  command -v "$tool" >/dev/null || { echo "check.sh: $tool is required" >&2; exit 1; }
done
cmake_version=$(cmake --version | awk 'NR == 1 { print $3 }')
if ! printf '3.27\n%s\n' "$cmake_version" | sort -V -C; then
  echo "check.sh: BoringSSL's Rust bindings need CMake 3.27 or later, not $cmake_version" >&2
  exit 1
fi

if [[ "$(git -C "$source_dir" rev-parse HEAD 2>/dev/null || true)" != "$boringssl_commit" ]]; then
  rm -rf "$source_dir" "$build_dir"
  git init -q "$source_dir"
  git -C "$source_dir" fetch -q --depth 1 https://boringssl.googlesource.com/boringssl "$boringssl_commit"
  git -C "$source_dir" checkout -q FETCH_HEAD
fi

target=$(rustc -vV | awk '/^host:/ { print $2 }')
cmake -S "$source_dir" -B "$build_dir" -G Ninja -DCMAKE_BUILD_TYPE=Release -DRUST_BINDINGS="$target" >/dev/null
ninja -C "$build_dir" crypto ssl rust_wrapper bssl_sys >/dev/null

export BORINGSSL_BUILD_DIR="$build_dir"
export CARGO_TARGET_DIR="$core/target/boringssl-check"
cargo test --locked --manifest-path "$here/Cargo.toml" --workspace
