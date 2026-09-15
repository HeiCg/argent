"""Step 0 — a11y-suppression probe, run BOTH ways to prove the opt-in gating.

Research §2 records an inference: our on-device server holds a ``UiAutomation``
obtained with default flags, and a default ``UiAutomation`` connection suppresses
other accessibility services for its lifetime — so while our instrumentation is
alive AndroidWorld's a11y forwarder forest comes back empty.

AW-1 makes ``FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES`` OPT-IN (arg
``-e dontSuppressA11y true``), so this probe runs the emulator BOTH ways in one
job and records each outcome:

  * default start (no arg): expect AW's forest NOT readable (suppression) — the
    default driver is byte-identical to before AW-1;
  * ``dontSuppressA11y true``: expect AW's forest to return (nodes > 0) — the
    AndroidWorld harness path.

Gating is proven when the default start suppresses and the opt-in restores. The
Kotlin also compiles + unit-tests in the same CI job (``testDebugUnitTest``).
Note (research risk 2): the opt-in arm is a driver behavior change, so its
describe latencies are AW-1.1 (re-measure vs run 34870686468 at the drift floor);
the default arm needs no re-measure.
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
      ["adb", "-s", serial, *args], capture_output=True, text=True, timeout=timeout
  )


def start_instrumentation(
    serial: str, dont_suppress_a11y: bool
) -> tuple[subprocess.Popen, int | None]:
  """Launch am instrument (with or without the opt-in arg) and wait for its port."""
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


def stop_instrumentation(serial: str, proc: subprocess.Popen) -> None:
  try:
    adb(serial, ["shell", "am", "force-stop", PACKAGE_NAME])
    proc.terminate()
    proc.wait(timeout=10)
  except Exception:  # noqa: BLE001
    proc.kill()
  time.sleep(3)  # let the UiAutomation connection be released before the next phase


def read_aw_forest(console_port: int, grpc_port: int, adb_path: str) -> dict:
  """Read AndroidWorld's a11y forest through its own controller (fresh env)."""
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
      out.update(ok=True, windows=len(windows), nodes=nodes, ui_elements=len(ui_elements))
    finally:
      env.close()
  except Exception as e:  # noqa: BLE001 — record any failure verbatim
    out.update(error=f"{type(e).__name__}: {e}")
  return out


def uiautomator_dump(serial: str) -> dict:
  remote = "/sdcard/aw_probe_dump.xml"
  adb(serial, ["shell", "rm", "-f", remote])
  proc = adb(serial, ["shell", "uiautomator", "dump", remote], timeout=60)
  combined = f"{proc.stdout}{proc.stderr}"
  size = 0
  try:
    ls = adb(serial, ["shell", "wc", "-c", remote])
    size = int(ls.stdout.strip().split()[0]) if ls.stdout.strip() else 0
  except Exception:  # noqa: BLE001
    pass
  return {"ok": "dumped to" in combined.lower() and size > 0, "bytes": size}


def run_phase(
    label: str, serial: str, dont_suppress: bool, console_port: int, grpc_port: int, adb_path: str
) -> dict:
  print(f"\n[probe] === phase {label} (dontSuppressA11y={dont_suppress}) ===")
  proc, port = start_instrumentation(serial, dont_suppress)
  alive = port is not None
  print(f"[probe] instrumentation_alive={alive} port={port}")
  phase: dict = {"instrumentation_alive": alive, "instrumentation_port": port}
  if alive:
    time.sleep(3)  # hold the UiAutomation before reading
    phase["aw_forest"] = read_aw_forest(console_port, grpc_port, adb_path)
    print(f"[probe]   aw_forest -> {phase['aw_forest']}")
    phase["uiautomator_dump"] = uiautomator_dump(serial)
    print(f"[probe]   uiautomator_dump -> {phase['uiautomator_dump']}")
  stop_instrumentation(serial, proc)
  return phase


def main() -> int:
  ap = argparse.ArgumentParser(description="AW-1 a11y opt-in gating probe (both ways)")
  ap.add_argument("--serial", default="emulator-5554")
  ap.add_argument("--grpc-port", type=int, default=8554)
  ap.add_argument("--console-port", type=int, default=5554)
  ap.add_argument("--apk", required=True)
  ap.add_argument("--out", required=True)
  args = ap.parse_args()

  adb_path = subprocess.run(["which", "adb"], capture_output=True, text=True).stdout.strip() or "adb"

  print(f"[probe] installing {args.apk}")
  install = adb(args.serial, ["install", "-r", "-t", args.apk], timeout=180)
  print(install.stdout.strip() or install.stderr.strip())

  result: dict = {"serial": args.serial}
  # Default start FIRST (suppressing), then the opt-in arm.
  result["default"] = run_phase(
      "default", args.serial, False, args.console_port, args.grpc_port, adb_path
  )
  result["dontSuppressA11y"] = run_phase(
      "dontSuppressA11y", args.serial, True, args.console_port, args.grpc_port, adb_path
  )

  def forest_ok(phase: dict) -> bool:
    f = phase.get("aw_forest", {})
    return bool(f.get("ok")) and f.get("nodes", 0) > 0

  default_suppressed = not forest_ok(result["default"])
  optin_ok = forest_ok(result["dontSuppressA11y"])
  gating_proven = default_suppressed and optin_ok
  result["default_suppressed"] = default_suppressed
  result["optin_forest_ok"] = optin_ok
  result["gating_proven"] = gating_proven
  result["verdict"] = (
      "OPT-IN GATING PROVEN — default start suppresses AW's forest; "
      "`-e dontSuppressA11y true` restores it."
      if gating_proven
      else f"UNEXPECTED — default_suppressed={default_suppressed}, "
      f"optin_forest_ok={optin_ok}; inspect per-phase results."
  )
  result["uiautomator_dump_note"] = (
      "uiautomator dump needs its own UiAutomation (a separate connection) and can "
      "stay unavailable regardless of the flag; the harness uses AW's forwarder "
      "forest, not the dump — this field is informational."
  )

  with open(args.out, "w", encoding="utf-8") as f:
    json.dump(result, f, indent=2)
  print("\n===== PROBE RESULT =====")
  print(json.dumps(result, indent=2))
  print("========================")

  both_alive = result["default"]["instrumentation_alive"] and result[
      "dontSuppressA11y"
  ]["instrumentation_alive"]
  # Diagnostic run: a clean run answers the question even if gating were not
  # proven. Only a probe where our instrumentation could not start at all fails.
  return 0 if both_alive else 1


if __name__ == "__main__":
  sys.exit(main())
