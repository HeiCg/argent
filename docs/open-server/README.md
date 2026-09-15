# Open Android driver + screen-graph — planning index (moved here 2026-09-13)

This directory holds every spec, ticket, adversarial review and result of the effort to
make the open Android driver (Kotlin `android-device-server` with an on-device
`input-manager` touch injector) beat argent's proprietary backend, with like-for-like
numbers that survive adversarial review. The scrcpy fast-inject backend was removed in
phase 3n.2. The fork is the only home of this work from 2026-09-13 on.

## Where things are (2026-09-14)
- Working branch: `open/main` @ 00c10536 = driver (3h+3i, 3j disabled) + screen-graph
  (D→D.4.1) + bench workflow with all gates + 3k/3k.1 + 3m/3m.1 (fingerprints opt-in) +
  **3n/3n.1 Kotlin injection strategies, `input-manager` the shipped default** (merge
  11fcfdf4). Phase **3n.2** is **merged** (merge 86fe554b; lockfile regenerated d9df0f34) —
  scrcpy removed (the `@yume-chan/*` deps, the fast-inject backend + flag, the fling A/B
  stack) and the 3m.1 residual gate repaired. Phase **3n.3** (branch
  `fix/open-server-3n3-post-merge`, under review) applies the 3n.2-review post-merge fixes:
  a real on-device fallback gate (3N2-H1), `npm ci` restored on the regenerated lock
  (3N2-H2), screen-graph artifact hygiene + run-id stamping (3N2-H4), and the docs
  corrections. Also on `open/main`: the **iOS-1** open-iOS-server docs
  (`2026-09-14-ios-phase1-runner-on-contract.md` + spec + research; branch
  `feat/ios-open-server-1`, in flight).
- CI: `.github/workflows/bench-open-vs-proprietary.yml` (`workflow_dispatch`, inputs
  `blocks` (default `OFF-1,ON-uiautomation,ON-input-manager,OFF-2`), `n`,
  `suite=latency|screen-graph|both`, `sg_mode`); proprietary package fetched from npm at
  run time, never committed (its LICENSE forbids redistribution and reverse-engineering).
- Scoreboard (review-accepted numbers only): `2026-09-03-scoreboard.md`. Reference run
  for **latency / landing / availability / screen-graph / process**: **34870686468**
  (`input-manager` default, `suite=both`); scrcpy removal confirmed on the fully-green
  run **34888577404** (3n.2). **Fling stays OPEN, pinned to 34813849446** (metric repair
  = ticket 3o).
- Results: `2026-09-14-open-server-phase3n-kotlin-injector-replaces-scrcpy.md`
  ("Result (3n.1)" run 34870686468; "Result (3n.2)" run 34888577404),
  `2026-09-13-open-server-3k-results-ci.md`, `2026-09-13-screen-graph-phase-d4-results-ci.md`.
- Reviews: `2026-09-03-review-*`, `2026-09-14-review-3k1-findings.md`,
  `2026-09-14-review-3n1-findings.md` (accept run + promotion; P2 a 1 ms miss; fling arms
  void; conditions for 3n.2).
- Tickets: `2026-09-14-open-server-phase3n2-remove-scrcpy.md` (this phase, under review).
  Next up: ticket **3o** (fling metric repair). Decision doc:
  `2026-09-14-decision-fling-next-phase.md`.

## Verdict so far (reference run 34870686468, `input-manager` default; CI x86_64/KVM, N=20, p50 ms, within-run drift floor)
Wins: swipe 263 vs 303–305 (Δ −41, CI [−45,−34]), pinch 318 vs 353–354 (Δ −35.5, CI
[−43.5,−34]), await-screen-idle 305 vs ~498, await-ui-element 41 vs 76, tokens/agent-step
21–179 vs 651–657 at 100/100 task success in all seven screen-graph configs (success is at
parity; tokens are the differentiator). Parity: gesture-tap `input-manager` **54 vs 53**
(Δ +1 at a 0 floor — the pre-registered P2 inequality fails by 1 ms, planner-accepted as
parity; UiAutomation default +32). Headline `tap+describe(settle:false)` ratio ≤ 1.15
(within-run only; its OFF comparator drifts run-to-run — not a capability claim). First-
attempt landing 100 % every block; 0 `unavailable` fallbacks; `input-manager` availability
is per image/holder (the legacy `InputManager.getInstance()` holder, `InputManagerGlobal`
denied). No durable "beats the proprietary driver" wording — one image, one emulator.
**Fling stays OPEN** (metric does not reproduce itself; scrcpy arm removed; ticket 3o).
**3n.2 confirmation (run 34888577404, fully green):** scrcpy removed, four blocks; swipe
−30.5 / pinch −24.5 WIN, tap +2 (parity), device suite green with the **repaired residual
gate (1 ms, was 11 ms)** and P9 on tap/swipe/gesture, screen-graph green (O1 99/100,
`skippedNoIdHash` 1). Retired: "open wins swipe/pinch via scrcpy" (now `input-manager`;
scrcpy removed), "tap at parity via scrcpy" (input-manager +1 ms), "fling resolved".

## Execution order (next)
1. **3n.2 merged; 3n.3 post-merge fixes review + merge** — 3n.2 (scrcpy removal +
   residual-gate repair, run 34888577404 green) is merged. 3n.3
   (`fix/open-server-3n3-post-merge`) applies the review's post-merge fixes: the real
   on-device fallback gate (3N2-H1), the `npm install` → `npm ci` revert on both bench jobs
   over the regenerated lock (3N2-H2), screen-graph artifact hygiene + run-id stamping
   (3N2-H4), and the docs corrections. `package-lock.json` was regenerated in the main
   checkout (d9df0f34). No docs-site content changed this phase (`npx docusaurus build` +
   `npm run format` run in the main checkout only). 34870686468 stays the numeric reference.
2. **iOS-1 — open iOS server on the Android contract** (`2026-09-14-ios-phase1-runner-on-contract.md`,
   spec `2026-09-14-ios-open-driver-spec.md`, research `2026-09-14-ios-open-driver-research.md`);
   simulator CI first. Branch `feat/ios-open-server-1`, in flight.
3. **3o — fling metric repair** — the anchor-displacement fling metric does not reproduce
   itself between identical runs (the old scrcpy A/B is gone; the fling harness + 12 gate
   tests + 7 fixtures were deleted with scrcpy in 3n.2, so 3o starts from `775ae6fc` in git
   history). Build a metric that does, then one ticket, one run, review. Fling stays OPEN.
4. Artemis-derived driver items (see `2026-09-13` note below): verified tap
   (`verify: {selector}` resolved on the live tree before injecting), execution incident
   persisted across steps, `gesture-sequence` for transient UI, index-based describe tier
   (measure tokens first).
5. Phase E — screen graph under dynamic content (Netflix-like): template edges per
   scrollable container, TTL/pruning, churn experiment on a real app. Not ticketed yet.
6. AndroidWorld with a fixed agent (Artemis Flash profile) swapping only the driver /
   observation tier: success, tokens/step, s/step. Needs a runner with an emulator.
7. Release: `open/main` distribution, package name, nightly device test; paper (design
   doc + related work exist: `2026-09-02-screen-graph-architecture.md`,
   `2026-09-02-screen-graph-related-work.md`).

## iOS (2026-09-14)
Owner approved an open iOS driver. Spec `2026-09-14-ios-open-driver-spec.md`; research
`2026-09-14-ios-open-driver-research.md`. iOS-1 MERGED (607ddb80): `packages/ios-device-server`
(XCUITest runner on the Android NDJSON contract, from upstream `feat/ios-physical-devices`),
host blueprint behind flag `open-ios-device-server` (off), workflow
`ios-open-server-device-test.yml` (run 34904275293 green, 9/9 cases, Xcode 26.6 / iOS 26.5).
Next: iOS-2 bench (`2026-09-14-ios-phase2-bench.md`), iOS-3 screen graph on iOS, iOS-4
sim-input depth + physical CI. Android fling: `2026-09-14-open-server-phase3o-fling-metric.md`.

## Rules that paid for themselves
- One worktree per agent, under this clone (`git worktree add ../argent-fork-wt-<name>`),
  never under /tmp (wiped between sessions; the 3k WIP was lost that way). Commit early.
- Max 2 agents at once (machine-wide resource policy); no local emulator on the 24 GB
  host while agents run; CI only for device numbers.
- GitHub API quota is shared: one `gh run view` per 10 minutes per agent, in the same
  foreground Bash call after `sleep 540`; never a background monitor (they never woke).
- Every number names statistic, block, N and run id; never blend runs; OFF-1 vs OFF-2
  drift per verb is the noise floor; a target is not a result; adversarial review before
  any number enters the scoreboard.
- Effect oracle backend-independent (resumed activity), polled outside the timed window;
  per-iteration untimed locate; first-attempt verdict; symmetric gates.
- Before accepting any merge, diff the run's full verb table against the last accepted run
  at the drift floor (the screen-graph-d merge shipped a 10x tap/swipe regression behind a
  green gate). A same-run control arm beats a cross-run comparison every time. Gate rules
  are pre-registered before the run they grade. A fixture that is not verbatim from an
  artifact says "hand-built".

## 2026-09-13 note — what to take from google/artemis (Apache-2.0, Python)
Ideas, not code: pre-execution "XML-first, pixel fallback" target verification;
execution incident with consecutive-failure count kept in context; `click_sequence`
bursts for transient UI; dynamic-first locating with verified coordinate fallback;
element-index observations; compressed (not truncated) episode history (complementary to
the screen graph: episodic vs semantic memory). Not to take: adb-based injection, 15–40 s
multi-agent planning, the undocumented "99 % AndroidWorld" as a reference.
