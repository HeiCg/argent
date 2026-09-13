# Open Android driver + screen-graph — planning index (moved here 2026-09-13)

This directory holds every spec, ticket, adversarial review and result of the effort to
make the open Android driver (Kotlin UiAutomation server + scrcpy fast-inject backend)
beat argent's proprietary backend, with like-for-like numbers that survive adversarial
review. The fork is the only home of this work from 2026-09-13 on.

## Where things are
- Working branch: `open/main` = `feat/android-open-server-final` (driver 3h+3i+3j) +
  `feat/bench-ci-final` (bench workflow with all gates) + these docs.
- Not yet merged: `feat/screen-graph-d` (screen-graph D→D.3, plus the start of D.4) and
  `feat/bench-ci-d` (screen-graph matrix job). `feat/run-script` = upstream PR #995.
- CI: `.github/workflows/bench-open-vs-proprietary.yml` (`workflow_dispatch`, inputs
  `suite=latency|screen-graph|both`); proprietary package fetched from npm at run time,
  never committed (its LICENSE forbids redistribution and reverse-engineering).
- Scoreboard (review-accepted numbers only): `2026-09-03-scoreboard.md`.
- Latest results: `2026-09-03-open-vs-proprietary-results-final-ci.md` (run 33975063607),
  `2026-09-03-screen-graph-results-ci.md` (runs 33964414774 / 33976442407).
- Reviews: `2026-09-03-review-*-findings.md` (3h, 3i, 3j, c3, c4, d1, d2, final).

## Verdict so far (CI x86_64/KVM, N=20, same run, p50 ms)
Wins: swipe 257 vs 290, pinch 307 vs 338, await-screen-idle 461 vs 498, await-ui-element
31 vs 72, tokens/agent-step 22–179 vs 657 at equal task success. Describe idle never
slower than proprietary in three same-code runs, faster in two (magnitude not
reproducible). Parity: tap RPC 51 vs 52, tap+describe 298 vs 305. First-attempt tap
landing: scrcpy 59/60 (real ~1.7 % async drop). Loss: scrcpy fling under-scrolls 35–42 %
at 400 ms vs proprietary (reproducible; inferred cause: host paces one injectTouch per
frame). Compact payload (3j) disabled: not output-preserving.

## Execution order (next)
1. Merge `feat/screen-graph-d` + `feat/bench-ci-d` into `open/main` (code merge; one
   `suite=both` run must stay green).
2. **3k** — `2026-09-05-open-server-phase3k-fling-pacing-and-gates.md`. Decision taken:
   option (i): measure delivered-vs-requested duration/distance for all three arms from
   logcat, fix scrcpy pacing (drift-corrected writes without per-frame socket await, else
   device-side timeline), gate scrcpy/uia ±0.15 without whitelist, transparency rows
   scrcpy/off and uia/off; NO velocity tuning toward the proprietary curve. Then review.
3. **D.4** — `2026-09-05-screen-graph-phase-d4-symmetric-locate.md` (symmetric locate
   resolver for B1 and open configs; unique navTarget). Then review.
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

## 2026-09-13 note — what to take from google/artemis (Apache-2.0, Python)
Ideas, not code: pre-execution "XML-first, pixel fallback" target verification;
execution incident with consecutive-failure count kept in context; `click_sequence`
bursts for transient UI; dynamic-first locating with verified coordinate fallback;
element-index observations; compressed (not truncated) episode history (complementary to
the screen graph: episodic vs semantic memory). Not to take: adb-based injection, 15–40 s
multi-agent planning, the undocumented "99 % AndroidWorld" as a reference.
