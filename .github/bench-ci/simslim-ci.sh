#!/usr/bin/env bash
# Boot and record an iOS simulator for the iOS CI jobs, optionally slimmed with
# simslim (installed by install-simslim.sh). One place for the three workflows
# that take the `slim` input.
#
#   simslim-ci.sh boot <udid>
#     SIM_SLIM=true : `simslim on` (it boots and reboots the simulator itself),
#                     then `simctl bootstatus -b`, then `simslim verify --json`.
#                     Drift or a verify error FAILS: in CI a mis-slimmed simulator
#                     must not silently run stock.
#     otherwise     : `simctl boot` + `simctl bootstatus -b`, exactly as before.
#   simslim-ci.sh snapshot <udid> <outdir> <tag>
#     Record-only, never fails: `simslim status --json` and `simslim measure --json`
#     into <outdir>/simslim-{status,measure}-<tag>.json and the version into
#     <outdir>/simslim-version.txt. Never calls `on`. No-op without simslim.
#
# Env: SIMSLIM_PROFILE (default .github/simslim/ci.json), SIMSLIM_BOOT_TIMEOUT
# (default 15m: hosted runners overrun simslim's own 10m default).
set -euo pipefail

PROFILE="${SIMSLIM_PROFILE:-.github/simslim/ci.json}"
cmd="${1:-}"
udid="${2:-}"
[ -n "$udid" ] || { echo "usage: simslim-ci.sh boot|snapshot <udid> [outdir tag]" >&2; exit 2; }

case "$cmd" in
  boot)
    if [ "${SIM_SLIM:-false}" = "true" ]; then
      command -v simslim >/dev/null || { echo "::error::slim=true but simslim is not on PATH"; exit 1; }
      SIMSLIM_BOOT_TIMEOUT="${SIMSLIM_BOOT_TIMEOUT:-15m}" simslim on "$udid" --profile "$PROFILE"
      xcrun simctl bootstatus "$udid" -b
      verify_rc=0
      verify_json="$(simslim verify "$udid" --profile "$PROFILE" --json)" || verify_rc=$?
      echo "simslim verify (exit $verify_rc): $verify_json"
      if [ "$(printf '%s' "$verify_json" | jq -r '.ok // empty' 2>/dev/null)" != "true" ]; then
        echo "::error::simslim verify failed for $udid against $PROFILE (exit $verify_rc): ${verify_json:-no JSON}"
        exit 1
      fi
    else
      xcrun simctl boot "$udid"
      xcrun simctl bootstatus "$udid" -b
    fi
    ;;
  snapshot)
    outdir="${3:?outdir required}"
    tag="${4:?tag required}"
    if ! command -v simslim >/dev/null; then
      echo "::warning::simslim not installed; no simulator measure for $tag"
      exit 0
    fi
    mkdir -p "$outdir"
    simslim --version > "$outdir/simslim-version.txt" 2>/dev/null || true
    simslim status "$udid" --json > "$outdir/simslim-status-$tag.json" 2>/dev/null \
      || { echo "::warning::simslim status failed ($tag)"; rm -f "$outdir/simslim-status-$tag.json"; }
    simslim measure "$udid" --json > "$outdir/simslim-measure-$tag.json" 2>/dev/null \
      || { echo "::warning::simslim measure failed ($tag)"; rm -f "$outdir/simslim-measure-$tag.json"; }
    cat "$outdir/simslim-measure-$tag.json" 2>/dev/null || true
    ;;
  *)
    echo "usage: simslim-ci.sh boot|snapshot <udid> [outdir tag]" >&2
    exit 2
    ;;
esac
