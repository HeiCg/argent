# Ticket: Screen-graph Phase C.1 — valid success oracle, honest B1, re-run H4

Worktree: `/private/tmp/claude-501/-Users-heicg-Desktop-projects-device-farm-device-stream/f494020d-4d6d-4533-9918-a025d7c363ad/scratchpad/argent-sg`
(branch `feat/screen-graph` @ 7ed8bde9, pushed). Commit locally; do not push.
AVD `bench-api35` (`-grpc 8554 -grpc-use-token`); never `ZF524RZBHD`; poll
`adb devices` before booting (phase 3e / 3f may hold it).

Diagnosis (see results report note): B1 = 33% because (A) `locateViaDump`
silently failed and `runAction` tapped screen centre on `found:false`
(`bench-screen-graph.ts:367-397, 581-583`); (B) assertion oracle differs
per config (`policy.ts:112` → describe substring scan for B1, on-device
`query` for others); (C) the `query` oracle may over-match ("documentation"
non-empty on example.com).

## Fixes
1. **Locate is plumbing, identical for all configs.** Use the open-server
   `query` (or nested state) to locate targets in EVERY config including B1,
   exactly as the harness already documents ("NOT counted as an
   observation"). It requires our device server to be installed alongside
   argent's ADT under B1; UiAutomation is exclusive, so for B1: stop ADT
   instrumentation → start ours → locate → stop ours → restart ADT → act +
   observe via proprietary path. Time this switch and exclude it from every
   metric (record it as `plumbingMs`). If the switch is too slow (> 3 s per
   step), alternative: pre-compute all target coordinates per task in a
   single open-server pass before the B1 run (screens are deterministic
   from a fresh emulator + animations off) and replay by coordinate; state
   which was used.
2. **`runAction` aborts the task on `found:false`** (`locateFailed: true`,
   excluded from the success denominator, counted separately).
3. **One oracle for all configs**, off the metric path: on-device `query`
   with the matched nodes' text persisted in the JSON (`assertionMatches:
   [{text, id, bounds}]`). Use `text: { equals | contains }` semantics
   explicitly — inspect `toOpenSelector` (`:313`) and the Kotlin
   `ScreenSelector` contains-matching for case/whitespace/content-desc
   folding; make the oracle require the needle to appear in `text` or
   `contentDescription` of a VISIBLE node, case-insensitive, and log which
   field matched. Re-examine the Chrome tasks' needles ("documentation",
   "permission") against the actual page: fix the needle or the task so the
   oracle is unambiguous.
4. Give the assertion the same settle/retry on all configs (one
   `await-screen-idle`-equivalent + one re-query).
5. Report generator: H4 = "all configs vs B2 and vs B1, same oracle"; print
   locateFailed counts per config; remove the canned B1 text at
   `bench-screen-graph.ts:965-969`.

## Run
Full 7 configs × 15 tasks × 3 reps on a fresh emulator (B1 with vendored
0.22.1 binaries as before). Reuse nothing from pass1 for success metrics;
tokens/step may be cross-checked against pass1.

## Output
Replace `/Users/heicg/Desktop/projects/device-farm/docs/specs/2026-09-02-screen-graph-results.md`
with the v2 report (keep the old H1/H3 numbers in a "pass1" appendix for
provenance), including per-task success matrix per config and the matched
node text for every assertion. Tear the emulator down.

## Acceptance
- B1 success ≥ 90 % (if lower, the per-task failure list must name a real
  proprietary-path failure with the matched/unmatched node text as
  evidence — otherwise the harness is still wrong; keep fixing).
- H1/H3 within ±10 % of pass1; H4 stated against both baselines.
- Unit tests for the oracle (matching rules, locateFailed accounting).
