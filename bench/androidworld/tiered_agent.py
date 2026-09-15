"""tiered_agent.py — T3A with the observation slot swapped for our describe tier.

This is the FIXED agent. It reuses AndroidWorld's ``T3A`` verbatim — the same
``PROMPT_PREFIX``, ``GUIDANCE``, ``ACTION_SELECTION_PROMPT_TEMPLATE``, history
format ("Step N: <summary>"), summarization prompt, reason/action parsing and
``JSONAction`` grammar — and changes exactly ONE thing: the
``ui_elements_description`` no longer comes from
``_generate_ui_elements_description_list_full`` but from our tool-server
``describe`` at ``tier=<arm>`` (produced by ``OpenDriverEnv.get_state``). That,
and only that, is what makes the observation tier the single variable across
arms.

``step()`` is a faithful copy of ``t3a.T3A.step`` with two edits:
  * ``before_element_list`` / ``after_element_list`` are the tier text from the
    driver env (``env.last_observation.text``), not the AW serializer;
  * the ``m3a_utils.add_ui_element_mark`` call is dropped — it draws on a
    screenshot the open describe path never captures, and it is visualization
    only (it changes no prompt bytes).
It also records per-step metrics (observation tokens on our side + the LLM's own
``usage`` per call) into ``step_data`` so ``run_aw`` can attribute tokens/step
and cost per tier without a mean over tasks.
"""

from __future__ import annotations

from typing import Any

from android_world.agents import agent_utils, base_agent, infer, m3a_utils, t3a
from android_world.env import json_action

from driver_env import OpenDriverEnv


class TieredAgent(t3a.T3A):
  """T3A whose observation is our describe tier; grammar identical to T3A."""

  def __init__(self, env: OpenDriverEnv, llm: infer.LlmWrapper):
    super().__init__(env, llm, name=f"TieredAgent[{env.tier}]")

  def _observe(self) -> tuple[str, dict[str, Any]]:
    """Return (numbered tier text, observation metrics) for the current screen."""
    obs = self.env.last_observation
    if obs is None:
      return "", {}
    return obs.text, {
        "tier": obs.tier,
        "tokens_o200k": obs.tokens_o200k,
        "chars": obs.chars,
        "node_count": obs.node_count,
        "describe_source": obs.describe_source,
        "waited_ms": obs.waited_ms,
        "capture_ms": obs.capture_ms,
        "wire_bytes": obs.wire_bytes,
    }

  def step(self, goal: str) -> base_agent.AgentInteractionResult:
    step_data: dict[str, Any] = {
        "before_element_list": None,
        "after_element_list": None,
        "before_observation": None,
        "after_observation": None,
        "action_prompt": None,
        "action_output": None,
        "action_raw_response": None,
        "summary_prompt": None,
        "summary": None,
        "llm_calls": None,
    }
    print("----------step " + str(len(self.history) + 1))

    # Observation = our describe tier (get_post_transition_state -> env.get_state).
    state = self.get_post_transition_state()
    ui_elements = state.ui_elements  # our Node list; index-aligned with the text
    before_element_list, before_obs = self._observe()
    step_data["before_element_list"] = before_element_list
    step_data["before_observation"] = before_obs

    action_prompt = t3a._action_selection_prompt(
        goal,
        [
            "Step " + str(i + 1) + ": " + step_info["summary"]
            for i, step_info in enumerate(self.history)
        ],
        before_element_list,
        self.additional_guidelines,
    )
    step_data["action_prompt"] = action_prompt
    action_output, is_safe, raw_response = self.llm.predict(action_prompt)

    if is_safe is False:
      action_output = f"""Reason: {m3a_utils.TRIGGER_SAFETY_CLASSIFIER}
Action: {{"action_type": "status", "goal_status": "infeasible"}}"""

    if not raw_response:
      step_data["llm_calls"] = self._drain_calls()
      raise RuntimeError("Error calling LLM in action selection phase.")

    step_data["action_output"] = action_output
    step_data["action_raw_response"] = raw_response

    reason, action = m3a_utils.parse_reason_action_output(action_output)

    if (not reason) or (not action):
      print("Action prompt output is not in the correct format.")
      step_data["summary"] = (
          "Output for action selection is not in the correct format, so no"
          " action is performed."
      )
      step_data["llm_calls"] = self._drain_calls()
      self.history.append(step_data)
      return base_agent.AgentInteractionResult(False, step_data)

    print("Action: " + action)
    print("Reason: " + reason)

    try:
      converted_action = json_action.JSONAction(**agent_utils.extract_json(action))
    except Exception as e:  # noqa: BLE001 — mirror T3A's broad guard
      print("Failed to convert the output to a valid action.")
      print(str(e))
      step_data["summary"] = (
          "Can not parse the output to a valid action. Please make sure to pick"
          " the action from the list with the correct json format!"
      )
      step_data["llm_calls"] = self._drain_calls()
      self.history.append(step_data)
      return base_agent.AgentInteractionResult(False, step_data)

    if converted_action.action_type in ("click", "long_press", "input_text"):
      if converted_action.index is not None and int(converted_action.index) >= len(
          ui_elements
      ):
        print("Index out of range.")
        step_data["summary"] = (
            "The parameter index is out of range. Remember the index must be in"
            " the UI element list!"
        )
        step_data["llm_calls"] = self._drain_calls()
        self.history.append(step_data)
        return base_agent.AgentInteractionResult(False, step_data)
      # NOTE: T3A's add_ui_element_mark (screenshot visualization) is dropped —
      # the open describe path captures no screenshot and it changes no prompt.

    if converted_action.action_type == "status":
      if converted_action.goal_status == "infeasible":
        print("Agent stopped since it thinks mission impossible.")
      step_data["summary"] = "Agent thinks the request has been completed."
      step_data["llm_calls"] = self._drain_calls()
      self.history.append(step_data)
      return base_agent.AgentInteractionResult(True, step_data)

    if converted_action.action_type == "answer":
      print("Agent answered with: " + str(converted_action.text))

    try:
      self.env.execute_action(converted_action)
    except Exception as e:  # noqa: BLE001 — mirror T3A's broad guard
      print("Some error happened executing the action ", converted_action.action_type)
      print(str(e))
      step_data["summary"] = (
          "Some error happened executing the action "
          + str(converted_action.action_type)
      )
      step_data["llm_calls"] = self._drain_calls()
      self.history.append(step_data)
      return base_agent.AgentInteractionResult(False, step_data)

    self.get_post_transition_state()
    after_element_list, after_obs = self._observe()
    step_data["after_element_list"] = after_element_list
    step_data["after_observation"] = after_obs

    summary_prompt = t3a._summarize_prompt(
        goal, action, reason, before_element_list, after_element_list
    )
    summary, is_safe, raw_response = self.llm.predict(summary_prompt)
    if is_safe is False:
      summary = "Summary triggered LLM safety classifier."

    step_data["summary_prompt"] = summary_prompt
    step_data["summary"] = (
        f"Action selected: {action}. {summary}"
        if raw_response
        else "Error calling LLM in summerization phase."
    )
    print("Summary: " + summary)

    step_data["llm_calls"] = self._drain_calls()
    self.history.append(step_data)
    return base_agent.AgentInteractionResult(False, step_data)

  def _drain_calls(self) -> list[dict[str, Any]]:
    drain = getattr(self.llm, "drain_calls", None)
    return drain() if callable(drain) else []
