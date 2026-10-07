"""Unit tests for the AW-2 graph arms (navigate_to action, summary tier, arms).

Run without AndroidWorld installed (CI installs it only inside the harness job,
and the dev box never pip-installs): ``android_world``, ``requests``,
``tiktoken`` and ``anthropic`` are replaced by small stubs in ``sys.modules``
before the modules under test are imported. The stubs mirror the shapes the
harness relies on (T3A's prompt helpers, ``JSONAction``'s closed action set),
not AndroidWorld's behaviour beyond that.

    python3 -I -m unittest discover -s bench/androidworld -p 'test_*.py'
"""

from __future__ import annotations

import dataclasses
import json
import os
import re
import sys
import types
import unittest
from typing import Any, Optional

HERE = os.path.dirname(os.path.abspath(__file__))


def _module(name: str, **attrs: Any) -> types.ModuleType:
  mod = types.ModuleType(name)
  for k, v in attrs.items():
    setattr(mod, k, v)
  sys.modules[name] = mod
  return mod


def _install_stubs() -> None:
  # ----- android_world.env ------------------------------------------------
  @dataclasses.dataclass
  class State:
    pixels: Any
    forest: Any
    ui_elements: list

  _ACTION_TYPES = {
      "click", "double_tap", "long_press", "input_text", "keyboard_enter",
      "navigate_home", "navigate_back", "scroll", "swipe", "open_app", "wait",
      "status", "answer", "unknown",
  }

  @dataclasses.dataclass
  class JSONAction:
    action_type: Optional[str] = None
    index: Optional[int] = None
    x: Optional[int] = None
    y: Optional[int] = None
    text: Optional[str] = None
    direction: Optional[str] = None
    goal_status: Optional[str] = None
    app_name: Optional[str] = None
    keycode: Optional[str] = None
    clear_text: Optional[bool] = None

    def __post_init__(self):
      if self.action_type not in _ACTION_TYPES:
        raise ValueError(f"Invalid action type: {self.action_type}")

  _module("android_world")
  env_pkg = _module("android_world.env")
  env_pkg.interface = _module("android_world.env.interface", State=State)
  env_pkg.json_action = _module("android_world.env.json_action", JSONAction=JSONAction)
  env_pkg.adb_utils = _module(
      "android_world.env.adb_utils",
      get_adb_activity=lambda name: None,
      extract_package_name=lambda a: a,
      launch_app=lambda name, controller: None,
  )
  env_pkg.env_launcher = _module(
      "android_world.env.env_launcher", load_and_setup_env=lambda **kw: None
  )
  sys.modules["android_world"].env = env_pkg
  sys.modules["android_world"].registry = _module(
      "android_world.registry", TaskRegistry=type("TaskRegistry", (), {})
  )

  # ----- android_world.agents ---------------------------------------------
  class AgentInteractionResult:
    def __init__(self, done: bool, data: dict):
      self.done = done
      self.data = data

  class T3A:
    def __init__(self, env, llm, name: str = "T3A"):
      self.env = env
      self.llm = llm
      self.name = name
      self.history: list = []
      self.additional_guidelines = None

    def get_post_transition_state(self):
      return self.env.get_state(wait_to_stabilize=False)

  def _action_selection_prompt(goal, history, ui_elements, additional_guidelines=None):
    return "\n".join(["ACTION", goal, ui_elements, *(additional_guidelines or [])])

  def _summarize_prompt(goal, action, reason, before, after):
    return "\n".join(["SUMMARY", action, after])

  def parse_reason_action_output(raw: str):
    m = re.search(r"Reason:(.*)Action:(.*)", raw, flags=re.DOTALL)
    return (m.group(1).strip(), m.group(2).strip()) if m else (None, None)

  def extract_json(s: str):
    m = re.search(r"\{.*\}", s, flags=re.DOTALL)
    return json.loads(m.group()) if m else None

  agents = _module("android_world.agents")
  agents.agent_utils = _module("android_world.agents.agent_utils", extract_json=extract_json)
  agents.base_agent = _module(
      "android_world.agents.base_agent", AgentInteractionResult=AgentInteractionResult
  )
  agents.infer = _module("android_world.agents.infer", LlmWrapper=object)
  agents.m3a_utils = _module(
      "android_world.agents.m3a_utils",
      parse_reason_action_output=parse_reason_action_output,
      TRIGGER_SAFETY_CLASSIFIER="safety",
  )
  agents.t3a = _module(
      "android_world.agents.t3a",
      T3A=T3A,
      _action_selection_prompt=_action_selection_prompt,
      _summarize_prompt=_summarize_prompt,
  )
  sys.modules["android_world"].agents = agents

  # ----- third-party ------------------------------------------------------
  class _Enc:
    def encode(self, s: str) -> list:
      return s.split()

  _module("tiktoken", get_encoding=lambda name: _Enc())
  _module("requests", Session=object, RequestException=Exception)
  _module("anthropic", Anthropic=object)


_install_stubs()
sys.path.insert(0, HERE)

import driver_env  # noqa: E402
import run_aw  # noqa: E402
import tiered_agent  # noqa: E402


class FakeClient:
  """Records tool calls; replies per tool (and per describe tier)."""

  def __init__(self, replies: dict[str, Any]):
    self.replies = replies
    self.calls: list[tuple[str, dict]] = []

  def call(self, tool: str, params: dict) -> dict:
    self.calls.append((tool, params))
    key = f"{tool}:{params.get('tier')}" if tool == "describe" else tool
    reply = self.replies[key]
    return reply(params) if callable(reply) else reply

  def tools(self) -> list[str]:
    return [t for t, _ in self.calls]


SUMMARY = "screen: Settings  visits: 3\nreachable screens:\n- 1a2b3c4d  Wi-Fi  (2 hops)"
COMPACT_ROOT = "Network & internet (0.1, 0.2, 0.8, 0.05)\nApps (0.1, 0.3, 0.8, 0.05)"
COMPACT_WIFI = "Wi-Fi (0.1, 0.1, 0.8, 0.05)\nAdd network (0.1, 0.5, 0.8, 0.05)"


def graph_client(nav: Optional[dict] = None) -> FakeClient:
  return FakeClient({
      "describe:summary": {"description": SUMMARY, "source": "open-device-server"},
      "describe:compact": {"description": COMPACT_ROOT, "source": "open-device-server"},
      "navigate-to": nav
      if nav is not None
      else {"reached": True, "hops": 2, "compact": COMPACT_WIFI, "rpcCount": 7},
      "await-screen-idle": {},
  })


class ParseNavigateToTest(unittest.TestCase):

  def test_function_call_form(self):
    self.assertEqual(tiered_agent.parse_navigate_to('navigate_to("Wi-Fi")'), "Wi-Fi")
    self.assertEqual(
        tiered_agent.parse_navigate_to("navigate_to('Network & internet')"),
        "Network & internet",
    )
    self.assertEqual(tiered_agent.parse_navigate_to('navigate_to(label="Wi-Fi")'), "Wi-Fi")

  def test_json_form_of_the_t3a_grammar(self):
    self.assertEqual(
        tiered_agent.parse_navigate_to('{"action_type": "navigate_to", "label": "Wi-Fi"}'),
        "Wi-Fi",
    )

  def test_other_actions_and_empty_labels_are_not_navigation(self):
    self.assertIsNone(tiered_agent.parse_navigate_to('{"action_type": "click", "index": 3}'))
    self.assertIsNone(tiered_agent.parse_navigate_to("navigate_to()"))
    self.assertIsNone(tiered_agent.parse_navigate_to('navigate_to("  ")'))
    self.assertIsNone(
        tiered_agent.parse_navigate_to('{"action_type": "navigate_to", "label": ""}')
    )


class SummaryTierTest(unittest.TestCase):

  def test_summary_tier_heads_the_indexed_compact_tree(self):
    client = graph_client()
    env = driver_env.OpenDriverEnv(None, "emulator-5554", "summary", client, graph=True)
    state = env.get_state()
    self.assertEqual(
        [(t, p.get("tier")) for t, p in client.calls],
        [("describe", "summary"), ("describe", "compact")],
    )
    obs = env.last_observation
    self.assertEqual(obs.tier, "summary")
    self.assertIn("reachable screens:", obs.text)
    self.assertIn("1a2b3c4d  Wi-Fi", obs.text)
    self.assertIn("UI element 0: Network & internet", obs.text)
    self.assertIn("UI element 1: Apps", obs.text)
    self.assertEqual(len(state.ui_elements), 2)
    self.assertEqual(obs.node_count, 2)
    self.assertEqual(obs.tokens_o200k, len(obs.text.split()))

  def test_compact_tier_is_unchanged(self):
    client = graph_client()
    env = driver_env.OpenDriverEnv(None, "emulator-5554", "compact", client)
    env.get_state()
    self.assertEqual([(t, p.get("tier")) for t, p in client.calls], [("describe", "compact")])
    self.assertNotIn("reachable screens", env.last_observation.text)


class NavigateToDriverTest(unittest.TestCase):

  def test_navigate_to_calls_the_tool_by_label_and_its_compact_is_the_next_observation(self):
    client = graph_client()
    env = driver_env.OpenDriverEnv(None, "emulator-5554", "summary", client, graph=True)
    data = env.navigate_to("Wi-Fi")
    self.assertEqual(
        client.calls,
        [("navigate-to", {"udid": "emulator-5554", "target": {"label": "Wi-Fi"}})],
    )
    self.assertTrue(data["reached"])
    self.assertEqual(env.navigate_calls, 1)
    env.get_state()  # the post-action read: served from the reply, no describe
    self.assertEqual(client.tools(), ["navigate-to"])
    self.assertEqual(env.last_observation.tier, "navigate")
    self.assertIn("UI element 0: Wi-Fi", env.last_observation.text)
    self.assertEqual(len(env.last_nodes), 2)
    env.get_state()  # the next step reads the screen again
    self.assertEqual(client.tools(), ["navigate-to", "describe", "describe"])

  def test_a_refused_navigation_raises_with_the_tool_error(self):
    client = graph_client({"reached": False, "error": 'no known screen has the label "Zzz"'})
    env = driver_env.OpenDriverEnv(None, "emulator-5554", "summary", client, graph=True)
    with self.assertRaises(driver_env.NavigateError) as ctx:
      env.navigate_to("Zzz")
    self.assertIn("no known screen", str(ctx.exception))
    self.assertEqual(env.navigate_calls, 1)


class FakeLlm:

  def __init__(self, outputs: list[str]):
    self.outputs = list(outputs)
    self.prompts: list[str] = []

  def predict(self, prompt: str):
    self.prompts.append(prompt)
    out = self.outputs.pop(0)
    return out, True, {"raw": out}

  def drain_calls(self):
    return [{"input_tokens": 100, "output_tokens": 10}]


NAV_OUTPUT = 'Reason: the reachable list has Wi-Fi\nAction: {"action_type": "navigate_to", "label": "Wi-Fi"}'


class TieredAgentNavigateTest(unittest.TestCase):

  def test_graph_agent_executes_navigate_to_and_counts_it(self):
    client = graph_client()
    env = driver_env.OpenDriverEnv(None, "emulator-5554", "summary", client, graph=True)
    llm = FakeLlm([NAV_OUTPUT, "Arrived on Wi-Fi."])
    agent = tiered_agent.TieredAgent(env, llm)
    result = agent.step("Open Wi-Fi settings")
    self.assertFalse(result.done)
    self.assertEqual(result.data["navigate_call"], 1)
    self.assertIn("navigate-to", client.tools())
    self.assertEqual(result.data["after_observation"]["tier"], "navigate")
    self.assertIn(tiered_agent.NAVIGATE_TO_GUIDELINE, llm.prompts[0])
    self.assertIn("reachable screens:", llm.prompts[0])

  def test_a_refused_navigation_is_reported_to_the_model(self):
    client = graph_client({"reached": False, "error": "ambiguous target: 2 screens"})
    env = driver_env.OpenDriverEnv(None, "emulator-5554", "summary", client, graph=True)
    agent = tiered_agent.TieredAgent(env, FakeLlm([NAV_OUTPUT]))
    result = agent.step("Open Wi-Fi settings")
    self.assertEqual(result.data["navigate_call"], 1)
    self.assertIn("ambiguous target", result.data["summary"])

  def test_non_graph_agent_has_no_navigate_to(self):
    client = FakeClient({"describe:compact": {"description": COMPACT_ROOT}})
    env = driver_env.OpenDriverEnv(None, "emulator-5554", "compact", client)
    llm = FakeLlm([NAV_OUTPUT])
    agent = tiered_agent.TieredAgent(env, llm)
    result = agent.step("Open Wi-Fi settings")
    self.assertEqual(result.data["navigate_call"], 0)
    self.assertNotIn("navigate-to", client.tools())
    self.assertNotIn(tiered_agent.NAVIGATE_TO_GUIDELINE, llm.prompts[0])
    self.assertIn("Can not parse", result.data["summary"])


class RunAwArmsTest(unittest.TestCase):

  def test_default_arms(self):
    arms = run_aw.parse_arms("compact,graph-warm,graph-cold")
    self.assertEqual([a.name for a in arms], ["compact", "graph-warm", "graph-cold"])
    self.assertEqual([a.tier for a in arms], ["compact", "summary", "summary"])
    self.assertEqual([a.graph for a in arms], [False, True, True])
    self.assertEqual([a.warm for a in arms], [False, True, False])

  def test_unknown_arm_is_refused(self):
    with self.assertRaises(ValueError):
      run_aw.parse_arms("compact,graph-hot")

  def test_step_metrics_count_navigate_calls(self):
    m = run_aw.step_metrics(0, 12.0, {"navigate_call": 1, "llm_calls": []})
    self.assertEqual(m["navigate_calls"], 1)
    self.assertEqual(run_aw.step_metrics(1, 5.0, {"llm_calls": []})["navigate_calls"], 0)

  def test_aw2_pairs_warm_and_cold_by_task(self):
    def ep(task, arm, steps, api_in, ok):
      return {
          "task": task,
          "arm": arm,
          "n_steps": steps,
          "is_successful": ok,
          "navigate_calls": 1,
          "steps": [{"api_input_tokens": api_in / steps}] * steps,
      }

    episodes = [
        ep("A", "graph-warm", 3, 3000, 1.0),
        ep("A", "graph-cold", 6, 9000, 1.0),
        ep("B", "graph-warm", 4, 4000, 0.0),
        ep("B", "graph-cold", 4, 6000, 1.0),
        ep("C", "graph-cold", 5, 5000, 1.0),  # unpaired: no warm episode
    ]
    p = run_aw.aw2_pairs(episodes)
    self.assertEqual(p["pairs"], 2)
    self.assertEqual(p["steps_ratio"], round(7 / 10, 3))
    self.assertEqual(p["input_tokens_ratio"], round(7000 / 15000, 3))
    self.assertEqual(p["warm_ok"], 1)
    self.assertEqual(p["cold_ok"], 2)
    self.assertEqual(p["warm_only"], 0)
    self.assertEqual(p["cold_only"], 1)
    self.assertFalse(p["steps_met"] and p["tokens_met"] and p["success_non_inferior"])


class FakeRunner:
  """Records the commands `set_flag` would run (no node)."""

  def __init__(self):
    self.calls: list[tuple[list[str], dict]] = []

  def __call__(self, argv, **kw):
    self.calls.append((argv, kw))

  def scripts(self) -> list[str]:
    return [argv[-1] for argv, _ in self.calls]


class GraphHomeIsolationTest(unittest.TestCase):
  """The graph arms never touch the real ~/.argent (review round 1, M3)."""

  def setUp(self):
    import tempfile

    self.root = tempfile.mkdtemp(prefix="aw-test-")
    self.home = os.path.join(self.root, "home")
    self.store = os.path.join(self.home, ".argent", "screen-graph", "com.x", "1.json")
    os.makedirs(os.path.dirname(self.store))
    with open(self.store, "w") as f:
      f.write("{}")
    self._env = {k: os.environ.get(k) for k in ("HOME", "ANDROID_USER_HOME")}
    os.environ["HOME"] = self.home
    os.environ.pop("ANDROID_USER_HOME", None)

  def tearDown(self):
    import shutil

    for k, v in self._env.items():
      if v is None:
        os.environ.pop(k, None)
      else:
        os.environ[k] = v
    shutil.rmtree(self.root, ignore_errors=True)

  def test_temp_homes_live_outside_home_and_cleanup_removes_only_them(self):
    homes = run_aw.GraphHomes(base=os.path.join(self.root, "scratch"))
    a = homes.fresh()
    b = homes.fresh()
    self.assertNotEqual(a, b)
    for d in (a, b):
      self.assertTrue(os.path.isdir(d))
      self.assertFalse(os.path.abspath(d).startswith(os.path.abspath(self.home)))
    homes.cleanup(keep=b)
    self.assertFalse(os.path.exists(a))
    self.assertTrue(os.path.isdir(b))
    homes.cleanup()
    self.assertFalse(os.path.exists(b))
    self.assertTrue(os.path.isfile(self.store), "the real HOME's graph store survives")

  def test_fresh_home_carries_the_emulator_console_token(self):
    # Same transport on every arm: without the token the open server falls back
    # from the console redir to adb-forward (open-server-transport.ts).
    with open(os.path.join(self.home, ".emulator_console_auth_token"), "w") as f:
      f.write("tok123")
    homes = run_aw.GraphHomes(base=os.path.join(self.root, "scratch"))
    d = homes.fresh()
    with open(os.path.join(d, ".emulator_console_auth_token")) as f:
      self.assertEqual(f.read(), "tok123")
    homes.cleanup()
    self.assertTrue(os.path.isfile(os.path.join(self.home, ".emulator_console_auth_token")))

  def test_fresh_home_without_a_token_stays_empty(self):
    homes = run_aw.GraphHomes(base=os.path.join(self.root, "scratch"))
    d = homes.fresh()
    self.assertEqual(os.listdir(d), [])
    homes.cleanup()

  def test_tool_server_env_points_home_at_the_temp_dir_only(self):
    env = run_aw.tool_server_env(3001, "127.0.0.1", home="/tmp/aw-graph-home-x")
    self.assertEqual(env["HOME"], "/tmp/aw-graph-home-x")
    self.assertEqual(env["ANDROID_USER_HOME"], os.path.join(self.home, ".android"))
    self.assertEqual(env["ARGENT_PORT"], "3001")
    self.assertNotIn("ARGENT_AUTH_TOKEN", env)
    self.assertEqual(run_aw.tool_server_env(3001, "127.0.0.1")["HOME"], self.home)

  def test_read_global_flag(self):
    self.assertIsNone(run_aw.read_global_flag("screen-graph"))
    os.makedirs(os.path.join(self.home, ".argent"), exist_ok=True)
    with open(os.path.join(self.home, ".argent", "flags.json"), "w") as f:
      json.dump({"screen-graph": True}, f)
    self.assertTrue(run_aw.read_global_flag("screen-graph"))
    self.assertIsNone(run_aw.read_global_flag("screen-graph", home=os.path.join(self.root, "x")))

  def test_set_flag_targets_the_given_home_and_unsets_on_none(self):
    runner = FakeRunner()
    run_aw.set_flag("screen-graph", True, home="/tmp/h", runner=runner)
    run_aw.set_flag("screen-graph", None, runner=runner)
    (argv1, kw1), (argv2, kw2) = runner.calls
    self.assertIn('setFlag("screen-graph",true,"global")', argv1[-1])
    self.assertEqual(kw1["env"]["HOME"], "/tmp/h")
    self.assertIn('unsetFlag("screen-graph","global")', argv2[-1])
    self.assertEqual(kw2["env"]["HOME"], self.home)

  def test_flag_restored_puts_back_the_previous_value(self):
    os.makedirs(os.path.join(self.home, ".argent"), exist_ok=True)
    with open(os.path.join(self.home, ".argent", "flags.json"), "w") as f:
      json.dump({"screen-graph": True}, f)
    runner = FakeRunner()
    with run_aw.flag_restored("screen-graph", runner=runner):
      run_aw.set_flag("screen-graph", False, runner=runner)
    self.assertIn('setFlag("screen-graph",false,"global")', runner.scripts()[0])
    self.assertIn('setFlag("screen-graph",true,"global")', runner.scripts()[-1])

    os.remove(os.path.join(self.home, ".argent", "flags.json"))
    runner = FakeRunner()
    with self.assertRaises(RuntimeError):
      with run_aw.flag_restored("screen-graph", runner=runner):
        raise RuntimeError("episode crashed")
    self.assertIn('unsetFlag("screen-graph","global")', runner.scripts()[-1])


class RunWiringTest(unittest.TestCase):
  """`_run`: graph arms get their own fresh HOME, plain arms the real one (round 2)."""

  def setUp(self):
    import tempfile

    self.root = tempfile.mkdtemp(prefix="aw-run-")
    self.home = os.path.join(self.root, "home")
    os.makedirs(self.home)
    self._home = os.environ.get("HOME")
    os.environ["HOME"] = self.home
    self._saved = {}

  def tearDown(self):
    import shutil

    for name, value in self._saved.items():
      setattr(run_aw, name, value)
    if self._home is None:
      os.environ.pop("HOME", None)
    else:
      os.environ["HOME"] = self._home
    shutil.rmtree(self.root, ignore_errors=True)

  def patch(self, name, value):
    self._saved.setdefault(name, getattr(run_aw, name))
    setattr(run_aw, name, value)

  def test_arm_wiring(self):
    starts: list = []  # the HOME each tool-server start got (None = real HOME)
    flags: list = []
    episodes: list = []

    class Proc:
      def terminate(self):
        pass

      def wait(self, timeout=None):
        return 0

      def kill(self):
        pass

    def fake_start(port, host, home=None):
      starts.append(home)
      return Proc()

    def fake_episode(task_type, params, arm, aw_env, serial, client, llm, avd, warmup=False):
      # The store this episode sees lives in the HOME the server was started with.
      episodes.append((arm.name, warmup, starts[-1]))
      return {
          "task": task_type.__name__,
          "arm": arm.name,
          "tier": arm.tier,
          "n_steps": 1,
          "agent_signalled_done": True,
          "is_successful": 1.0,
          "error": None,
          "warmup": warmup,
          "navigate_calls": 0,
          "steps": [{
              "observation_tokens_ours": 1,
              "api_input_tokens": 10,
              "api_output_tokens": 1,
              "wall_ms": 1.0,
              "navigate_calls": 0,
          }],
      }

    class Task:
      complexity = 1

      @staticmethod
      def generate_random_params():
        return {}

    Task.__name__ = "FakeTask"

    class Registry:
      ANDROID_WORLD_FAMILY = "aw"

      def get_registry(self, family):
        return {"FakeTask": Task}

    class Client:
      def __init__(self, *a, **k):
        pass

      def wait_ready(self):
        pass

    class Env:
      def close(self):
        pass

    self.patch("start_tool_server", fake_start)
    self.patch("run_episode", fake_episode)
    self.patch("set_flag", lambda name, value, home=None, runner=None: flags.append((name, value, home)))
    self.patch("ToolServerClient", Client)
    self.patch("ClaudeWrapper", lambda **kw: object())
    self.patch("_avd_fingerprint", lambda serial: {})
    self.patch("registry", types.SimpleNamespace(TaskRegistry=Registry))
    self.patch(
        "env_launcher", types.SimpleNamespace(load_and_setup_env=lambda **kw: Env())
    )
    args = types.SimpleNamespace(
        tasks="FakeTask",
        arms="graph-warm,graph-cold,compact",
        tiers="compact,full",
        out_dir=os.path.join(self.root, "out"),
        tool_server_port=3001,
        model="m",
        effort="medium",
        console_port=5554,
        grpc_port=8554,
        serial="emulator-5554",
        run_id="t",
        task_random_seed=30,
        n_task_combinations=1,
    )
    self.assertEqual(run_aw._run(args), 0)

    initial, warm_home, cold_home, back = starts
    self.assertIsNone(initial)
    self.assertIsNone(back, "the plain arm after the graph arms runs on the real HOME")
    for h in (warm_home, cold_home):
      self.assertIsNotNone(h)
      self.assertFalse(os.path.abspath(h).startswith(os.path.abspath(self.home)))
    self.assertNotEqual(warm_home, cold_home, "graph-cold starts on a fresh, empty HOME")
    self.assertEqual(
        episodes,
        [
            ("graph-warm", True, warm_home),
            ("graph-warm", False, warm_home),
            ("graph-cold", False, cold_home),
            ("compact", False, None),
        ],
    )
    self.assertIn(("screen-graph", True, warm_home), flags)
    self.assertIn(("screen-graph", True, cold_home), flags)
    self.assertFalse(any(h is None and v for n, v, h in flags if n == "screen-graph"))
    self.assertFalse(os.path.exists(warm_home))
    self.assertFalse(os.path.exists(cold_home))
    self.assertFalse(os.path.exists(os.path.join(self.home, ".argent")))


class AwMinorsTest(unittest.TestCase):

  def test_tiers_is_a_deprecated_alias_of_arms(self):
    self.assertEqual(
        [a.name for a in run_aw.arms_from_args(None, "compact,full")], ["compact", "full"]
    )
    self.assertEqual(
        [a.name for a in run_aw.arms_from_args("graph-cold", "compact,full")], ["graph-cold"]
    )

  def test_warmup_episodes_get_their_own_cost_row(self):
    def ep(arm, api_in, warmup=False):
      return {
          "task": "A",
          "arm": arm,
          "tier": "summary",
          "n_steps": 1,
          "agent_signalled_done": True,
          "is_successful": 1.0,
          "error": None,
          "warmup": warmup,
          "navigate_calls": 0,
          "steps": [{
              "observation_tokens_ours": 10,
              "api_input_tokens": api_in,
              "api_output_tokens": 100,
              "wall_ms": 1000.0,
              "navigate_calls": 0,
          }],
      }

    md = run_aw.build_gates(
        [ep("graph-warm", 2000)], ["graph-warm"], {}, warmups=[ep("graph-warm", 7000, True)]
    )
    g5 = md[md.index("**G5**"):]
    self.assertIn("| graph-warm | 2000 | 100 |", g5)
    self.assertIn("| graph-warm warm-up (unscored) | 7000 | 100 |", g5)
    self.assertNotIn("warm-up", md[: md.index("**G5**")])


if __name__ == "__main__":
  unittest.main()
