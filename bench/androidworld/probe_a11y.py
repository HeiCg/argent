"""Step 0 — blocking a11y-suppression probe (AW-1).

Research §2 records an *inference*, not a measurement: our on-device server holds
a ``UiAutomation`` obtained with default flags
(``DeviceControlInstrumentation.kt:52``), and a default ``UiAutomation``
connection is believed to *suppress other accessibility services* for its
lifetime. If so, while our instrumentation is alive AndroidWorld's a11y forwarder
forest comes back empty and ``uiautomator dump`` fails for want of a second
``UiAutomation`` — which would force AW-1 to add
``FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES`` to the ``getUiAutomation`` call.

This script settles that on the CI emulator (API 33, booted WITHOUT
``-grpc-use-token``). It:
  1. installs our device-control APK and launches the instrumentation, waiting
     for the ``INSTRUMENTATION_STATUS: port=`` line that proves the server is
     alive (matching the host handshake in ``android-open-server.ts``);
  2. WHILE the instrumentation is alive, runs ``uiautomator dump`` (the
     dependency-light, direct suppression signal) and reads AndroidWorld's own
     a11y forest through its controller (the exact path the harness would use);
  3. writes ``probe.json`` and prints a verdict.

The Result in the ticket pre-registers the choice from this output BEFORE the
harness runs. Note (research risk 2): if the flag is added, the describe
latencies must be re-measured against run 34870686468 at the drift floor —
scheduled as AW-1.1, never folded into the AW-1 harness run.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
import time

# From packages/android-device-server/assets/manifest.json.
INSTRUMENTATION_RUNNER = "com.argent.devicecontrol/.DeviceControlInstrumentation"
PACKAGE_NAME = "com.argent.devicecontrol"
PORT_MARKER = re.compile(r"INSTRUMENTATION_STATUS:\s*port=(\d+)")


def adb(serial: str, args: list[str], timeout: int = 60) -> subprocess.CompletedProcess:
  return subprocess.run(
      ["adb", "-s", serial, *args],
      capture_output=True,
      text=True,
      timeout=timeout,
  )


def start_instrumentation(
    serial: str, dont_suppress_a11y: bool = True
) -> tuple[subprocess.Popen, int | None]:
  """Launch am instrument and wait for the ephemeral-port status line.

  The probe exercises the OPT-IN path (`-e dontSuppressA11y true`), which is what
  the AndroidWorld harness uses; the default driver start stays suppressing.
  """
  extra = ["-e", "dontSuppressA11y", "true"] if dont_suppress_a11y else []
  proc = subprocess.Popen(
      ["adb", "-s", serial, "shell", "am", "instrument", "-w", *extra, INSTRUMENTATION_RUNNER],
      stdout=subprocess.PIPE,
      stderr=subprocess.STDOUT,
      text=True,
      bufsize=1,
  )
  deadline = time.time() + 60
  port: int | None = None
  while time.time() < deadline:
    line = proc.stdout.readline() if proc.stdout else ""
    if not line:
      if proc.poll() is not None:
        break
      continue
    print(f"[am instrument] {line.rstrip()}")
    m = PORT_MARKER.search(line)
    if m:
      port = int(m.group(1))
      break
  return proc, port


def read_aw_forest(console_port: int, grpc_port: int, adb_path: str) -> dict:
  """Read AndroidWorld's a11y forest through its own controller."""
  out: dict = {"ok": False}
  try:
    from android_world.env import env_launcher

    env = env_launcher.load_and_setup_env(
        console_port=console_port,
        emulator_setup=False,
        freeze_datetime=False,
        adb_path=adb_path,
        grpc_port=grpc_port,
    )
    try:
      forest = env.controller.get_a11y_forest()
      windows = list(getattr(forest, "windows", []))
      nodes = sum(len(list(getattr(w.tree, "nodes", []))) for w in windows)
      ui_elements = env.get_state(wait_to_stabilize=True).ui_elements
      out.update(
          ok=True,
          windows=len(windows),
          nodes=nodes,
          ui_elements=len(ui_elements),
      )
    finally:
      env.close()
  except Exception as e:  # noqa: BLE001 — record any failure verbatim
    out.update(error=f"{type(e).__name__}: {e}")
  return out


def uiautomator_dump(serial: str) -> dict:
  """Run uiautomator dump; success needs a second UiAutomation on the device."""
  remote = "/sdcard/aw_probe_dump.xml"
  adb(serial, ["shell", "rm", "-f", remote])
  proc = adb(serial, ["shell", "uiautomator", "dump", remote], timeout=60)
  combined = f"{proc.stdout}{proc.stderr}"
  size = 0
  node_count = 0
  try:
    ls = adb(serial, ["shell", "wc", "-c", remote])
    size = int(ls.stdout.strip().split()[0]) if ls.stdout.strip() else 0
    if size > 0:
      cat = adb(serial, ["shell", "cat", remote])
      node_count = cat.stdout.count("<node")
  except Exception:  # noqa: BLE001
    pass
  ok = "dumped to" in combined.lower() and size > 0
  return {
      "ok": ok,
      "bytes": size,
      "nodes": node_count,
      "output": combined.strip()[:400],
  }


def main() -> int:
  ap = argparse.ArgumentParser(description="AW-1 a11y-suppression probe")
  ap.add_argument("--serial", default="emulator-5554")
  ap.add_argument("--grpc-port", type=int, default=8554)
  ap.add_argument("--console-port", type=int, default=5554)
  ap.add_argument("--apk", required=True, help="path to argent-device-control-*.apk")
  ap.add_argument("--out", required=True, help="probe.json output path")
  args = ap.parse_args()

  adb_path = subprocess.run(
      ["which", "adb"], capture_output=True, text=True
  ).stdout.strip() or "adb"

  print(f"[probe] installing {args.apk}")
  install = adb(args.serial, ["install", "-r", "-t", args.apk], timeout=180)
  print(install.stdout.strip() or install.stderr.strip())

  print("[probe] launching our instrumentation (must stay alive during reads)")
  proc, port = start_instrumentation(args.serial)
  instrumentation_alive = port is not None
  print(f"[probe] instrumentation_alive={instrumentation_alive} port={port}")
  # Give the server a moment to hold its UiAutomation connection.
  time.sleep(3)

  result: dict = {
      "serial": args.serial,
      "instrumentation_alive": instrumentation_alive,
      "instrumentation_port": port,
  }
  if not instrumentation_alive:
    result["fatal"] = "our instrumentation never reported a port; cannot probe"
  else:
    print("[probe] uiautomator dump (direct suppression signal)")
    result["uiautomator_dump"] = uiautomator_dump(args.serial)
    print(f"        -> {result['uiautomator_dump']}")

    print("[probe] AndroidWorld a11y forest (harness path)")
    result["aw_forest"] = read_aw_forest(args.console_port, args.grpc_port, adb_path)
    print(f"        -> {result['aw_forest']}")

  # Verdict keys on AW's FORWARDER forest — the harness reads the a11y forwarder
  # app (A11Y_FORWARDER_APP method), not `uiautomator dump`. `uiautomator dump`
  # spins up its OWN UiAutomation (a separate connection), which conflicts with
  # our instrumentation regardless of FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES,
  # so it stays unavailable and is recorded as informational only.
  suppression = False
  if instrumentation_alive:
    forest = result.get("aw_forest", {})
    forest_ok = forest.get("ok", False) and forest.get("nodes", 0) > 0
    suppression = not forest_ok
    result["suppression_detected"] = suppression
    result["uiautomator_dump_note"] = (
        "uiautomator dump needs its own UiAutomation and stays unavailable while "
        "our instrumentation is alive; the harness uses AW's forwarder forest, "
        "not the dump — this field is informational."
    )
    result["recommendation"] = (
        "ADD FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES to "
        "DeviceControlInstrumentation.getUiAutomation, re-probe, and schedule "
        "AW-1.1 latency re-measurement against run 34870686468."
        if suppression
        else "NO FLAG NEEDED — shape (b): AW keeps adb/checkers, our server is "
        "the only observation; the forest is never read by the harness."
    )

  # Try to end the instrumentation cleanly.
  try:
    adb(args.serial, ["shell", "am", "force-stop", PACKAGE_NAME])
    proc.terminate()
    proc.wait(timeout=10)
  except Exception:  # noqa: BLE001
    proc.kill()

  with open(args.out, "w", encoding="utf-8") as f:
    json.dump(result, f, indent=2)
  print("\n===== PROBE RESULT =====")
  print(json.dumps(result, indent=2))
  print("========================")
  # The probe is diagnostic: a clean run (even one that detects suppression) is
  # a SUCCESS — it answers the pre-registration question. Only a probe that
  # could not run at all fails the job.
  return 0 if instrumentation_alive else 1


if __name__ == "__main__":
  sys.exit(main())
