# 2026-10-07 — plan: beat the official argent on our bench, multi-device from one session, graph navigation

Goal (owner, 2026-10-07 /goal): finish the implementation plan and beat the
official argent 0.27.0 on our benchmark; let one Claude session control several
devices and emulators; focus on the screen-graph navigation feature.

State at planning time: `docs/open-server/2026-10-07-review-abba-run-37609765062.md`
(Android), `2026-10-07-ios4-siminput-plan.md` (iOS), memory handoff
`argent-handoff-2026-10-07`, researcher reports `research-multidevice.md`,
`research-screen-graph.md` (scratchpad, 2026-10-07).

## Where we lose today and what closes it

| front                     | gap                                                                                                                                                                                        | step                                                               |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| Android tap               | +1.2 ms vs OFF, stable                                                                                                                                                                     | accepted; no step (input manager already the fastest path)         |
| Android describe quality  | settle:true is a fixed 500 ms cap; settle:false returns 0 elements mid-transition                                                                                                          | `describe-retry-empty`, `settle-on-action`                         |
| Android swipe correctness | fling D1: momentum:false scrolls 491 > 384 px; device test red                                                                                                                             | `swipe-scroll-accessibility`                                       |
| iOS input                 | sim-input tap 190 / swipe 1467 ms vs OFF 65 / 593; sleeps overshoot 3.6-6.5×                                                                                                               | `ios-siminput-send-queue`, `siminput-registry-route`               |
| Bench evidence            | P5 is a stack win, cause of the 2× guest slowdown not isolated; P11 grades the wrong thing                                                                                                 | `bench-harness-p11-arms`, `bench-final-scoreboard`                 |
| Multi-device              | every tool takes `udid`; no session default, no fan-out                                                                                                                                    | `mcp-use-device`, `run-on-devices`                                 |
| Screen graph              | `navigate-to` only addressable by full hash or unique selector; store unbounded unless `ARGENT_SG_TEMPLATES`; 2 extra RPCs per hop; template search 8.7 s; LLM turns/tokens never measured | `sg-store-hygiene`, `navigate-to-addressable`, `sg-multihop-bench` |

## Steps (ids = plan.json)

### Wave 1

**ios-siminput-send-queue** (iOS-4 ticket 3). `packages/ios-sim-input`: the
process runs in the background on the macOS runner and its sleeps overshoot
(tap gap 179.5 ms for a 50 ms hold; swipe 1432 ms for 220 ms scheduled).
Contract: `ProcessInfo.processInfo.beginActivity(options: [.latencyCritical,
.userInitiated])` for the process lifetime; frame pacing on a monotonic
deadline (`mach_wait_until` or `DispatchSourceTimer` with `.strict` leeway 0),
never `usleep`/`Thread.sleep` chained per frame; dedicated serial send queue,
ack on Up carries per-message `recvAt/sendStart/sendEnd` (keep ticket-1
fields). Acceptance: unit test in Swift or in the TS service test that a
50 ms hold measures 50-60 ms host-side and 12 swipe frames at 20 ms land
within 240-290 ms (on this Mac, foreground); `swift build` green; bench
evidence later via `bench-ios` CI run (target tap ≤ 75 ms, swipe ≤ 300 ms p50).

**describe-retry-empty** (Android, product). In
`tools/describe/platforms/android/index.ts`: when the open server returns a
root with 0 elements and `treeEmpty=false`, re-read up to 2× 50 ms apart
before answering; add the "screen may be mid-transition" hint for a root
with 0 elements (today only when no windows). Fix the docs strings that call
`settle` a "500 ms idle-quiescence window" (`describe/index.ts`,
`android/index.ts`) to say what the code does (`waitForIdle(500)` cap).
Unit tests with a fake server: 0-elements then non-empty → one retry, hint
absent; 0-elements ×3 → hint present, 3 reads; non-empty first → 1 read.
Docs: `packages/docs/docs/reference/tools.mdx` describe entry.

**mcp-use-device** (multi-device A). In `packages/argent-mcp`: a per-session
default device, set by a new MCP tool `use-device {udid}` (answered by the
MCP process, not the tool-server) and by the first successful `boot-device`
or any call that carries a device id; `udid`/`device_id`/`device` become
optional in the exposed schema (`tool-mapping.ts`) and are injected in
`mcp-server.ts` when missing; `list-devices` output marks the default.
Error when no default and no id: one line naming `use-device`. Tests:
`tool-mapping.test.ts` (optional id in schema), new `use-device.test.ts`
(injection, override by explicit id, error path), `auto-capture.test.ts`
(capture uses the injected id). Docs: `reference/tools.mdx` + a paragraph
in `features/interacting-with-apps.mdx` "working with several devices".

**sg-store-hygiene** (screen graph, findings 8a-8c + default bounds). In
`tool-server/src/screen-graph/store.ts`: replace literal NUL separators with
`"\u001f"`; store `fnv1a(norm(text))` instead of item text in
`lastItemTexts` and compare hashes in `plan.ts`; pin expiry (pins decay
after N sessions without a visit) so the cap holds; make the bounded store
(300 nodes / 600 edges / 2 MB, LRU) the default whenever the `screen-graph`
flag is on, independent of `ARGENT_SG_TEMPLATES` (templates stay behind the
env). Tests: `screen-graph-store-bounds`, `-navigate-template`, `-plan`;
file is text for git (`git diff --numstat` shows lines, not `-`).

**swipe-scroll-accessibility** (fling D1 / graph step 3). Device server:
new RPC `scrollContainer {nodeId|resourceId, direction, count}` using
`ACTION_SCROLL_FORWARD/BACKWARD` on the container node, returning whether
the action was accepted and the post-scroll stable tree hash; plus record
`heldMs` and injector timing in the swipe reply. Host: `gesture-swipe` with
`momentum:false` on the open server prefers `scrollContainer` when the
target container is scrollable, falls back to the motion swipe otherwise;
`navigate-to` template search uses it. Acceptance: device test
`3d gesture-swipe — momentum:false scrolls less than default fling` green
in CI; template-search p50 ≤ 4 s and swipes-with-gap ≤ 5 % in the churn
bench (E-1 harness); `open-server-swipe-hold.test.ts` and
`screen-graph-navigate-template.test.ts` green. Requires versionCode bump.

### Wave 2

**settle-on-action** (contract change; owner approval before `step start`).
Settle belongs to the action: `gesture-tap`/`gesture-swipe`/`key` on the open
server accept `settle: true` meaning wait for the first accessibility event
(≤600 ms) then an 80 ms quiet window, cap 1500 ms, using
`TreeStore.settleAfterAction` (exists); the reply carries `settledMs` and
`timedOut`. `describe settle:true` keeps working but its doc says it is a
500 ms cap and recommends settling on the action. Tests: TS unit tests with
a fake server for both outcomes; bench variant `tap(settle)+describe`
added to the harness. Acceptance in the next ABBA run: correct-at-first-read
≥ 90 % on that variant with time-to-correct ≤ the await-idle variant.

**siminput-registry-route** (iOS-4 tickets 5+6). `ios-sim-input` as a
registry service per simulator (start, crash-restart, per-call timeout that
drops the pending entry, stop with the device); route product `gesture-tap`,
`gesture-swipe` and ASCII `type-text` to it under the open-iOS flag with a
visible fallback to the runner then simulator-server; physical devices
excluded. Tests: fake-spawn unit tests for the service lifecycle; routing
tests. Acceptance: bench ON-siminput `inputIsProductTool=true`, 0 fallbacks.

**bench-harness-p11-arms**. Harness: re-grade P11 on wrong reads (empty +
pre-transition) with the same Wilson rule; add arms `ON-im-bg` (ON-im with
a proprietary `simulator-server` spawned idle for the block) and
`OFF-devawait` (OFF whose await step uses the on-device await through the
open server) to the ABBA block list; load sampler records qemu per-thread
CPU (`/proc/<pid>/task/*/stat`, vCPU vs other) and host `/proc/stat`
idle/steal; scoreboard adds P5 decomposition (guest transition / await
floor / describe / rest) per arm. Tests: `gates.test.js`,
`load-sampler.test.js`, `logcat-timeline.test.js`.

**navigate-to-addressable** (screen graph step 1). `tools/navigate-to`:
targets by `label` and by hash8 prefix (ambiguous → fail closed listing
candidates); `describe tier=summary` lists reachable destinations with hop
count and hash8; skip the redundant `getState` after a hop when
`after.idHash === step.to`; return the compact tree of the final screen
only. Docs: new `features/screen-graph.mdx` (what is recorded, where,
privacy, flags) + `reference/tools.mdx` entries for `navigate-to`,
`describe tier`. Tests: `screen-graph-navigate`, `-plan`, `-describe`,
`-label`; new cases for label/hash8/ambiguity.

**run-on-devices** (multi-device B). New tool-server tool `run-on-devices
{udids[], steps[]}` built on `run-sequence` (same allowed-tool list), runs
the sequence per device with `Promise.allSettled`, serialised per device by
`device-mutex`, returns per-device results (ok/error, final screenshot
optional, `screenshots: "none" | "final"` default `none`); normalised
coordinates documented as device-local. Tests: `run-sequence.test.ts`
pattern + new `run-on-devices.test.ts` (2 fake devices, one failing, order
and isolation). Docs: `reference/tools.mdx`, the multi-device paragraph.

### Wave 3

**sg-multihop-bench**. `scripts/bench-screen-graph.ts`: a multi-hop block
(depth ≥ 3 in Settings, n ≥ 20) comparing `navigate-to` vs locate+tap+
describe per hop: hops, RPCs, wall time, success. AndroidWorld harness:
`navigate_to` action and `summary` tier in `tiered_agent.py`/`driver_env.py`,
warm-graph vs cold arm in `run_aw.py`, pre-registered: API input tokens and
steps ≤ 0.7× cold with non-inferior success, paired. Tests: bench unit
tests (`screen-graph-bench-*`), python unit tests if present.

**bench-final-scoreboard**. Trigger the CI runs (Android ABBA with the new
arms, iOS bench, screen-graph churn + multihop, AndroidWorld), read them,
adversarial review, publish `docs/open-server/2026-10-XX-scoreboard-vs-0.27.0.md`
with every number scoped (platform, environment, gate) and the explicit
answer to "better and faster than official": per verb, per platform, what is
driver-attributable. Update memory.

## Amendments

- 2026-10-07, `swipe-scroll-accessibility` (review rounds 1-2): the scroll
  action is OPT-IN (`gesture-swipe { scrollAction: true }`), never an implicit
  replacement of `momentum:false`, because flow `scroll-to` and drag depend on
  "lands where the finger lifts". Direction comes from the swipe vector only
  (up/left = forward). The motion swipe stays byte-identical to `open/main`
  plus telemetry (`heldMs`, `injectMs`, `releaseVelocityLsqPxPerS`). The
  fling defect D1 is NOT fixed by this step: an ease-out release was modelled
  (LSQ2 over the last 100 ms) to read a backward velocity, so no injector
  physics ships without a device run. Follow-up step `fling-d1-ci`: change
  the held-swipe release, prove it with device test 3d green in CI and the
  `releaseVelocityLsqPxPerS` telemetry, then promote swipe.
- 2026-10-07, `siminput-registry-route` (review rounds 1-2): under the
  `open-ios-device-server` flag, tap / swipe / ASCII text go to sim-input
  first, but a `momentum:false` swipe stays on the runner by default. The
  sim-input end hold (`holdEndMs` 120, the dispatch's dwell pulses) routes only
  with the experimental `ARGENT_SIM_INPUT_MOMENTUM_FREE=1`, because no
  simulator run has measured its fling (same rule: no injector physics ships
  without a device run). The bench ON-siminput arm sets it, ON-xcuitest sets
  `ARGENT_SIM_INPUT=off`; promotion needs a bench-ios CI run with ON-siminput
  VALID and `simInputAckTimeouts` 0. Secret text never goes to sim-input;
  per-key HID logging is removed and forwarded stderr is filtered. A sim-input
  timeout kills the process and rejects all pending calls (no late landing);
  `ARGENT_SIM_INPUT=off` is the kill switch.

- 2026-10-07, `sg-multihop-bench` (review rounds 1-3): the pre-registration is
  split. Cost claims (observation tokens ≤ 0.7× nograph, success non-inferior,
  tool-calls ratio reported without a bar because it is 2 vs 2k by
  construction) are graded with the graph target supplied by the harness.
  The discovery claim (can the model address a depth ≥3 target from the root
  `summary`?) is report-only: `targetInSummary` rate and `listedFromDepth` per
  task. With the current cap of 8 reachable screens and the Settings graph, a
  depth-3 target is never listed from the root (9 screens at hops 1-2 fill the
  cap); it is listed from the hop-1 screen. Summary cap / ordering is a product
  follow-up (`summary-cap`), not a bench defect. AW-2 pre-registration is
  unchanged. nograph uses `describe {tier:"compact"}` so both arms share one
  renderer. AW graph arms run the tool-server on a temporary HOME (emulator
  console token copied in); the real `~/.argent` is never touched.
- 2026-10-07, `settle-on-action` (review round 1): `gesture-swipe` takes
  `settleAfter`, not `settle` (the retired name of `momentum`, upstream #732).
- 2026-10-07, `settle-on-action`: the key tool is `button`; the reply carries
  `settled` (`quiet`|`timeout`|`no-event`) instead of `timedOut`.

## Rules that hold

Fable plans, Opus implements (one implementor per step, ≤2 agents on the
machine); every ticket cites `demerzel-tdd`, `demerzel-causa-raiz`,
`demerzel-evidencia`; red before green (`step red`); reviewer ≠ implementer;
docs in the same step; prettier before commit; no installs in worktrees;
runners with ≤2 workers; every claim on the scoreboard reviewed adversarially
before it is called a win.
