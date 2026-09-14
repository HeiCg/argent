#!/usr/bin/env bash
# Build sim-input — the Swift CLI ported from baguette for iOS-simulator HID
# input, used as the ON-siminput arm of the iOS-2 bench. Requires a full Xcode
# (not Command Line Tools) so the SimulatorKit dlopen paths resolve; we pin
# DEVELOPER_DIR explicitly so `xcode-select`'s global value doesn't matter.
#
# Mirrors device-stream/scripts/build-sim-input.sh (the source this package was
# copied from) — same `swift build -c release` with a pinned DEVELOPER_DIR, but
# resolving paths from THIS package dir and copying the product into ./bin.
#
# Usage: bash packages/ios-sim-input/scripts/build-sim-input.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

# Pin DEVELOPER_DIR. In CI the workflow sets it to the pinned Xcode (the same one
# `xcode-select -s` selected and printed for the runner build); locally fall back
# to the default Xcode.app if the caller did not set it.
if [ -z "${DEVELOPER_DIR:-}" ]; then
  if command -v xcode-select >/dev/null 2>&1; then
    DEVELOPER_DIR="$(xcode-select -p 2>/dev/null || echo /Applications/Xcode.app/Contents/Developer)"
  else
    DEVELOPER_DIR="/Applications/Xcode.app/Contents/Developer"
  fi
fi
export DEVELOPER_DIR
echo "DEVELOPER_DIR=$DEVELOPER_DIR"

cd "$ROOT"
swift build -c release

mkdir -p "$ROOT/bin"
cp .build/release/sim-input "$ROOT/bin/sim-input"
echo "built: $ROOT/bin/sim-input"
