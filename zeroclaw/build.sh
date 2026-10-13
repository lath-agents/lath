#!/usr/bin/env bash
# Build the Lath-patched ZeroClaw: upstream at the commit in zeroclaw/UPSTREAM, plus every patch in
# zeroclaw/patches/ in name order, built --locked with the toolchain in zeroclaw/TOOLCHAIN and the
# features in zeroclaw/FEATURES. Prints the binary's sha256, which is what the posture commits
# and what `sdk/src/zeroclaw-builds.ts` records. No stock release is ever run.
#
#   zeroclaw/build.sh              build, print the sha256
#   zeroclaw/build.sh --check      also cargo fmt --check and clippy on the patched crates
#   zeroclaw/build.sh --expect H   fail unless the binary's sha256 is H
#
# The checkout lives in $LATH_ZEROCLAW_SRC (default zeroclaw/.build/src, gitignored). It is reset
# to the pinned commit and every patch is re-applied on each run, so a stale or hand-edited tree
# never reaches a build.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECK=0
EXPECT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --check) CHECK=1 ;;
    --expect) EXPECT="$2"; shift ;;
    *) echo "usage: $0 [--check] [--expect <sha256>]" >&2; exit 2 ;;
  esac
  shift
done

{ read -r REPO_URL; read -r COMMIT; } <"$HERE/UPSTREAM"
TOOLCHAIN="$(tr -d '[:space:]' <"$HERE/TOOLCHAIN")"
FEATURES="$(grep -v '^#' "$HERE/FEATURES" | tr -s '[:space:]' ',' | sed 's/^,//; s/,$//')"
SRC="${LATH_ZEROCLAW_SRC:-$HERE/.build/src}"

# Init and fetch rather than clone: CI's cache restores `$SRC/target` alone, so the directory can
# exist with no checkout in it, and `git clone` refuses a non-empty destination. The fetch below
# takes the pinned commit by hash.
if [[ ! -d "$SRC/.git" ]]; then
  mkdir -p "$SRC"
  git -C "$SRC" init --quiet
  git -C "$SRC" remote add origin "$REPO_URL"
fi
git -C "$SRC" cat-file -e "$COMMIT^{commit}" 2>/dev/null || git -C "$SRC" fetch --quiet origin "$COMMIT"
git -C "$SRC" checkout --quiet --detach "$COMMIT"
git -C "$SRC" reset --quiet --hard "$COMMIT"
# target/ survives the clean so a rebuild is incremental; everything else untracked goes.
git -C "$SRC" clean --quiet -fdx -e target

shopt -s nullglob
PATCHES=("$HERE"/patches/*.patch)
for p in "${PATCHES[@]}"; do
  git -C "$SRC" apply --index --whitespace=nowarn "$p" || { echo "patch did not apply: $(basename "$p")" >&2; exit 1; }
  echo "applied $(basename "$p")"
done
PATCHSET="$(cat "${PATCHES[@]}" /dev/null | shasum -a 256 | cut -d' ' -f1)"

# Reproducibility: the checkout path and the cargo home must not reach the binary (panic
# messages and debug paths embed them), so both are remapped to fixed names; the commit time
# stands in for "now" for any build script that reads SOURCE_DATE_EPOCH.
CARGO_HOME_DIR="${CARGO_HOME:-$HOME/.cargo}"
export SOURCE_DATE_EPOCH="$(git -C "$SRC" log -1 --format=%ct "$COMMIT")"
export RUSTFLAGS="--remap-path-prefix=$SRC=/zeroclaw --remap-path-prefix=$CARGO_HOME_DIR=/cargo ${RUSTFLAGS:-}"
export CARGO_INCREMENTAL=0
# macOS: ld64 hashes the output into LC_UUID before upstream's `strip = true` runs, and that
# output still holds the debug map's absolute object paths, so two checkouts built different
# UUIDs from the same bytes. `-S` keeps the debug map out of the link, and the UUID is
# then over what ships.
if [[ "$(uname -s)" == Darwin ]]; then
  export RUSTFLAGS="$RUSTFLAGS -C link-arg=-Wl,-S"
fi

(cd "$SRC" && cargo "+$TOOLCHAIN" build --release --locked --no-default-features --features "$FEATURES" --bin zeroclaw)

if [[ $CHECK -eq 1 ]]; then
  (cd "$SRC" && cargo "+$TOOLCHAIN" fmt --all -- --check)
  (cd "$SRC" && cargo "+$TOOLCHAIN" clippy --release --locked --no-default-features --features "$FEATURES" --bin zeroclaw -- -D warnings)
fi

BIN="$SRC/target/release/zeroclaw"
SHA="$(shasum -a 256 "$BIN" | cut -d' ' -f1)"
TRIPLE="$(rustc "+$TOOLCHAIN" -vV | sed -n 's/^host: //p')"
mkdir -p "$HERE/.build"
cp "$BIN" "$HERE/.build/zeroclaw"
printf '%s  zeroclaw  %s  upstream=%s  patchset=%s  toolchain=%s  features=%s\n' \
  "$SHA" "$TRIPLE" "$COMMIT" "$PATCHSET" "$TOOLCHAIN" "$FEATURES" | tee "$HERE/.build/zeroclaw.sha256"

if [[ -n "$EXPECT" && "$EXPECT" != "$SHA" ]]; then
  echo "sha256 mismatch: expected $EXPECT, built $SHA" >&2
  exit 1
fi
