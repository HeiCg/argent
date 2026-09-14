# Open Android driver + screen-graph — planning index (moved here 2026-09-13)

This directory holds every spec, ticket, adversarial review and result of the effort to
make the open Android driver (Kotlin UiAutomation server + scrcpy fast-inject backend)
beat argent's proprietary backend, with like-for-like numbers that survive adversarial
review. The fork is the only home of this work from 2026-09-13 on.

## Where things are (2026-09-14)
- Working branch: `open/main` @ 61556ee5+ = driver (3h+3i, 3j disabled) + screen-graph
  (D→D.4.1, merged 2026-09-14) + bench workflow with all gates + 3k part B + 3k.1
  (pacing default = pre-3k legacy, drift opt-in via `ARGENT_SCRCPY_PACING=drift`,
  pre-registered fling gate, interleaved A/B) + outcome-path fix (tap/swipe/paste send
  `outcome` only when the screen graph records). `feat/bench-ci-d` superseded, never
  merged. `feat/run-script` = upstream PR #995.
- CI: `.github/workflows/bench-open-vs-proprietary.yml` (`workflow_dispatch`, inputs
  `suite=latency|screen-graph|both`, `sg_mode`); proprietary package fetched from npm at
  run time, never committed (its LICENSE forbids redistribution and reverse-engineering).
- Scoreboard (review-accepted numbers only): `2026-09-03-scoreboard.md`. Single
  reference run: **34813849446** (consolidated base, `suite=both`).
- Results: `2026-09-13-open-server-3k-results-ci.md` (latency + fling),
  `2026-09-13-screen-graph-phase-d4-results-ci.md` (screen-graph). Older:
  `2026-09-03-*-results-*.md`.
- Reviews: `2026-09-03-review-*` (3h, 3i, 3j, c3, c4, d1, d2, final),
  `2026-09-13-review-d4-findings.md` (REJECT), `2026-09-14-review-d4-1-findings.md`
  (ACCEPT-WITH-CAVEATS), `2026-09-14-review-3k-findings.md` (REJECT part A),
  `2026-09-14-review-3k1-findings.md` (ACCEPT-WITH-CAVEATS).
- Tickets in flight: `2026-09-14-open-server-phase3m-fingerprints-opt-in.md` (describe
  after tap). Decision pending with the owner:
  `2026-09-14-decision-fling-next-phase.md`.

## Verdict so far (run 34813849446, CI x86_64/KVM, N=20, p50 ms, within-run drift floor)
Wins: swipe 259 vs 296–300, pinch 307 vs 346–358, await-screen-idle 294 vs 501,
await-ui-element 45–47 vs 80, tokens/agent-step 21–179 vs 651–657 at 100/100 task
success in all seven screen-graph configs (success is at parity; tokens are the
differentiator). Parity: describe idle at p50 (14–18 ms slower at p95; the run-7 describe
win did not reproduce), tap RPC scrcpy 51 vs 53 (UiAutomation +25). Paste directional
only. First-attempt landing 100 % every block. Two open losses: (1) scrcpy fling
under-scroll at 150/0.3, 400/0.3, 400/0.5 (scrcpy/off 0.52 / 0.70 / 0.72, p <= 0.009),
present in the byte-equal pre-3k path, host pacing neutral, UiAutomation sends the same
8 frames and scrolls correctly, device-side arrival timing is the open lead; (2)
tap+describe(settle:false) ON 505/529 vs OFF 354/297 — root cause `TreeStore.ensure()`
inside the timed capture (ticket 3m in flight). Retired claims: "describe never slower",
"fling resolved by drift pacing", "B1 82 % is a rendering property".

## Execution order (next)
1. **3m** — fingerprints opt-in / no rebuild on the capture path (in flight); review;
   merge; the run becomes the new reference if its six gates pass.
2. **Fling decision** — owner picks A (hybrid: swipe via Kotlin, scrcpy tap/pinch) or B
   (device-stamped timeline through a forked scrcpy-server); see the decision doc. Then
   one ticket, one run, review.
3. Artemis-derived driver items (see `2026-09-13` note below): verified tap
   (`verify: {selector}` resolved on the live tree before injecting), execution incident
   persisted across steps, `gesture-sequence` for transient UI, index-based describe tier
   (measure tokens first).
4. Phase E — screen graph under dynamic content (Netflix-like): template edges per
   scrollable container, TTL/pruning, churn experiment on a real app. Not ticketed yet.
5. AndroidWorld with a fixed agent (Artemis Flash profile) swapping only the driver /
   observation tier: success, tokens/step, s/step. Needs a runner with an emulator.
6. Release: `open/main` distribution, package name, nightly device test; paper (design
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
