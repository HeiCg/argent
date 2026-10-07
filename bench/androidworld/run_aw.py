"""run_aw.py — AW-1/AW-2 harness: fixed agent, open driver, arms, five tasks.

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

AW-2 arms (``--arms``, default ``--tiers`` as plain arms): ``compact`` / ``full``
are the AW-1 tiers; ``graph-cold`` and ``graph-warm`` turn the ``screen-graph``
flag on, observe at tier ``summary`` and give the agent ``navigate_to``. Before
every graph-arm episode the tool-server is restarted with HOME on a fresh temp
dir (an empty graph store, ``screen-graph`` on in that HOME only; the server
caches stores in memory, so a restart is needed anyway). The user's real
``~/.argent`` is never read or written by the graph arms, and the real
``screen-graph`` flag (off for the plain arms) is restored at the end.
``graph-warm`` then runs one unscored warm-up episode of the same task + params
on that store (written as ``episode-<task>-graph-warm-warmup.json``, kept out of
every gate except its own G5 cost row) before its scored episode;
``graph-cold`` scores the episode on the empty store.
"""

from __future__ import annotations

import argparse
import contextlib
import dataclasses
import json
import os
import random
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

import numpy as np

from android_world import registry
from android_world.env import env_launcher

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


# ----- AW-2 arms ------------------------------------------------------------
@dataclasses.dataclass(frozen=True)
class Arm:
  """One arm: the observation tier, whether the screen graph is on, warm-up."""

  name: str
  tier: str
  graph: bool = False
  warm: bool = False


ARMS: dict[str, Arm] = {
    "compact": Arm("compact", "compact"),
    "full": Arm("full", "full"),
    "graph-cold": Arm("graph-cold", "summary", graph=True),
    "graph-warm": Arm("graph-warm", "summary", graph=True, warm=True),
}

# AW-2 pre-registration (bench/androidworld/README.md, section AW-2).
AW2_BAR = 0.7


def parse_arms(spec: str) -> list[Arm]:
  names = [n.strip() for n in spec.split(",") if n.strip()]
  unknown = [n for n in names if n not in ARMS]
  if unknown:
    raise ValueError(f"unknown arm(s) {unknown}; known: {', '.join(ARMS)}")
  return [ARMS[n] for n in names]


def _arm_of(e: dict[str, Any]) -> str:
  return e.get("arm") or e["tier"]


def _api_in(e: dict[str, Any]) -> float:
  return sum((s.get("api_input_tokens") or 0) for s in e["steps"])


def aw2_pairs(episodes: list[dict[str, Any]]) -> dict[str, Any]:
  """graph-warm vs graph-cold, paired by task (one seeded param set per task).

  Ratios are warm totals over cold totals across the paired tasks. Success is
  non-inferior when warm loses no more tasks than it wins (cold-only <=
  warm-only): with five tasks there is no interval to speak of.
  """
  warm = {e["task"]: e for e in episodes if _arm_of(e) == "graph-warm"}
  cold = {e["task"]: e for e in episodes if _arm_of(e) == "graph-cold"}
  tasks = sorted(set(warm) & set(cold))
  rows = []
  for t in tasks:
    w, c = warm[t], cold[t]
    rows.append({
        "task": t,
        "steps": (w["n_steps"], c["n_steps"]),
        "api_in": (_api_in(w), _api_in(c)),
        "ok": (w["is_successful"] == 1, c["is_successful"] == 1),
        "navigate_calls": (w.get("navigate_calls", 0), c.get("navigate_calls", 0)),
    })

  def ratio(i: str) -> float:
    num = sum(r[i][0] for r in rows)
    den = sum(r[i][1] for r in rows)
    return round(num / den, 3) if den else float("nan")

  steps_ratio = ratio("steps")
  tokens_ratio = ratio("api_in")
  warm_only = sum(1 for r in rows if r["ok"][0] and not r["ok"][1])
  cold_only = sum(1 for r in rows if r["ok"][1] and not r["ok"][0])
  return {
      "pairs": len(rows),
      "rows": rows,
      "steps_ratio": steps_ratio,
      "input_tokens_ratio": tokens_ratio,
      "warm_ok": sum(1 for r in rows if r["ok"][0]),
      "cold_ok": sum(1 for r in rows if r["ok"][1]),
      "warm_only": warm_only,
      "cold_only": cold_only,
      "steps_met": steps_ratio <= AW2_BAR,
      "tokens_met": tokens_ratio <= AW2_BAR,
      "success_non_inferior": len(rows) > 0 and cold_only <= warm_only,
  }


def arms_from_args(arms: str | None, tiers: str) -> list[Arm]:
  """``--arms``, else the deprecated ``--tiers`` (each tier is the arm of the same name)."""
  if not arms:
    return parse_arms(tiers)
  return parse_arms(arms)


# ----- flags + the graph arms' own HOME -------------------------------------
# configuration-core keeps global flags in `<HOME>/.argent/flags.json` and the
# graph store in `<HOME>/.argent/screen-graph` (os.homedir(), i.e. $HOME). The
# graph arms' tool-server runs with HOME set to a temp dir of its own, so a run
# never reads, writes or deletes the user's real store; the one flag the run
# changes in the real HOME (screen-graph, off for the plain arms) is put back
# to its previous value at the end (`flag_restored`).


def read_global_flag(name: str, home: str | None = None) -> bool | None:
  """The flag's value in ``<home>/.argent/flags.json``; None when it is not set."""
  path = Path(home or os.path.expanduser("~")) / ".argent" / "flags.json"
  try:
    flags = json.loads(path.read_text(encoding="utf-8"))
  except (OSError, ValueError):
    return None
  value = flags.get(name) if isinstance(flags, dict) else None
  return value if isinstance(value, bool) else None


def set_flag(
    name: str, value: bool | None, home: str | None = None, runner=subprocess.run
) -> None:
  """Set a global flag in ``home`` (default: the real HOME); None unsets it."""
  call = (
      f'unsetFlag("{name}","global")'
      if value is None
      else f'setFlag("{name}",{"true" if value else "false"},"global")'
  )
  env = dict(os.environ)
  if home:
    env["HOME"] = home
  runner(
      ["node", "-e", f'require("@argent/configuration-core").{call}'],
      cwd=str(REPO_ROOT),
      env=env,
      check=True,
      timeout=60,
  )


@contextlib.contextmanager
def flag_restored(name: str, runner=subprocess.run):
  """Read the real HOME's global ``name`` now, put that value back on exit."""
  previous = read_global_flag(name)
  try:
    yield previous
  finally:
    set_flag(name, previous, runner=runner)


class GraphHomes:
  """Temp HOME dirs for the graph arms' tool-server; removes only the ones it made."""

  def __init__(self, base: str | None = None):
    self.base = base
    self.made: list[str] = []

  def fresh(self) -> str:
    """A new empty HOME, holding only a copy of the real emulator console token.

    The token keeps the graph arms on the same transport as the plain ones: the
    open server reads ``~/.emulator_console_auth_token`` for the console redir and
    falls back to adb-forward without it (``packages/tool-server/src/utils/open-server-transport.ts``).
    """
    if self.base:
      os.makedirs(self.base, exist_ok=True)
    d = tempfile.mkdtemp(prefix="aw-graph-home-", dir=self.base)
    self.made.append(d)
    token = Path(os.path.expanduser("~")) / ".emulator_console_auth_token"
    if token.is_file():
      shutil.copy2(token, Path(d) / token.name)
    return d

  def cleanup(self, keep: str | None = None) -> None:
    for d in [d for d in self.made if d != keep]:
      shutil.rmtree(d, ignore_errors=True)
      self.made.remove(d)


def switch_tool_server(
    server: subprocess.Popen, port: int, client: ToolServerClient, home: str | None
) -> subprocess.Popen:
  """Stop the tool-server and start it again with ``home`` (None: the real HOME)."""
  server.terminate()
  try:
    server.wait(timeout=30)
  except subprocess.TimeoutExpired:
    server.kill()
  fresh = start_tool_server(port, "127.0.0.1", home=home)
  client.wait_ready()
  return fresh


# ----- tool-server lifecycle ----------------------------------------------
def tool_server_env(port: int, host: str, home: str | None = None) -> dict[str, str]:
  """The tool-server's environment; ``home`` replaces HOME (the graph arms)."""
  env = dict(os.environ)
  if home:
    # adb / the emulator keep their state under ~/.android: keep the real one.
    env.setdefault("ANDROID_USER_HOME", os.path.join(os.path.expanduser("~"), ".android"))
    env["HOME"] = home
  env["ARGENT_PORT"] = str(port)
  env["ARGENT_HOST"] = host
  env.pop("ARGENT_AUTH_TOKEN", None)
  return env


def start_tool_server(port: int, host: str, home: str | None = None) -> subprocess.Popen:
  # Enable the open driver (re-read per request, so setting it before start is
  # enough) and launch the standalone HTTP server. ARGENT_AUTH_TOKEN is left
  # unset -> no auth on loopback. With `home`, both happen inside that HOME.
  set_flag("open-device-server", True, home=home)
  env = tool_server_env(port, host, home)
  # AW-1: opt into the non-suppressing UiAutomation (arg `-e dontSuppressA11y
  # true`). AndroidWorld's a11y forwarder coexists with our server only because
  # the instrumentation also pins UiAutomator's Configurator flags to the same
  # value; without that, the first UiDevice waitForIdle/pressKeyCode reconnected
  # UiAutomation with flags 0 and suppressed the forwarder again (run
  # 37549293325). This is the ONLY caller that sets it; the default driver stays
  # suppressing (byte-identical).
  env["ARGENT_OPEN_SERVER_DONT_SUPPRESS_A11Y"] = "1"
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
      "navigate_calls": int(sd.get("navigate_call") or 0),
      "action_output": sd.get("action_output"),
  }


def run_episode(
    task_type,
    params: dict[str, Any],
    arm: Arm,
    aw_env,
    serial: str,
    client: ToolServerClient,
    llm: ClaudeWrapper,
    avd: dict[str, str],
    warmup: bool = False,
) -> dict[str, Any]:
  open_env = OpenDriverEnv(aw_env, serial, arm.tier, client, graph=arm.graph)
  agent = TieredAgent(open_env, llm)
  task = task_type(params)

  # Task lifecycle (init / checker / teardown) runs against the REAL AW env, so a
  # checker that happens to read get_state sees AW's own observation, never our
  # tier. The AGENT sees only the open driver (open_env).
  aw_env.reset(go_home=True)
  task.initialize_task(aw_env)
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
  # signalled done (never a mean over tasks). Scored on the real AW env.
  try:
    success_score = float(task.is_successful(aw_env))
  except Exception as e:  # noqa: BLE001
    success_score = 0.0
    error = error or f"is_successful: {type(e).__name__}: {e}"
  try:
    task.tear_down(aw_env)
  except Exception:  # noqa: BLE001
    pass

  return {
      "task": task_type.__name__,
      "arm": arm.name,
      "tier": arm.tier,
      "graph": arm.graph,
      "warmup": warmup,
      "navigate_calls": sum(s["navigate_calls"] for s in steps),
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
def build_gates(
    episodes: list[dict[str, Any]],
    tiers: list[str],
    meta: dict,
    warmups: list[dict[str, Any]] | None = None,
) -> str:
  # `tiers` are the run's arm names (an AW-1 tier is an arm of the same name).
  by = {(e["task"], _arm_of(e)): e for e in episodes}
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
    eps = [e for e in episodes if _arm_of(e) == tier]
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
        "navigate_calls": sum(e.get("navigate_calls", 0) for e in eps),
    }

  stats = {tier: per_tier_stat(tier) for tier in tiers}

  lines.append("**G2** — tokens/step per tier (API usage) + observation share "
               "(ours o200k / API input):\n")
  lines.append("| arm | steps | obs tok/step (ours) | API in/step | API out/step | obs share | navigate calls |")
  lines.append("| --- | --- | --- | --- | --- | --- | --- |")
  for tier in tiers:
    s = stats[tier]
    lines.append(
        f"| {tier} | {s['steps']} | {s['obs_per_step']:.1f} | "
        f"{s['api_in_per_step']:.1f} | {s['api_out_per_step']:.1f} | "
        f"{s['obs_share']:.3f} | {s['navigate_calls']} |"
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
  if warmups:
    # graph-warm's warm-up episodes: spent, never scored (kept out of G0-G3, AW-2).
    w_steps = [st for e in warmups for st in e["steps"]]
    w_in = sum((st["api_input_tokens"] or 0) for st in w_steps)
    w_out = sum((st["api_output_tokens"] or 0) for st in w_steps)
    cost = w_in / 1e6 * PRICE_IN_PER_MTOK + w_out / 1e6 * PRICE_OUT_PER_MTOK
    total += cost
    lines.append(f"| graph-warm warm-up (unscored) | {w_in} | {w_out} | {cost:.2f} |")
  lines.append(f"| **all** |  |  | **{total:.2f}** |")
  lines.append("")

  if "graph-warm" in tiers and "graph-cold" in tiers:
    p = aw2_pairs(episodes)
    lines.append(
        "**AW-2** — graph-warm vs graph-cold, paired by task + seed. Pre-registered "
        f"(README, AW-2): steps and API input tokens <= {AW2_BAR}x cold, success "
        "non-inferior (cold-only <= warm-only). Warm-up episodes are not counted.\n"
    )
    lines.append("| task | steps warm / cold | API in warm / cold | success warm / cold | navigate calls warm / cold |")
    lines.append("| --- | --- | --- | --- | --- |")
    for r in p["rows"]:
      lines.append(
          f"| {r['task']} | {r['steps'][0]} / {r['steps'][1]} | "
          f"{r['api_in'][0]:.0f} / {r['api_in'][1]:.0f} | "
          f"{'PASS' if r['ok'][0] else 'FAIL'} / {'PASS' if r['ok'][1] else 'FAIL'} | "
          f"{r['navigate_calls'][0]} / {r['navigate_calls'][1]} |"
      )
    lines.append("")
    lines.append(
        f"Pairs {p['pairs']}: steps ratio {p['steps_ratio']} "
        f"({'met' if p['steps_met'] else 'not met'}), API input tokens ratio "
        f"{p['input_tokens_ratio']} ({'met' if p['tokens_met'] else 'not met'}), "
        f"success warm {p['warm_ok']} vs cold {p['cold_ok']} (warm-only "
        f"{p['warm_only']}, cold-only {p['cold_only']}; non-inferior: "
        f"{'yes' if p['success_non_inferior'] else 'no'}).\n"
    )

  lines.append("No capability claim: one image, one emulator, five tasks.\n")
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
  # The plain arms run with screen-graph off in the real HOME; whatever the user
  # had there is put back when the run ends, however it ends.
  with flag_restored("screen-graph"):
    set_flag("screen-graph", False)
    return _run(args)


def _run(args: argparse.Namespace) -> int:
  tasks = [t.strip() for t in args.tasks.split(",") if t.strip()]
  if not args.arms:
    print("[run_aw] --tiers is deprecated: pass --arms (a tier is the arm of the same name)")
  arms = arms_from_args(args.arms, args.tiers)
  arm_names = [a.name for a in arms]
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
      "arms": arm_names,
      "tiers": sorted({a.tier for a in arms}),
      "graph_store": (
          "graph arms: tool-server restarted with HOME on a fresh temp dir (empty "
          "store, screen-graph on there) before every episode; the real ~/.argent "
          "is never read or written by them; graph-warm warmed by one unscored "
          "episode of the same task + params"
      ),
      "avd": avd,
      "prompt_caching": "off (identical across arms)",
  }

  episodes: list[dict[str, Any]] = []
  warmups: list[dict[str, Any]] = []
  homes = GraphHomes()
  server_home: str | None = None
  try:
    for ti, task_name in enumerate(tasks):
      if task_name not in aw_registry:
        raise ValueError(f"Task {task_name} not in AndroidWorld registry.")
      task_type = aw_registry[task_name]
      # One seeded param set per task, reused across tiers so the tier is the
      # only variable. n_task_combinations is pinned at 1. Seed both PRNGs since
      # AndroidWorld task params may draw from either.
      random.seed(args.task_random_seed + ti)
      np.random.seed(args.task_random_seed + ti)
      params = task_type.generate_random_params()
      meta.setdefault("task_complexity", {})[task_name] = task_type.complexity
      for arm in arms:
        if arm.graph:
          home = homes.fresh()
          set_flag("screen-graph", True, home=home)
          server = switch_tool_server(server, args.tool_server_port, client, home)
          homes.cleanup(keep=home)
          server_home = home
          if arm.warm:
            print(f"\n===== warm-up (unscored): {task_name} @ arm={arm.name} =====")
            warm = run_episode(
                task_type, params, arm, aw_env, args.serial, client, llm, avd,
                warmup=True,
            )
            warmups.append(warm)
            (out_dir / f"episode-{task_name}-{arm.name}-warmup.json").write_text(
                json.dumps(warm, indent=2), encoding="utf-8"
            )
        elif server_home is not None:
          server = switch_tool_server(server, args.tool_server_port, client, None)
          homes.cleanup()
          server_home = None
        print(f"\n===== episode: {task_name} @ arm={arm.name} (tier={arm.tier}) =====")
        episode = run_episode(
            task_type, params, arm, aw_env, args.serial, client, llm, avd
        )
        episodes.append(episode)
        ep_path = out_dir / f"episode-{task_name}-{arm.name}.json"
        ep_path.write_text(json.dumps(episode, indent=2), encoding="utf-8")
        print(f"[run_aw] wrote {ep_path} (is_successful={episode['is_successful']})")
  finally:
    try:
      aw_env.close()
    except Exception:  # noqa: BLE001
      pass
    server.terminate()
    homes.cleanup()

  (out_dir / "episodes.json").write_text(
      json.dumps(episodes, indent=2), encoding="utf-8"
  )
  (out_dir / "warmups.json").write_text(json.dumps(warmups, indent=2), encoding="utf-8")
  (out_dir / "manifest.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")
  report = build_gates(episodes, arm_names, meta, warmups=warmups)
  (out_dir / "gates.md").write_text(report, encoding="utf-8")
  print("\n" + report)
  return 0


def main() -> int:
  ap = argparse.ArgumentParser(description="AW-1/AW-2 AndroidWorld harness")
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
  p_run.add_argument(
      "--arms",
      default=None,
      help="comma list of arms (compact, full, graph-cold, graph-warm); "
      "default: --tiers as plain arms",
  )
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
