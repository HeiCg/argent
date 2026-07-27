# Repairing a broken flow

Flows break: layouts change, coordinates drift, screens come and go. Diagnose before re-recording.

## 1. Classify the outcome

| Outcome            | Signal                                                                  |
| ------------------ | ----------------------------------------------------------------------- |
| Success            | All steps passed and the final screenshot shows the expected state      |
| Hard error         | A step reports `ERROR` — the run stopped there                          |
| Silent misfire     | All steps completed but the final screenshot shows the wrong screen     |
| Partial divergence | An intermediate screenshot shows the wrong state though later steps ran |

Anything but success goes to diagnosis. For the silent cases, the flow's `echo` labels are the reference for what each screen should have looked like.

## 2. Diagnose

1. Note the failing step index and its error message.
2. `screenshot` to see where the app actually is.
3. `describe` or `debugger-component-tree` for the current element tree. `describe` shows less than the flow's tree — a testID missing from its output can still resolve as a selector.
4. Name the root cause in one sentence before changing anything:

| Root cause       | Symptoms                                                        |
| ---------------- | --------------------------------------------------------------- |
| Coordinate drift | The tap landed, but on the wrong element; elements have shifted |
| Missing element  | The target is not in the element tree at all                    |
| Wrong screen     | The screenshot shows an entirely different page                 |
| Timing           | The element exists but the tap fired before the screen settled  |
| State mismatch   | The first step fails — the `executionPrerequisite` was not met  |

## 3. Correct

Pick the lightest fix that addresses the diagnosis:

| Situation                                                                               | Fix                                                                                                                                                            |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One step, parameter-only change                                                         | Edit `.argent/flows/<name>.yaml` — the selector, coordinates, `bundleId`, text                                                                                 |
| One step, transient issue not worth persisting                                          | Run the corrected step and the remaining ones by hand; the YAML stays as it is                                                                                 |
| 2–3 steps broken, or a new intermediate screen                                          | Navigate to the state just before the divergence, `flow-start-recording` with the same name (overwrites), re-add the working prefix, then record the new steps |
| 3+ steps broken, unclear cause, or a profiling-comparison flow that must stay identical | Reset with `restart-app` and record from scratch under the same name                                                                                           |

## 4. Verify, and bound the retries

Re-run `flow-execute`.

- It passes → report what changed, e.g. "Fixed step 4: retargeted the tap from coordinates to `{ id: about-row }`".
- It fails at a **different** step → diagnose once more.
- This was already the second correction → **stop.** Report the diagnosis and recommend a full re-record or manual investigation.

**Hard cap: 2 correction cycles.** Never enter an unbounded fix loop.

## Recording habits that prevent breakage

- **Echo the expected state, not the action.** "On Settings > General, about to tap About" beats "Tap About" — during diagnosis it tells you what the screen should have shown.
- **Gate transitions with `await`, never a fixed delay.** An unmet wait stops replay at that step, so a mistimed step can never run blind. This removes the Timing failure mode outright.
- **Screenshot after critical navigation.** Raw `screenshot` steps put images in the run report, which is what you inspect during diagnosis.
- **Write a specific `executionPrerequisite`.** "App on the home tab, user logged in" — not "App running". Verify it with `screenshot` + `describe` before acknowledging.
- **Prefer `launch-app` / `open-url` over long navigation chains.** A deep link survives layout changes that a tap sequence does not.
- **Prefer selectors to coordinates.** When a coordinate tap is unavoidable, echo the target's label or testID alongside it so repair can find the element by name.
