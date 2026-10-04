#!/usr/bin/env bash
# Install the pinned simslim release (https://github.com/MobAI-App/simslim, MIT)
# on a macOS arm64 runner and put it on PATH. External binary, run time only;
# never vendored. simslim publishes no checksum file, so the sha256 below was
# computed by us from the release asset and is enforced: a mismatch fails.
#
# Pin: v0.11.0, asset simslim-v0.11.0-macos-arm64.tar.gz, GitHub asset id
# 586133929, hashed 2026-10-04 with `shasum -a 256` (equal to the digest the
# GitHub release API reports for that asset).
#
# Usage: bash .github/bench-ci/install-simslim.sh [install-dir]
#   install-dir defaults to $RUNNER_TEMP/simslim-bin (or a mktemp dir). The dir is
#   appended to $GITHUB_PATH when running in Actions.
set -euo pipefail

VERSION="v0.11.0"
ASSET="simslim-${VERSION}-macos-arm64.tar.gz"
SHA256="d7ae4d0c834dfea9911f113cf60e98c25ee61f2a3a85ca22d0c28c43b39ccfaf"
URL="https://github.com/MobAI-App/simslim/releases/download/${VERSION}/${ASSET}"

if [ "$(uname -s)" != "Darwin" ] || [ "$(uname -m)" != "arm64" ]; then
  echo "install-simslim: the pinned asset is macOS arm64 only (this host: $(uname -s) $(uname -m))" >&2
  exit 1
fi

DEST="${1:-${RUNNER_TEMP:-$(mktemp -d)}/simslim-bin}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

curl -fsSL --retry 3 -o "$WORK/$ASSET" "$URL"
GOT="$(shasum -a 256 "$WORK/$ASSET" | awk '{print $1}')"
if [ "$GOT" != "$SHA256" ]; then
  echo "install-simslim: sha256 mismatch for $ASSET: expected $SHA256, got $GOT" >&2
  exit 1
fi

tar -xzf "$WORK/$ASSET" -C "$WORK"
mkdir -p "$DEST"
install -m 0755 "$WORK/simslim" "$DEST/simslim"
"$DEST/simslim" --version

if [ -n "${GITHUB_PATH:-}" ]; then echo "$DEST" >> "$GITHUB_PATH"; fi
echo "install-simslim: $DEST/simslim"
