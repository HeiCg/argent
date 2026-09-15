"""ClaudeWrapper — an AndroidWorld ``infer.LlmWrapper`` backed by the Anthropic SDK.

AndroidWorld ships only ``GeminiGcpWrapper`` and ``Gpt4Wrapper``
(``android_world/agents/infer.py``); there is no Anthropic wrapper, so AW-1 adds
this one. It is the FIXED agent's brain: one model (``claude-opus-5``), one
``effort`` level, recorded in the run manifest, held constant across both
observation tiers so the tier is the only variable.

Contract (mirrors ``infer.LlmWrapper.predict``):
    predict(text_prompt: str) -> tuple[str, Optional[bool], Any]
    returns (text_output, is_safe, raw_output)

Design choices that make the benchmark honest:
  * temperature is NEVER forwarded — Claude Opus 5 rejects it (400), and the
    upstream Gpt4Wrapper's temperature=0 has no equivalent here.
  * thinking is left at the model default (adaptive, on for Opus 5); depth is
    pinned through ``output_config.effort`` and logged in the manifest — effort
    is part of the "fixed agent" definition, so changing it between tiers would
    void the comparison.
  * server-side refusal fallbacks are deliberately NOT enabled: a fallback would
    swap the model mid-run and break the one-model invariant. On a refusal we
    return ``is_safe=False`` (T3A turns that into a ``status: infeasible``).
  * every call records ``usage.input_tokens`` / ``usage.output_tokens`` — the
    authoritative token count for the tokens/step and cost gates (G2/G5). The
    tool-server's own ``js-tiktoken`` accounting stays for the observation-token
    side of the ledger.
"""

from __future__ import annotations

import os
import time
from typing import Any, Optional

import anthropic

# Sentinel returned by the upstream wrappers when the LLM call fails outright;
# T3A checks for a falsy raw_response and aborts the step, so we mirror it.
ERROR_CALLING_LLM = "Error calling LLM"

# Per the claude-api guidance: non-streaming default keeps a single action step
# well under the SDK's HTTP timeout while giving adaptive thinking room.
DEFAULT_MAX_TOKENS = 16000


class ClaudeWrapper:
  """Text-only Anthropic LLM wrapper compatible with ``infer.LlmWrapper``.

  It intentionally does NOT subclass ``infer.LlmWrapper`` at import time (so the
  module imports without ``android_world`` present, e.g. for unit inspection);
  it is duck-typed to the same ``predict`` contract T3A calls.
  """

  def __init__(
      self,
      model_name: str = "claude-opus-5",
      effort: str = "medium",
      max_retry: int = 3,
      max_tokens: int = DEFAULT_MAX_TOKENS,
  ):
    if "ANTHROPIC_API_KEY" not in os.environ:
      raise RuntimeError("ANTHROPIC_API_KEY is not set.")
    if effort not in ("low", "medium", "high", "xhigh", "max"):
      raise ValueError(f"Unsupported effort {effort!r}.")
    self.model = model_name
    self.effort = effort
    self.max_retry = min(max(max_retry, 1), 5)
    self.max_tokens = max_tokens
    self._client = anthropic.Anthropic()
    # Per-call token ledger; run_aw drains it per step to attribute API usage.
    self.calls: list[dict[str, Any]] = []

  RETRY_WAITING_SECONDS = 20

  def _record_usage(self, response: Any) -> None:
    usage = getattr(response, "usage", None)
    self.calls.append(
        {
            "input_tokens": getattr(usage, "input_tokens", None),
            "output_tokens": getattr(usage, "output_tokens", None),
            "model": self.model,
            "effort": self.effort,
        }
    )

  def drain_calls(self) -> list[dict[str, Any]]:
    """Return and clear the calls made since the last drain (one step)."""
    calls = self.calls
    self.calls = []
    return calls

  def predict(self, text_prompt: str) -> tuple[str, Optional[bool], Any]:
    """Call Claude with a text-only prompt.

    Returns (text_output, is_safe, raw_output) exactly like ``infer.LlmWrapper``.
    ``is_safe`` is ``None`` on success (we run no safety classifier of our own)
    and ``False`` when the model itself refuses.
    """
    wait_seconds = self.RETRY_WAITING_SECONDS
    counter = self.max_retry
    last_error: Optional[Exception] = None
    while counter > 0:
      try:
        response = self._client.messages.create(
            model=self.model,
            max_tokens=self.max_tokens,
            # effort is the one pinned knob; temperature is never sent.
            output_config={"effort": self.effort},
            messages=[{"role": "user", "content": text_prompt}],
        )
        self._record_usage(response)
        if getattr(response, "stop_reason", None) == "refusal":
          # The model declined; surface is_safe=False so T3A marks the task
          # infeasible instead of parsing an empty action.
          return ERROR_CALLING_LLM, False, response
        text = "".join(
            block.text
            for block in response.content
            if getattr(block, "type", None) == "text"
        )
        return text, None, response
      except anthropic.APIStatusError as e:
        # 4xx (bad request / auth) are not worth retrying; fail fast.
        last_error = e
        if 400 <= e.status_code < 500 and e.status_code not in (408, 409, 429):
          break
        time.sleep(wait_seconds)
        wait_seconds *= 2
        counter -= 1
      except anthropic.APIError as e:  # connection / 5xx
        last_error = e
        time.sleep(wait_seconds)
        wait_seconds *= 2
        counter -= 1
    print(f"Error calling Claude, giving up after retries: {last_error}")
    return ERROR_CALLING_LLM, None, None
