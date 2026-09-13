# Ticket: screen-graph phase D.2 — close the D.1 review caveats (no new hypothesis, honest accounting)

Repo: ARGENT FORK. Branches `feat/screen-graph-d` (from 757956c57) and
`feat/bench-ci-d`; worktrees `argent-c3` / `argent-c3-ci`. Read first:
`2026-09-03-review-d1-findings.md` (ACCEPT-WITH-CAVEATS), the D ticket, the results doc.
NO local emulator/adb; CI only; at most one `gh run view` per 10 minutes, foreground.

## Must fix (from the review)
1. **HIGH-1 — premature after-fingerprint mints nodes.** Store of run 33958064084 has two
   nodes labelled "Network & internet: Internet" (284ef030 visits 88, b2fbe915 visits 3)
   with byte-identical compact/resourceIds/stateHash and different H_id, reached by
   `tap{text:"Network & internet"}` AND `tap{text:"Sound & vibration"}`, plus an edge
   root→root for "Network & internet". That is an after-observation taken mid-transition.
   Fix: the recording's after-state must be taken only after settle (awaitChange with the
   existing settle heuristic + `quietMs`), and an edge is recorded only when the after
   H_id differs from the before H_id or the outcome says "no change"; add a store-level
   invariant test: no two nodes with identical compact + resourceIds + stateHash. Withdraw
   the doc claims "0 pollutant nodes" and "two H_id for one screen (scroll)"; restate the
   15 no-routes as a transition-timing race in recording.
2. **HIGH-2 — O5 RTT is modelled, not measured.** Instrument the real RPC count per O5
   step (navigate-to's getState/query/tap/getState + the bench's await/queryPresent) and
   publish it; drop the hand-written "2". Publish `actionRttMs` p50 per config next to it
   (O5 routed tap 1919 ms vs O4 1226 ms was in the records).
3. **M1** — doc says 20 000 resamples, code does 10 000 (`BOOTSTRAP_B`): make the doc
   read the constant from the JSON/env, never hand-typed.
4. **M2** — H3 tracks graph density (warm summary lists ≤6 outgoing edges): report
   out-degree with H3 and label warm vs cold payloads as the review states.
5. **M3** — the H_id tests validate a host twin (`src/utils/screen-hash.ts:164`, unused in
   src). Add a Kotlin unit test for `ScreenHash.identity` on captured trees (the store's
   nodes come from `TreeStore.kt:136`) and a cross-check test that host twin == device
   value on the same captured tree (fixture from the artifact). Until then the doc must not
   cite "H_id unit tests pass" as device stability evidence.
6. **M4** — state that 50/100 O5 runs have no known-target tap (O5 == O4 there) and that
   O5-pure covers 18 tasks; H4 for O5 is labelled low-power for routing.
7. **L1/L2/L3** — pre-flight: "destination unreachable — presence NOT verified" is not
   "ok"; count it as UNVERIFIED and print it in the gate summary (fail if any navigating
   task is unverified after 3 tries). `infraPreAction` must be set by the code paths it
   describes or removed. O3 is "graph-blind", say so in the doc.
8. **L4** — recording inside the awaited tap: publish `recordMs` per step for the open
   configs (it is outside the timed tool cost but inside the wall clock) so the ~1 s gap
   vs B1 is attributed.

## Run and doc
One matrix run after the fixes; regenerate the doc from JSON with a superseded block for
D.1; report per-config table, O5 nav split (must show the duplicate-node edges gone), the
measured O5 RPC count, H1–H4 with labels. Push; no device-farm commits.
