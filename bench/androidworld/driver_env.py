"""driver_env.py — the open-driver shim between AndroidWorld and our tool-server.

Shape (b) from research §2: OUR open-device-server is the ONLY thing the agent
observes and the ONLY thing that acts; AndroidWorld's own env is kept solely for
``initialize_task`` / ``is_successful`` / ``tear_down`` / adb (its checkers are
device-state assertions over adb, not screen assertions). The a11y forwarder is
never read by the harness, which side-steps the suppression blocker regardless of
the Step-0 outcome.

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

from android_world.env import actuation  # noqa: F401 — kept for reference parity
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
  ):
    self._aw_env = aw_env
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
    if wait_to_stabilize:
      try:
        self.client.call(
            "await-screen-idle", {"udid": self.serial, "timeoutMs": 4000}
        )
      except ToolServerError:
        pass
    data = self.client.call("describe", {"udid": self.serial, "tier": self.tier})
    text = data.get("description", "") or ""
    nodes, numbered = parse_describe(text)
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
