#!/usr/bin/env bash
# Readiness gate (phase 3h). A device-test / bench block is only trustworthy on a
# SETTLED emulator: a prior CI boot showed "Pixel Launcher isn't responding" (an
# ANR dialog) during the first test block, and a tap that lands on an ANR dialog is
# not a landed tap — it silently degrades every assertion in that session. So before
# the device tests, and before each bench block, wait until:
#   - no "Application Not Responding" (ANR) window is present, and
#   - the focused window belongs to a launcher,
# for N consecutive clean reads. Each read first dismisses any system/ANR dialog
# (CLOSE_SYSTEM_DIALOGS + BACK) and returns HOME, then inspects `dumpsys window`.
# Never fatal — on timeout it warns and proceeds (the tests still run and the
# scrcpy/logcat evidence is captured), but the wait is logged so an environment-
# degraded run is visible in the step log.
#
# Usage: ready-gate.sh [serial] [need-consecutive] [max-iterations(~2s each)]
set -uo pipefail
SERIAL="${1:-emulator-5554}"
NEED="${2:-3}"
MAXIT="${3:-60}"

ash() { adb -s "$SERIAL" shell "$@" 2>/dev/null; }

clean=0
for i in $(seq 1 "$MAXIT"); do
  # Dismiss any system / ANR dialog and return to the launcher.
  ash 'am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS' >/dev/null || true
  ash input keyevent KEYCODE_BACK >/dev/null || true
  ash input keyevent KEYCODE_HOME >/dev/null || true

  win="$(ash dumpsys window || true)"
  # ANR dialog window is titled "Application Not Responding: <pkg>".
  anr="$(printf '%s' "$win" | grep -ciE 'Application Not Responding' || true)"
  # Focused window / app belongs to a launcher (Pixel/Nexus/Quickstep/generic).
  foc="$(printf '%s' "$win" | grep -iE 'mCurrentFocus|mFocusedApp' | grep -ciE 'launcher|nexus|quickstep' || true)"

  if [ "${anr:-1}" -eq 0 ] && [ "${foc:-0}" -ge 1 ]; then
    clean=$((clean + 1))
  else
    clean=0
  fi
  echo "[ready-gate] t+$((i * 2))s anr=${anr:-?} launcherFocused=${foc:-?} consecutiveClean=${clean}/${NEED}"
  if [ "$clean" -ge "$NEED" ]; then
    echo "[ready-gate] READY: no ANR, launcher focused, ${NEED} consecutive clean reads (t+$((i * 2))s)"
    exit 0
  fi
  sleep 2
done
echo "::warning::[ready-gate] NOT settled after $((MAXIT * 2))s (${NEED} consecutive clean reads never reached) — proceeding, run may be environment-degraded"
exit 0
