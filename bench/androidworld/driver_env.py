"""driver_env.py — the open-driver shim between AndroidWorld and our tool-server.

Shape (b) from research §2: OUR open-device-server is the ONLY thing the agent
observes and the ONLY thing that acts; AndroidWorld's own env is kept solely for
``initialize_task`` / ``is_successful`` / ``tear_down`` / adb (its checkers are
device-state assertions over adb, not screen assertions).

The agent never reads AndroidWorld's a11y forwarder, but the harness still does:
``aw_env.reset()`` -> ``interface.reset`` -> ``_process_timestep`` ->
``get_a11y_forest`` reads it on EVERY reset and raises ``Could not get a11y
tree`` when it is empty. So the forwarder must stay bound while our server is
alive, which needs our UiAutomation to hold
``FLAG_DONT_SUPPRESS_ACCESSIBILITY_SERVICES`` for its whole lifetime (``-e
dontSuppressA11y true``). Run 37549293325 showed it does not: UiAutomator's
``UiDevice`` re-requests ``getUiAutomation(Configurator flags = 0)`` on
``waitForIdle`` / ``pressKeyCode``, and ``Instrumentation`` reconnects the shared
connection with flags 0, i.e. suppressing again after the first describe.

``OpenDriverEnv`` wraps a real AndroidWorld env and overrides exactly two things:
  * ``get_state()`` — reads our tool-server ``describe`` at ``tier=<arm>`` and
    builds an index<->node table (each describe line ends with a normalized
    ``(x, y, w, h)`` frame) so ``{"action_type":"click","index":N}`` resolves;
  * ``execute_action()`` — translates the 14 ``JSONAction`` types to our tools
    per the research §1 table (faithful to AndroidWorld's own
    ``actuation.execute_adb_action``, but in normalized coordinates through the
    tool-server instead of raw adb).
Everything else (``controller``, ``logical_screen_size``, ``hide_automation_ui``,
``reset``, ``close``, ...) is delegated to the wrapped env via ``__getattr__``.

AW-2 (screen graph arms, ``graph=True``): tier ``summary`` reads ``describe
tier=summary`` (the screen's label, affordances and the "reachable screens" the
model can name) and heads the indexed ``compact`` tree with it, so ``click``
keeps working; ``navigate_to(label)`` calls the ``navigate-to`` tool, and the
``compact`` tree in its reply is the observation the agent reads right after it
(no describe for that read).

The tool-server is reached over its HTTP surface (``ToolServerClient``): the
standalone server started by ``node packages/tool-server/dist/index.js start``
with the ``open-device-server`` flag on and no auth — the simplest stable entry
point (it needs only ``npm ci`` + ``tsc --build``, no ``@swmansion/argent``
bundle).
"""

from __future__ import annotations

import re
import subprocess
import time
from dataclasses import dataclass, field
from typing import Any, Optional

import numpy as np
import requests
import tiktoken

from android_world.env import adb_utils, interface, json_action

# Android keycodes for the select-all + delete that AndroidWorld's own
# input_text(clear_text=True) issues (actuation.execute_adb_action):
#   input keycombination 113 29   (KEYCODE_CTRL_LEFT + KEYCODE_A = select all)
#   input keyevent 67             (KEYCODE_DEL = delete)
_KEYCODE_CTRL_LEFT = "113"
_KEYCODE_A = "29"
_KEYCODE_DEL = "67"

# Each emitted describe line ends with the normalized frame tuple.
_FRAME_RE = re.compile(r"\(([-\d.]+),\s*([-\d.]+),\s*([-\d.]+),\s*([-\d.]+)\)\s*$")

_O200K = tiktoken.get_encoding("o200k_base")

# The tool-server describe reply has no screenshot; T3A saves state.pixels only
# for visualization, which the tiered agent skips — a 1x1 frame keeps any
# incidental `.copy()` safe.
_BLANK_PIXELS = np.zeros((1, 1, 3), dtype=np.uint8)


class ToolServerError(RuntimeError):
  pass


class NavigateError(RuntimeError):
  """``navigate-to`` refused or stopped short; the message is the tool's own."""


# A `navigate-to` screen address as the summary prints it for an unlabelled
# screen (its hash8, longer on a prefix collision); anything else is a label.
_SCREEN_ADDRESS_RE = re.compile(r"^[0-9a-f]{8,}$")


class ToolServerClient:
  """Minimal client for POST http://host:port/tools/<name>."""

  def __init__(self, base_url: str = "http://127.0.0.1:3001", timeout: float = 60.0):
    self.base_url = base_url.rstrip("/")
    self.timeout = timeout
    self._session = requests.Session()

  def call(self, tool: str, params: dict[str, Any]) -> dict[str, Any]:
    resp = self._session.post(
        f"{self.base_url}/tools/{tool}", json=params, timeout=self.timeout
    )
    if resp.status_code // 100 != 2:
      try:
        body = resp.json()
      except ValueError:
        body = {"error": resp.text[:300]}
      raise ToolServerError(
          f"{tool} -> HTTP {resp.status_code}: "
          f"{body.get('message') or body.get('error')}"
      )
    return resp.json().get("data", {})

  def wait_ready(self, attempts: int = 60, delay: float = 1.0) -> None:
    for _ in range(attempts):
      try:
        r = self._session.get(f"{self.base_url}/tools", timeout=5)
        if r.ok:
          return
      except requests.RequestException:
        pass
      time.sleep(delay)
    raise ToolServerError(f"tool-server not reachable at {self.base_url}")


@dataclass
class Node:
  """One describe line, index-aligned with the observation the agent reads."""

  index: int
  x: float  # normalized frame origin + size (0..1)
  y: float
  w: float
  h: float
  line: str

  @property
  def cx(self) -> float:
    return self.x + self.w / 2

  @property
  def cy(self) -> float:
    return self.y + self.h / 2


@dataclass
class Observation:
  tier: str
  text: str
  tokens_o200k: int
  chars: int
  node_count: int
  describe_source: Optional[str] = None
  waited_ms: Optional[float] = None
  capture_ms: Optional[float] = None
  wire_bytes: Optional[int] = None
  timings: Optional[dict] = field(default=None)


def parse_describe(text: str) -> tuple[list[Node], str]:
  """Number the frame-bearing describe lines into an index<->node table.

  Mirrors T3A's ``UI element {index}: ...`` convention so the model emits
  ``click{index}`` against the SAME numbering the driver resolves. Non-node
  context lines (headers, an execution-incident line) are dropped from the
  index space exactly as T3A drops elements that fail ``validate_ui_element``.
  """
  nodes: list[Node] = []
  numbered: list[str] = []
  for raw in text.splitlines():
    line = raw.rstrip()
    if not line.strip():
      continue
    m = _FRAME_RE.search(line)
    if not m:
      continue
    x, y, w, h = (float(v) for v in m.groups())
    idx = len(nodes)
    nodes.append(Node(idx, x, y, w, h, line.strip()))
    numbered.append(f"UI element {idx}: {line.strip()}")
  return nodes, "\n".join(numbered)


class OpenDriverEnv:
  """AndroidWorld-compatible env that observes + acts through our tool-server."""

  def __init__(
      self,
      aw_env: Any,
      serial: str,
      tier: str,
      client: ToolServerClient,
      graph: bool = False,
  ):
    self._aw_env = aw_env
    self.graph = graph
    self.navigate_calls = 0
    # The observation a navigate_to reply carries, served by the next get_state.
    self._pending: Optional[tuple[Observation, list[Node]]] = None
    self.serial = serial
    self.tier = tier
    self.client = client
    self.last_nodes: list[Node] = []
    self.last_observation: Optional[Observation] = None

  # Everything not overridden below (controller, logical_screen_size,
  # hide_automation_ui, reset, close, ask_question, orientation, ...) is the
  # wrapped AndroidWorld env's own behavior — that is what keeps its checkers,
  # adb and task lifecycle intact.
  def __getattr__(self, name: str) -> Any:
    return getattr(self._aw_env, name)

  # ----- observation: our describe tier -----------------------------------
  def get_state(self, wait_to_stabilize: bool = False) -> interface.State:
    if self._pending is not None:
      # The read right after navigate_to: its reply already holds the final
      # screen's compact tree, so it is the observation (no describe).
      obs, nodes = self._pending
      self._pending = None
      self.last_nodes = nodes
      self.last_observation = obs
      return interface.State(pixels=_BLANK_PIXELS, forest=None, ui_elements=nodes)
    if wait_to_stabilize:
      try:
        self.client.call(
            "await-screen-idle", {"udid": self.serial, "timeoutMs": 4000}
        )
      except ToolServerError:
        pass
    summary = None
    if self.tier == "summary":
      head = self.client.call("describe", {"udid": self.serial, "tier": "summary"})
      summary = head.get("description", "") or ""
      data = self.client.call("describe", {"udid": self.serial, "tier": "compact"})
    else:
      data = self.client.call("describe", {"udid": self.serial, "tier": self.tier})
    text = data.get("description", "") or ""
    nodes, numbered = parse_describe(text)
    if summary is not None:
      numbered = f"Screen graph:\n{summary}\n\nUI elements:\n{numbered}"
    self.last_nodes = nodes
    self.last_observation = Observation(
        tier=self.tier,
        text=numbered,
        tokens_o200k=len(_O200K.encode(numbered)),
        chars=len(numbered),
        node_count=len(nodes),
        describe_source=data.get("source"),
        waited_ms=data.get("waitedMs"),
        capture_ms=data.get("captureMs"),
        wire_bytes=data.get("wireBytes"),
        timings=data.get("timings"),
    )
    return interface.State(pixels=_BLANK_PIXELS, forest=None, ui_elements=nodes)

  def navigate_to(self, label: str) -> dict[str, Any]:
    """Run ``navigate-to`` to a screen named as the summary lists it.

    A hash8 goes as ``target.screen``, anything else as ``target.label``. On
    arrival the reply's ``compact`` tree becomes the next observation; a refusal
    or a route that stopped short raises :class:`NavigateError`.
    """
    name = label.strip()
    target = {"screen": name} if _SCREEN_ADDRESS_RE.match(name) else {"label": name}
    self.navigate_calls += 1
    data = self.client.call("navigate-to", {"udid": self.serial, "target": target})
    if not data.get("reached"):
      raise NavigateError(
          data.get("error")
          or f"navigate-to stopped on {data.get('finalScreen')!r} before {name!r}"
      )
    compact = data.get("compact") or ""
    if compact:
      nodes, numbered = parse_describe(compact)
      obs = Observation(
          tier="navigate",
          text=numbered,
          tokens_o200k=len(_O200K.encode(numbered)),
          chars=len(numbered),
          node_count=len(nodes),
          describe_source="navigate-to",
      )
      self._pending = (obs, nodes)
    return data

  # ----- action: our tools, faithful to actuation.execute_adb_action ------
  def execute_action(self, action: json_action.JSONAction) -> None:
    a = action.action_type
    if a in ("click", "double_tap", "long_press"):
      node = self._resolve(action)
      if a == "click":
        self._tap(node.cx, node.cy)
      elif a == "double_tap":
        self._tap(node.cx, node.cy)
        self._tap(node.cx, node.cy)
      else:
        self._long_press(node.cx, node.cy)

    elif a == "input_text":
      text = action.text or ""
      if not text:
        return
      if action.index is not None:
        node = self._resolve(action)
        self._tap(node.cx, node.cy)
        time.sleep(1.0)
      if action.clear_text:
        self._clear_text()
      self.client.call("keyboard", {"udid": self.serial, "text": text})
      self._key("enter")  # AW's input_text presses enter at the end

    elif a == "keyboard_enter":
      self._key("enter")
    elif a == "navigate_home":
      self._button("home")
    elif a == "navigate_back":
      self._button("back")

    elif a in ("scroll", "swipe"):
      self._scroll_or_swipe(action)

    elif a == "open_app":
      self._open_app(action.app_name or "")

    elif a == "wait":
      try:
        self.client.call(
            "await-screen-idle", {"udid": self.serial, "timeoutMs": 4000}
        )
      except ToolServerError:
        pass

    elif a in ("status", "answer", "unknown"):
      # Agent-protocol only — handled in the agent, never reaches the driver.
      return
    else:
      raise ValueError(f"Unsupported action_type: {a!r}")

  # ----- helpers -----------------------------------------------------------
  def _resolve(self, action: json_action.JSONAction) -> Node:
    idx = action.index
    if idx is None or int(idx) < 0 or int(idx) >= len(self.last_nodes):
      raise ValueError(
          f"index {idx} out of range (0..{len(self.last_nodes) - 1})"
      )
    return self.last_nodes[int(idx)]

  def _tap(self, x: float, y: float) -> None:
    self.client.call("gesture-tap", {"udid": self.serial, "x": x, "y": y})

  def _long_press(self, x: float, y: float) -> None:
    # No native long-press tool; a Down held 800 ms then Up via gesture-custom.
    self.client.call(
        "gesture-custom",
        {
            "udid": self.serial,
            "events": [
                {"type": "Down", "x": x, "y": y},
                {"type": "Up", "x": x, "y": y, "delayMs": 800},
            ],
        },
    )

  def _key(self, key: str) -> None:
    self.client.call("keyboard", {"udid": self.serial, "key": key})

  def _button(self, button: str) -> None:
    self.client.call("button", {"udid": self.serial, "button": button})

  def _clear_text(self) -> None:
    # Select-all + delete, exactly as actuation.execute_adb_action does over adb.
    self._adb(["shell", "input", "keycombination", _KEYCODE_CTRL_LEFT, _KEYCODE_A])
    self._adb(["shell", "input", "keyevent", _KEYCODE_DEL])
    time.sleep(1.0)

  def _adb(self, args: list[str]) -> None:
    subprocess.run(["adb", "-s", self.serial, *args], capture_output=True, timeout=30)

  def _swipe(self, x: float, y: float, to_x: float, to_y: float) -> None:
    self.client.call(
        "gesture-swipe",
        {"udid": self.serial, "x": x, "y": y, "toX": to_x, "toY": to_y},
    )

  def _scroll_or_swipe(self, action: json_action.JSONAction) -> None:
    """Normalized-coordinate port of actuation's scroll/swipe.

    scroll: swipe from the (element or screen) centre toward the edge named by
    `direction` — the finger moves opposite to the content, so `direction=down`
    reveals lower content (end at y_min). swipe is the inverse from screen mid.
    """
    direction = action.direction
    if action.action_type == "scroll" and action.index is not None:
      node = self._resolve(action)
      x_min, y_min = node.x, node.y
      x_max, y_max = node.x + node.w, node.y + node.h
    else:
      x_min, y_min, x_max, y_max = 0.0, 0.0, 1.0, 1.0
    cx, cy = (x_min + x_max) / 2, (y_min + y_max) / 2

    if action.action_type == "scroll":
      ends = {
          "down": (cx, y_min),
          "up": (cx, y_max),
          "right": (x_min, cy),
          "left": (x_max, cy),
      }
      if direction not in ends:
        return
      self._swipe(cx, cy, *ends[direction])
    else:  # swipe — inverse of scroll, from screen middle
      mid_x, mid_y = 0.5, 0.5
      ends = {
          "down": (mid_x, 1.0),
          "up": (mid_x, 0.0),
          "right": (1.0, mid_y),
          "left": (0.0, mid_y),
      }
      if direction not in ends:
        return
      self._swipe(mid_x, mid_y, *ends[direction])

  def _open_app(self, app_name: str) -> None:
    if not app_name:
      return
    # Reuse AndroidWorld's app-name registry (a lookup, not an action) to get a
    # package, then launch through our tool-server. Fall back to AW's own
    # launcher for apps it opens by URI (_DEFAULT_URIS) or when unmapped.
    activity = adb_utils.get_adb_activity(app_name)
    if activity:
      package = adb_utils.extract_package_name(activity)
      self.client.call("launch-app", {"udid": self.serial, "bundleId": package})
      return
    adb_utils.launch_app(app_name, self._aw_env.controller)
