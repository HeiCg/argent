# Ticket: screen-graph phase D.3 — close the D.2 review (harness locate, zero-step routes, labels)

Repo: ARGENT FORK, branches `feat/screen-graph-d` (from 6c29c835d) / `feat/bench-ci-d`,
worktrees `argent-c3` / `argent-c3-ci`. Read `2026-09-03-review-d2-findings.md` first.
NO local emulator/adb; CI only; one `gh run view` per 10 minutes, foreground.

## Must fix
1. **D2-H3 harness locate bug (all configs).** `locateNorm` uses contains + case-insensitive
   and taps `q.nodes[0]` (bench-screen-graph.ts:437-442, :475-481), so `t("Internet")`
   matches the toolbar "Network & internet" and the second step of
   `settings-network-internet` never reaches the Internet screen in any config (store
   edge 284ef030 --tap "Network & internet"--> 284ef030 count 25; needle "SIMs" lives on
   the origin screen so the dead step passes). Fix: whole-field exact match first, then
   exact contentDescription, then contains only when exactly one node matches; never tap
   `nodes[0]` of an ambiguous set (exclusion "locate ambiguous"). Give that task a needle
   that exists only on the Internet screen and confirm in pre-flight (full tree, presence
   on destination) that step 2 changes the H_id.
2. **D2-H1/H2 zero-step routes.** `navTarget` must be per STEP, not per task; a route
   with `totalSteps == 0` is not a routed tap: count it separately (`zeroStepRoutes`) and
   never as "routed"; the arrival check on a route must verify the H_id changed to the
   target (or that the route was non-empty), not only `queryPresent`. Republish O5 nav
   split as one-step / zero-step / fallback with N.
3. **M2/M3 edge invariant.** Extend the duplicate guard to EDGES: one (from H_id,
   selector) may have one destination; a second destination is a recording error (drop +
   count). `duplicateScreens()` and the edge invariant run in the bench after the matrix
   and fail the job in CI.
4. **M4 latency columns.** The doc must state that `actionRttMs` INCLUDES `recordMs` and
   the 2 500 ms settle wait inside open-config taps that B1 never pays; publish
   `actionRttMs − recordMs` per config and never compare open-config action latency to
   B1's without that note. Screen-graph compares tokens and success, not latency.
5. **M1/M5 doc cells from JSON only.** O4 Wilson [95,100] (not [93,99]); the H1 label
   says the ratio's p50 is bimodal (78 vs 76 of 155 at ≤138) and reports the mean ratio
   beside it; remove "moves with O1's selector policy".
6. **M6** `infraPreAction` fires only for pre-action infrastructure errors (device/adb/
   server unreachable), not any thrown task error; add a test.
7. **M7/LOW** "device H_id: UNVERIFIED" stays until the Kotlin test exists; `measuredRpc`
   counts every handle (drop the hand-written +2; instrument the bench's own await +
   queryPresent RPCs) and is reported as min/p50/max; pre-flight prints `reachedDistinct`
   and attempts used per task.

## Run and doc
One matrix run; regenerate the doc from JSON (D.2 to superseded with reasons); report
per-config table, O5 split (one-step / zero-step / fallback), edge invariant result,
H1–H4 with labels, the network-internet step-2 H_id change evidence. Push; no
device-farm commits.
