# Results: screen-graph Phase C — cold/warm, tokens/step, RTT

Generated 2026-09-03T01:24:03.574Z. Harness:
`packages/tool-server/scripts/bench-screen-graph.ts` (opt-in).

## Environment

| Item | Value |
|---|---|
| serial | emulator-5554 |
| reps | 3 |
| tasks | 15 |
| configs | O3,O4,O5 |
| tokenizer | js-tiktoken o200k_base (primary), chars/4 (secondary) |
| androidHome | /Users/heicg/Library/Android/sdk |
| startedAt | 2026-09-03T01:14:35.645Z |
| reran | O3,O4,O5 (this run, cold-store fix) |
| reused | B1,B2,O1,O2 (from bench-sg-2026-09-03T00-21-25-804Z.pass1.json) |

## Method & provenance

- Two-pass run. **B1, B2, O1, O2** are reused verbatim from the first full pass
  (`bench-sg-2026-09-03T00-21-25-804Z.pass1.json`, 7 configs x 15 tasks x 3 reps).
  **O3, O4, O5** were re-run this pass with the cold-store fix and merged in
  (`bench-sg-2026-09-03T01-14-35-645Z.json`). The `reran` / `reused` rows above
  record the split.
- First-pass O3 issue (why O3-O5 were re-run): in pass1 the cold config learned
  each screen mid-run and then treated later visits as known, so only 2 of 45 O3
  steps were actually cold (cold n=2) - not a credible cold baseline. The fix
  forces O3 to never consult the graph it populates (`knownScreen` is held false
  for O3; O4/O5 preload O3's persisted hashes), so this pass has O3 cold n=45 at
  629 tok/step - the true full-`describe` cost, matching B2 (629).
- The first re-run attempt aborted before any valid data: the long-lived emulator
  left by the interrupted run had a leftover `com.argent.androiddevtools`
  instrumentation holding UiAutomation, so both the open-server tree and the
  `uiautomator dump` fallback failed (`describe` -> "Failed to parse uiautomator
  dump output"). This pass ran on a freshly booted `bench-api35` (animations
  disabled); device server `com.argent.devicecontrol` 0.1.15 / versionCode 17.

## Per-step observation tokens (o200k_base) — p50 / p95

| Config | n steps | tok p50 | tok p95 | chars/4 p50 | RTT p50 (ms) | RTT count/step p50 | success |
|---|---|---|---|---|---|---|---|
| B1 | 45 | 657 | 669 | 473 | 177 | 2 | 33% |
| B2 | 45 | 629 | 846 | 449 | 85 | 2 | 100% |
| O1 | 45 | 67 | 514 | 53 | 2 | 2 | 100% |
| O2 | 45 | 54 | 514 | 32 | 2 | 2 | 100% |
| O3 | 45 | 629 | 846 | 449 | 83 | 2 | 98% |
| O4 | 45 | 40 | 107 | 34 | 55 | 1 | 100% |
| O5 | 45 | 40 | 115 | 34 | 79 | 1 | 100% |

## Hypotheses

| Hypothesis | Target | Measured | Verdict |
|---|---|---|---|
| H1 O1 tokens/step vs B2 (unchanged steps) | ≤ 0.5× | 0.107× | PASS |
| H2 O2 removes ≥1 RTT/step vs B2 | ≥ 1 | 0 | FAIL |
| H3 O4 tokens/step vs O3 (revisited) | ≤ 0.2× | 0.064× | PASS |
| H4 success non-inferior (±2 pp) to B1 | ≥ base − 2pp | **NOT MEASURED** (B1 baseline invalid — see note) | INCONCLUSIVE; vs B2 (100%): all O configs 100% / O3 97.8% |

## Cold vs warm (O3 vs O4)

- O3 cold (novel-screen) tokens/step p50: 629 (n=45)
- O4 warm (known-screen) tokens/step p50: 40 (n=45)
- cold/warm ratio (O4 warm / O3 cold): 0.064×
- O3 overall tokens/step p50: 629; O4 overall: 40
- O3 wall/task p50: 4179 ms; O4: 4223 ms

## Per-rep ranges across the 3 repetitions

| Config | tokens/step p50 per rep | success % per rep |
|---|---|---|
| B1 | 657 / 657 / 439 (range 439–657) | 33 / 33 / 33 |
| B2 | 629 / 629 / 629 (range 629–629) | 100 / 100 / 100 |
| O1 | 67 / 67 / 67 (range 67–67) | 100 / 100 / 100 |
| O2 | 54 / 0 / 54 (range 0–54) | 100 / 100 / 100 |
| O3 | 629 / 629 / 621 (range 621–629) | 100 / 100 / 93 |
| O4 | 40 / 40 / 40 (range 40–40) | 100 / 100 / 100 |
| O5 | 40 / 40 / 40 (range 40–40) | 100 / 100 / 100 |

## Per-config wall time / task (ms) — p50 / p95 / range

| Config | p50 | p95 | range |
|---|---|---|---|
| B1 | 4261 | 5299 | 3746–6209 |
| B2 | 4343 | 5789 | 3914–5909 |
| O1 | 4221 | 5511 | 3728–5725 |
| O2 | 5089 | 13138 | 3761–17760 |
| O3 | 4179 | 5322 | 3384–5843 |
| O4 | 4223 | 5219 | 3321–5265 |
| O5 | 4259 | 5342 | 3355–5608 |

## Notes

- Gesture-param parity gate passed: every config drove identical holdMs=50, swipeDurationMs=250 (asserted across configs; the run aborts otherwise).
- Token counts are of the exact payload the scripted agent would see per the config policy (describe / query / diff / graph-lookup summary); `none` steps cost 0.
- O3 is the cold baseline (empty store, never reuses the graph); O4/O5 preload the graph O3 persisted. cold/warm compares O3 novel-screen describe vs O4 known-screen graph-lookup.
- H2 counts action + observation round-trips. The open baseline (B2) already folds idle+tree into one describe RPC, and the navigation tasks change the screen every step, so O2's outcome has no unchanged step to skip against it — hence no RTT removed here. The saving materializes only on steps whose outcome reports no change.
- **B1 (argent proprietary) 33% is a harness artifact, not an argent deficiency — H4 vs B1 is retracted.** Post-hoc diagnosis of the raw JSON: (A) B1's `locateViaDump` never produced XML (the android-devtools instrumentation holds UiAutomation, the dump fails, the failure is swallowed) and `runAction` ignores `found:false`, so every B1 tap landed at screen centre — all failing Settings tasks show the identical 439-token "Connected devices" screen regardless of selector; `settings-connected` "passes" only because its assertion word happens to be on that screen. (B) The assertion oracle differs by config: B1 uses a substring scan over the rendered describe, the open configs use an on-device `query` — provably non-equivalent on the same screen (`settings-display`: same 653-token describe, B1 fails "brightness", query passes). (C) The open-path `query` oracle may over-match: it returns a non-empty set for "documentation" on example.com, a word not in the page body — so the 97.8–100% open-config success may itself be inflated. Until the harness (i) aborts on locate failure, (ii) uses one oracle for all configs, and (iii) persists the matched node text, H4 is not measurable. H1/H3 (tokens per step) do not depend on the oracle and stand.
- Emulator torn down after the run (see harness teardown).
