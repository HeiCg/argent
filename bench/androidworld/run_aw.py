"""run_aw.py — AW-1 harness: fixed agent, open driver, two tiers, five tasks.

Two subcommands:

  setup   perform AndroidWorld's one-time emulator setup (install its 24 task
          APKs). Run once per fresh emulator before `run`.

  run     for each pinned task, generate ONE seeded parameter set (so both tiers
          see the identical task instance — the tier is the only variable), then
          run the fixed agent (claude-opus-5, one effort) once per tier with the
          open driver as the sole observation + action path. Writes a JSON
          artifact per episode plus a manifest and the pre-registered gate tables
          (G0-G5). No capability claim: one image, one emulator, five tasks.

The tool-server is started here (``node packages/tool-server/dist/index.js
start``) with the ``open-device-server`` flag on and no auth; the Python adapter
POSTs to ``http://127.0.0.1:<port>/tools/<name>``.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from android_world import registry
from android_world.env import env_launcher
from android_world.task_evals import task_eval  # noqa: F401 — type reference

from claude_wrapper import ClaudeWrapper
from driver_env import OpenDriverEnv, ToolServerClient
from tiered_agent import TieredAgent

# Pinned in requirements.txt (research §10); recorded in every manifest so a
# published AW number is never mistaken across harness versions.
AW_COMMIT = os.environ.get(
    "AW_COMMIT", "e3fea3ccc69787570e282c99573298f1c3019a34"
)
# claude-opus-5 list price ($/MTok), for the G5 cost estimate from API usage.
PRICE_IN_PER_MTOK = 5.0
PRICE_OUT_PER_MTOK = 25.0

REPO_ROOT = Path(__file__).resolve().parents[2]


def _find_adb() -> str:
  return shutil.which("adb") or "adb"


def _avd_fingerprint(serial: str) -> dict[str, str]:
  def prop(name: str) -> str:
    p = subprocess.run(
        ["adb", "-s", serial, "shell", "getprop", name],
        capture_output=True,
        text=True,
        timeout=20,
    )
    return p.stdout.strip()

  return {
      "fingerprint": prop("ro.build.fingerprint"),
      "model": prop("ro.product.model"),
      "sdk": prop("ro.build.version.sdk"),
      "release": prop("ro.build.version.release"),
  }


# ----- tool-server lifecycle ----------------------------------------------
def start_tool_server(port: int, host: str) -> subprocess.Popen:
  # Enable the open driver (re-read per request, so setting it before start is
  # enough) and launch the standalone HTTP server. ARGENT_AUTH_TOKEN is left
  # unset -> no auth on loopback.
  subprocess.run(
      [
          "node",
          "-e",
          'require("@argent/configuration-core").setFlag("open-device-server",true,"global")',
      ],
      cwd=str(REPO_ROOT),
      check=True,
      timeout=60,
  )
  env = dict(os.environ)
  env["ARGENT_PORT"] = str(port)
  env["ARGENT_HOST"] = host
  env.pop("ARGENT_AUTH_TOKEN", None)
  proc = subprocess.Popen(
      ["node", "packages/tool-server/dist/index.js", "start"],
      cwd=str(REPO_ROOT),
      env=env,
  )
  return proc


# ----- per-step metrics ----------------------------------------------------
def step_metrics(step_n: int, wall_ms: float, sd: dict[str, Any]) -> dict[str, Any]:
  obs = sd.get("before_observation") or {}
  calls = sd.get("llm_calls") or []
  api_in = sum((c.get("input_tokens") or 0) for c in calls)
  api_out = sum((c.get("output_tokens") or 0) for c in calls)
  return {
      "step": step_n,
      "wall_ms": round(wall_ms, 1),
      "observation_tokens_ours": obs.get("tokens_o200k"),
      "observation_node_count": obs.get("node_count"),
      "describe_source": obs.get("describe_source"),
      "waited_ms": obs.get("waited_ms"),
      "capture_ms": obs.get("capture_ms"),
      "wire_bytes": obs.get("wire_bytes"),
      "api_input_tokens": api_in,
      "api_output_tokens": api_out,
      "llm_call_count": len(calls),
      "action_output": sd.get("action_output"),
  }


def run_episode(
    task_type,
    params: dict[str, Any],
    tier: str,
    aw_env,
    serial: str,
    client: ToolServerClient,
    llm: ClaudeWrapper,
    avd: dict[str, str],
) -> dict[str, Any]:
  open_env = OpenDriverEnv(aw_env, serial, tier, client)
  agent = TieredAgent(open_env, llm)
  task = task_type(params)

  open_env.reset(go_home=True)
  task.initialize_task(open_env)
  agent.reset(task.start_on_home_screen)

  budget = int(task.complexity * 10)
  steps: list[dict[str, Any]] = []
  is_done = False
  error = None
  try:
    for step_n in range(budget):
      t0 = time.monotonic()
      result = agent.step(task.goal)
      wall_ms = (time.monotonic() - t0) * 1000.0
      steps.append(step_metrics(step_n, wall_ms, result.data))
      if result.done:
        is_done = True
        break
  except Exception as e:  # noqa: BLE001 — a step crash must not lose the episode
    error = f"{type(e).__name__}: {e}"

  # G0: a terminal is_successful per episode, regardless of whether the agent
  # signalled done (never a mean over tasks).
  try:
    success_score = float(task.is_successful(open_env))
  except Exception as e:  # noqa: BLE001
    success_score = 0.0
    error = error or f"is_successful: {type(e).__name__}: {e}"
  try:
    task.tear_down(open_env)
  except Exception:  # noqa: BLE001
    pass

  return {
      "task": task_type.__name__,
      "tier": tier,
      "complexity": task.complexity,
      "goal": str(task.goal),
      "step_budget": budget,
      "n_steps": len(steps),
      "agent_signalled_done": is_done,
      "is_successful": success_score,
      "error": error,
      "steps": steps,
      "aw_commit": AW_COMMIT,
      "avd": avd,
  }


# ----- gate tables (G0-G5) -------------------------------------------------
def build_gates(episodes: list[dict[str, Any]], tiers: list[str], meta: dict) -> str:
  by = {(e["task"], e["tier"]): e for e in episodes}
  tasks = sorted({e["task"] for e in episodes})
  lines: list[str] = []
  lines.append("## Gates (pre-registered before the run)\n")

  lines.append(f"**G0** — {len(episodes)} episodes, each with a terminal "
               "`is_successful`:\n")
  lines.append("| task | tier | steps | done | is_successful | error |")
  lines.append("| --- | --- | --- | --- | --- | --- |")
  for t in tasks:
    for tier in tiers:
      e = by.get((t, tier))
      if not e:
        continue
      lines.append(
          f"| {t} | {tier} | {e['n_steps']} | {e['agent_signalled_done']} | "
          f"{e['is_successful']:.1f} | {e['error'] or ''} |"
      )
  lines.append("")

  lines.append("**G1** — per-task pass/fail per tier (never a mean over 5):\n")
  header = "| task | " + " | ".join(tiers) + " |"
  lines.append(header)
  lines.append("| " + " | ".join(["---"] * (len(tiers) + 1)) + " |")
  for t in tasks:
    cells = []
    for tier in tiers:
      e = by.get((t, tier))
      cells.append("PASS" if e and e["is_successful"] == 1 else "FAIL")
    lines.append(f"| {t} | " + " | ".join(cells) + " |")
  lines.append("")

  def per_tier_stat(tier: str) -> dict[str, float]:
    eps = [e for e in episodes if e["tier"] == tier]
    steps = [s for e in eps for s in e["steps"]]
    n = max(len(steps), 1)
    obs = sum((s["observation_tokens_ours"] or 0) for s in steps)
    api_in = sum((s["api_input_tokens"] or 0) for s in steps)
    api_out = sum((s["api_output_tokens"] or 0) for s in steps)
    wall = sum((s["wall_ms"] or 0) for s in steps)
    return {
        "steps": len(steps),
        "obs_per_step": obs / n,
        "api_in_per_step": api_in / n,
        "api_out_per_step": api_out / n,
        "obs_share": (obs / api_in) if api_in else 0.0,
        "s_per_step": (wall / n) / 1000.0,
        "api_in_total": api_in,
        "api_out_total": api_out,
    }

  stats = {tier: per_tier_stat(tier) for tier in tiers}

  lines.append("**G2** — tokens/step per tier (API usage) + observation share "
               "(ours o200k / API input):\n")
  lines.append("| tier | steps | obs tok/step (ours) | API in/step | API out/step | obs share |")
  lines.append("| --- | --- | --- | --- | --- | --- |")
  for tier in tiers:
    s = stats[tier]
    lines.append(
        f"| {tier} | {s['steps']} | {s['obs_per_step']:.1f} | "
        f"{s['api_in_per_step']:.1f} | {s['api_out_per_step']:.1f} | "
        f"{s['obs_share']:.3f} |"
    )
  lines.append("")

  lines.append("**G3** — s/step per tier:\n")
  lines.append("| tier | s/step |")
  lines.append("| --- | --- |")
  for tier in tiers:
    lines.append(f"| {tier} | {stats[tier]['s_per_step']:.2f} |")
  lines.append("")

  lines.append("**G4** — manifest:\n")
  lines.append("```json")
  lines.append(json.dumps(meta, indent=2))
  lines.append("```")
  lines.append("")

  lines.append("**G5** — cost from API usage (claude-opus-5 "
               f"${PRICE_IN_PER_MTOK}/${PRICE_OUT_PER_MTOK} per MTok):\n")
  lines.append("| tier | input tok | output tok | cost $ |")
  lines.append("| --- | --- | --- | --- |")
  total = 0.0
  for tier in tiers:
    s = stats[tier]
    cost = (
        s["api_in_total"] / 1e6 * PRICE_IN_PER_MTOK
        + s["api_out_total"] / 1e6 * PRICE_OUT_PER_MTOK
    )
    total += cost
    lines.append(
        f"| {tier} | {s['api_in_total']} | {s['api_out_total']} | {cost:.2f} |"
    )
  lines.append(f"| **all** |  |  | **{total:.2f}** |")
  lines.append("\nNo capability claim: one image, one emulator, five tasks.\n")
  return "\n".join(lines)


# ----- subcommands ---------------------------------------------------------
def cmd_setup(args: argparse.Namespace) -> int:
  env = env_launcher.load_and_setup_env(
      console_port=args.console_port,
      emulator_setup=True,
      adb_path=_find_adb(),
      grpc_port=args.grpc_port,
  )
  env.close()
  print("[run_aw] emulator setup complete (24 task APKs installed).")
  return 0


def cmd_run(args: argparse.Namespace) -> int:
  tasks = [t.strip() for t in args.tasks.split(",") if t.strip()]
  tiers = [t.strip() for t in args.tiers.split(",") if t.strip()]
  out_dir = Path(args.out_dir)
  out_dir.mkdir(parents=True, exist_ok=True)
  adb_path = _find_adb()

  server = start_tool_server(args.tool_server_port, "127.0.0.1")
  client = ToolServerClient(f"http://127.0.0.1:{args.tool_server_port}")
  client.wait_ready()

  llm = ClaudeWrapper(model_name=args.model, effort=args.effort)
  aw_env = env_launcher.load_and_setup_env(
      console_port=args.console_port,
      emulator_setup=False,
      freeze_datetime=True,
      adb_path=adb_path,
      grpc_port=args.grpc_port,
  )
  avd = _avd_fingerprint(args.serial)
  aw_registry = registry.TaskRegistry().get_registry(
      registry.TaskRegistry.ANDROID_WORLD_FAMILY
  )

  meta = {
      "run_id": args.run_id,
      "aw_commit": AW_COMMIT,
      "model": args.model,
      "effort": args.effort,
      "temperature": "unset",
      "task_random_seed": args.task_random_seed,
      "n_task_combinations": args.n_task_combinations,
      "tasks": tasks,
      "tiers": tiers,
      "avd": avd,
      "prompt_caching": "off (identical across arms)",
  }

  episodes: list[dict[str, Any]] = []
  try:
    for ti, task_name in enumerate(tasks):
      if task_name not in aw_registry:
        raise ValueError(f"Task {task_name} not in AndroidWorld registry.")
      task_type = aw_registry[task_name]
      # One seeded param set per task, reused across tiers so the tier is the
      # only variable. n_task_combinations is pinned at 1.
      random.seed(args.task_random_seed + ti)
      params = task_type.generate_random_params()
      meta.setdefault("task_complexity", {})[task_name] = task_type.complexity
      for tier in tiers:
        print(f"\n===== episode: {task_name} @ tier={tier} =====")
        episode = run_episode(
            task_type, params, tier, aw_env, args.serial, client, llm, avd
        )
        episodes.append(episode)
        ep_path = out_dir / f"episode-{task_name}-{tier}.json"
        ep_path.write_text(json.dumps(episode, indent=2), encoding="utf-8")
        print(f"[run_aw] wrote {ep_path} (is_successful={episode['is_successful']})")
  finally:
    try:
      aw_env.close()
    except Exception:  # noqa: BLE001
      pass
    server.terminate()

  (out_dir / "episodes.json").write_text(
      json.dumps(episodes, indent=2), encoding="utf-8"
  )
  (out_dir / "manifest.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
  report = build_gates(episodes, tiers, meta)
  (out_dir / "gates.md").write_text(report, encoding="utf-8")
  print("\n" + report)
  return 0


def main() -> int:
  ap = argparse.ArgumentParser(description="AW-1 AndroidWorld harness")
  sub = ap.add_subparsers(dest="cmd", required=True)

  common = argparse.ArgumentParser(add_help=False)
  common.add_argument("--serial", default="emulator-5554")
  common.add_argument("--console-port", type=int, default=5554)
  common.add_argument("--grpc-port", type=int, default=8554)

  p_setup = sub.add_parser("setup", parents=[common])
  p_setup.set_defaults(func=cmd_setup)

  p_run = sub.add_parser("run", parents=[common])
  p_run.add_argument("--tasks", required=True)
  p_run.add_argument("--tiers", default="compact,full")
  p_run.add_argument("--task-random-seed", type=int, default=30)
  p_run.add_argument("--n-task-combinations", type=int, default=1)
  p_run.add_argument("--model", default="claude-opus-5")
  p_run.add_argument("--effort", default="medium")
  p_run.add_argument("--checkpoint-dir", default=None)
  p_run.add_argument("--out-dir", required=True)
  p_run.add_argument("--run-id", default="local")
  p_run.add_argument("--tool-server-port", type=int, default=3001)
  p_run.set_defaults(func=cmd_run)

  args = ap.parse_args()
  return args.func(args)


if __name__ == "__main__":
  sys.exit(main())
