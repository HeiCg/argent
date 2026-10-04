#!/usr/bin/env bash
# Emulator diagnostics + fail-closed liveness for the Android bench workflows
# (bench-open-vs-proprietary.yml, bench-androidworld.yml). One script, subcommands:
#
#   install-emulator <build>   empty -> no-op (sdkmanager's "emulator" stays, today's
#                              behaviour). Else (needs the stock sdkmanager "emulator"
#                              package) install emulator-linux_x64-<build>.zip from
#                              dl.google.com into $ANDROID_SDK_ROOT/emulator, fail early
#                              on a 404, write back the stock package.xml with the zip's
#                              Pkg.Revision, verify `emulator -version` reports build_id
#                              <build> and `sdkmanager --list_installed` that revision.
#   env <sysimg-pkg> <out.json>  write ci-emulator-env.json (emulator-diagnostics.js env)
#                              and print it. Never fails.
#   start <serial> <kill-regex>  background host sampler + liveness watchdog (pid files
#                              under $EMU_DIAG_DIR). The watchdog SIGTERMs processes
#                              whose command line matches <kill-regex> when the
#                              emulator is lost, or when the memory guard trips
#                              ($EMULATOR_MEMORY_MB = guest RAM). Run it INSIDE the
#                              bench step so the 60 s heartbeat lands in that step's log.
#   stop                       kill sampler + watchdog. Never fails.
#   lost                       exit 0 (and print the marker) iff the emulator was lost.
#   postmortem <serial> <dir>  dmesg tail (+ OOM/kvm highlights), adb devices, emulator
#                              pid liveness, emulator.log tail, crash db + crashpad
#                              dumps (50 MB cap), logcat tail if adb answers. Never fails.
#   enforce                    fail (exit 1, ::error::) iff the emulator was lost.
#
# $EMU_DIAG_DIR (default /tmp/emu-diag) holds host-sampler.log, the pid files, the
# current bench context (`block <name>` / `config <id>`) and emulator-lost.json.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIAG="${EMU_DIAG_DIR:-/tmp/emu-diag}"
MARKER="$DIAG/emulator-lost.json"
CONTEXT="$DIAG/context"
SDK="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}"
CRASH_CAP_BYTES=$((50 * 1024 * 1024))

cmd="${1:-}"
shift || true
mkdir -p "$DIAG" 2>/dev/null || true

kill_pidfile() {
  local f="$1" pid
  [ -f "$f" ] || return 0
  pid="$(cat "$f" 2>/dev/null || true)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    kill "$pid" 2>/dev/null || true
    sleep 1
    kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$f"
}

case "$cmd" in
  install-emulator)
    build="${1:-}"
    if [ -z "$build" ]; then
      echo "emulator_build empty: keeping the sdkmanager \"emulator\" package"
      exit 0
    fi
    if ! [[ "$build" =~ ^[0-9]+$ ]]; then
      echo "::error::emulator_build '$build' is not a numeric build id (e.g. 13610412)"
      exit 1
    fi
    [ -n "$SDK" ] || { echo "::error::ANDROID_SDK_ROOT unset"; exit 1; }
    # The zip is only the emulator/ payload: the SDK package metadata (package.xml,
    # what sdkmanager/avdmanager read to consider "emulator" installed) comes from the
    # stock `sdkmanager "emulator"` install, saved here and written back below.
    if [ ! -f "$SDK/emulator/package.xml" ]; then
      echo "::error::$SDK/emulator/package.xml missing: install-emulator needs the stock sdkmanager \"emulator\" package first"
      exit 1
    fi
    url="https://dl.google.com/android/repository/emulator-linux_x64-${build}.zip"
    code="$(curl -sS -o /dev/null -w '%{http_code}' -I "$url" || echo 000)"
    if [ "$code" != "200" ]; then
      echo "::error::emulator build $build is not downloadable: $url -> HTTP $code"
      exit 1
    fi
    tmp="$(mktemp -d)"
    cp "$SDK/emulator/package.xml" "$tmp/package.xml.stock"
    curl -fsSL --retry 3 -o "$tmp/emulator.zip" "$url" || {
      echo "::error::download of $url failed"; exit 1; }
    rm -rf "$SDK/emulator"
    unzip -q "$tmp/emulator.zip" -d "$SDK" || { echo "::error::unzip of $url failed"; exit 1; }
    [ -x "$SDK/emulator/emulator" ] || {
      echo "::error::$SDK/emulator/emulator missing after unzip"; exit 1; }
    rev="$(sed -n 's/^Pkg\.Revision=//p' "$SDK/emulator/source.properties" 2>/dev/null | tr -d '[:space:]')"
    [ -n "$rev" ] || {
      echo "::error::no Pkg.Revision in $SDK/emulator/source.properties of build $build"; exit 1; }
    if [ -f "$SDK/emulator/package.xml" ]; then
      echo "emulator-linux_x64-${build}.zip ships its own package.xml: keeping it"
    else
      node "$HERE/emulator-diagnostics.js" package-xml --in "$tmp/package.xml.stock" \
        --revision "$rev" --out "$SDK/emulator/package.xml" || exit 1
    fi
    rm -rf "$tmp"
    ver="$("$SDK/emulator/emulator" -version 2>&1 | head -5)"
    echo "$ver"
    if ! grep -q "build_id $build" <<<"$ver"; then
      echo "::error::installed emulator does not report build_id $build"
      exit 1
    fi
    # The SDK's own view must agree, or `avdmanager create avd` refuses the AVD.
    sdkm="$SDK/cmdline-tools/latest/bin/sdkmanager"
    [ -x "$sdkm" ] || sdkm="sdkmanager"
    list="$(mktemp)"
    "$sdkm" --list_installed >"$list" 2>&1 || {
      cat "$list"; echo "::error::sdkmanager --list_installed failed"; exit 1; }
    node "$HERE/emulator-diagnostics.js" installed-revision --list "$list" \
      --path emulator --revision "$rev" || { cat "$list"; exit 1; }
    rm -f "$list"
    echo "pinned emulator build $build (Pkg.Revision $rev) installed in $SDK/emulator"
    ;;

  env)
    sysimg="${1:-}"
    out="${2:-$DIAG/ci-emulator-env.json}"
    node "$HERE/emulator-diagnostics.js" env --sysimg "$sysimg" --out "$out" \
      || echo "::warning::ci-emulator-env.json not written"
    cp "$out" "$DIAG/" 2>/dev/null || true
    exit 0
    ;;

  start)
    serial="${1:-emulator-5554}"
    pattern="${2:-}"
    rm -f "$MARKER" "$CONTEXT"
    kill_pidfile "$DIAG/sampler.pid"
    kill_pidfile "$DIAG/watchdog.pid"
    node "$HERE/emulator-diagnostics.js" sampler --log "$DIAG/host-sampler.log" &
    echo $! >"$DIAG/sampler.pid"
    node "$HERE/emulator-diagnostics.js" watchdog --serial "$serial" --marker "$MARKER" \
      --context "$CONTEXT" --kill-pattern "$pattern" --guest-mb "${EMULATOR_MEMORY_MB:-}" &
    echo $! >"$DIAG/watchdog.pid"
    echo "[emulator-diagnostics] sampler pid $(cat "$DIAG/sampler.pid"), watchdog pid $(cat "$DIAG/watchdog.pid") (serial $serial, kill /$pattern/, guest ${EMULATOR_MEMORY_MB:-?} MB)"
    exit 0
    ;;

  stop)
    kill_pidfile "$DIAG/sampler.pid"
    kill_pidfile "$DIAG/watchdog.pid"
    exit 0
    ;;

  lost)
    if [ -f "$MARKER" ]; then
      cat "$MARKER"
      exit 0
    fi
    exit 1
    ;;

  enforce)
    if [ -f "$MARKER" ]; then
      # shellcheck disable=SC2016 # JS template literals, not shell expansions
      at="$(node -e 'const m=require(process.argv[1]);process.stdout.write(`${m.lostAt}${m.context?` (${m.context})`:""}: ${m.reason}`)' "$MARKER" 2>/dev/null || cat "$MARKER")"
      echo "::error::emulator lost at $at; results of this job are partial/invalid"
      exit 1
    fi
    echo "emulator stayed alive through the bench"
    exit 0
    ;;

  postmortem)
    serial="${1:-emulator-5554}"
    dest="${2:-$DIAG/postmortem}"
    mkdir -p "$dest/crash"
    {
      echo "=== post-mortem $(date -u +%Y-%m-%dT%H:%M:%SZ) serial=$serial ==="
      if [ -f "$MARKER" ]; then echo "--- emulator-lost marker ---"; cat "$MARKER"; fi
      echo "--- adb devices -l ---"
      timeout 15 adb devices -l 2>&1 || true
      echo "--- emulator processes ---"
      if [ -f /tmp/emulator.pid ]; then
        pid="$(cat /tmp/emulator.pid)"
        if kill -0 "$pid" 2>/dev/null; then echo "launcher pid $pid: ALIVE"; else echo "launcher pid $pid: DEAD"; fi
      else
        echo "(no /tmp/emulator.pid)"
      fi
      pgrep -af 'qemu-system-' || echo "no qemu-system-* process alive"
      echo "--- free -m ---"
      free -m || true
      echo "--- dmesg highlights (oom / Out of memory / Killed process / kvm) ---"
    } >"$dest/postmortem.txt" 2>&1
    sudo -n dmesg -T 2>/dev/null | tail -300 >"$dest/dmesg-tail.txt" || true
    grep -inE 'oom|out of memory|killed process|kvm' "$dest/dmesg-tail.txt" >>"$dest/postmortem.txt" 2>/dev/null \
      || echo "(none in the last 300 dmesg lines)" >>"$dest/postmortem.txt"
    if [ -f /tmp/emulator.log ]; then
      { echo "--- tail -80 emulator.log ---"; tail -80 /tmp/emulator.log; } >>"$dest/postmortem.txt"
    fi
    # Crash db (emu-crash-<ver>.db is a crashpad database dir) + loose dumps, capped.
    used=0
    for item in /tmp/android-*/emu-crash-*.db /tmp/android-*/*.dmp; do
      [ -e "$item" ] || continue
      sz="$(du -sb "$item" 2>/dev/null | cut -f1)"
      sz="${sz:-0}"
      if [ $((used + sz)) -gt "$CRASH_CAP_BYTES" ]; then
        echo "skipped $item ($sz bytes): 50 MB crash-artifact cap" >>"$dest/postmortem.txt"
        continue
      fi
      cp -r "$item" "$dest/crash/" 2>/dev/null && used=$((used + sz))
    done
    echo "--- crash artifacts copied: $used bytes ---" >>"$dest/postmortem.txt"
    if [ "$(timeout 10 adb -s "$serial" get-state 2>/dev/null)" = "device" ]; then
      timeout 30 adb -s "$serial" logcat -d -t 400 -v threadtime >"$dest/logcat-tail.txt" 2>&1 || true
      echo "--- adb answered: logcat-tail.txt has the last 400 lines ---" >>"$dest/postmortem.txt"
    else
      echo "--- adb does not answer for $serial: no logcat ---" >>"$dest/postmortem.txt"
    fi
    cat "$dest/postmortem.txt"
    # Step-log highlights so an OOM kill or a KVM fault is visible without the zip.
    grep -iE 'out of memory|killed process' "$dest/dmesg-tail.txt" 2>/dev/null | head -5 \
      | sed 's/^/::warning title=dmesg::/' || true
    exit 0
    ;;

  *)
    echo "usage: $0 install-emulator|env|start|stop|lost|enforce|postmortem ..." >&2
    exit 2
    ;;
esac
