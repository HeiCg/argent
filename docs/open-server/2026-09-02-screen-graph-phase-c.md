# Ticket: Screen-graph Phase C — evaluation harness (cold/warm, tokens/step, RTT)

Design: `2026-09-02-screen-graph-architecture.md` §4; hypotheses H1–H4.
Depends on Phase A + B + A.1 in the ARGENT FORK worktree (not device-farm):
`/private/tmp/claude-501/-Users-heicg-Desktop-projects-device-farm-device-stream/f494020d-4d6d-4533-9918-a025d7c363ad/scratchpad/argent-sg`
(branch `feat/screen-graph`, remote HeiCg/argent).
Bench baseline script exists: `packages/tool-server/scripts/bench-open-vs-proprietary.ts`
on `origin/feat/android-open-server` after phase 3b lands (like-for-like
tap hold / pinch duration / final-UP sync / real-clock MotionInjector /
unified describe+await tree — see
`2026-09-02-open-server-phase3b-honest.md` and results-v3). FIRST:
`git fetch origin && git rebase origin/feat/android-open-server` in the
argent-sg worktree, resolve conflicts keeping both phase-3b fixes and
screen-graph behaviour, bump versionCode above the 3b one, full tool-server
vitest green, APK builds. B2 baseline numbers must come from the v3 report
(the v2 gesture "wins" were retracted as hold/duration artifacts — do not
cite them). Emulator `bench-api35` only when free (check `adb devices`;
boot with `-grpc 8554 -grpc-use-token`); never the physical device
`ZF524RZBHD`.

Additional required measurements (from the adversarial review of phase 3):
- Every config must assert hold/duration parity in the script itself
  (same `holdMs`, same `durationMs` on both backends) and fail loudly if
  a config deviates.
- Report per-verb ranges across the 3 repetitions, not single p50s.
- Tokens with `js-tiktoken` o200k_base (primary) and chars/4 (secondary).

## Configurations
B1 argent proprietary (flag off, vendored 0.22.1 binaries as in the baseline
bench); B2 open server, no graph; O1 open + query/diff observations (agent
asks `query`/`diff` instead of `describe`); O2 O1 + outcomes (no explicit
await/describe after actions when outcome says known/unchanged); O3 O2 +
screen graph cold (empty store); O4 = O3 re-run warm (store persisted from
O3); O5 O4 + `navigate-to` for tasks with a known target.

## Tasks (scripted, deterministic — no LLM in the loop for this phase)
Encode 10 Settings navigation/form tasks + 5 Chrome tasks as step lists
(the same tasks for every config; the "agent" is a scripted policy that
issues the observation calls each config allows and then the next action).
Each task ends with an assertion via `query` (element present) — success
= assertion true.

## Metrics per step and per task
tokens of every observation payload as the agent would see it (render
exactly what the tool returns; count with `js-tiktoken` o200k_base — add as
devDependency in tool-server if absent), RTTs to device, wall time, device
serialization time (from server `getInfo.traversals` delta and timing
fields), success. Report p50/p95 per config, cold vs warm ratio (O3 vs O4),
and per-hypothesis verdict: H1 O1 ≤ 0.5× B2 tokens on unchanged steps; H2
O2 removes ≥1 RTT/step; H3 O4 ≤ 0.2× O3 tokens on revisited screens; H4
success non-inferior.

## Output
`packages/tool-server/scripts/bench-screen-graph.ts` (opt-in), raw JSON
under `.bench-results/screen-graph/`, Markdown report at
`/Users/heicg/Desktop/projects/device-farm/docs/specs/2026-09-02-screen-graph-results.md`
(English, terse, numbers only), commit script locally.

## Acceptance
Report exists with all configs × tasks × ≥3 repetitions; hypotheses table;
emulator torn down.
