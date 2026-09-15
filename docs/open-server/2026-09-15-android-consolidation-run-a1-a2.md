# Ticket: A3 — consolidation run on the merged head (A1 + A2 pending device coverage)

Base: `open/main` @ fb0eec03 (A1 verified tap + incident, A2 gesture-sequence + index tier
merged; both reviews `2026-09-15-review-a1-findings.md`, `2026-09-15-review-a2-findings.md`
left device-level items for "the next pre-registered run"). This ticket is that run.

## Work

1. Device suite additions (`packages/tool-server/test/blueprints/android-open-server.device.test.ts`),
   all through the tool registry (`invokeTool`), not the raw API:
   - A1-M4: `gesture-tap` with `verify` → refusal cases (`verify_not_found`,
     `verify_mismatch`) assert NO injection (device `injectStrategyCounts` unchanged) and
     the incident line appears in the next `describe`; a success clears it.
   - A2-M3: `gesture-sequence` with a `{kind:"wait"}` step; tool-level index tap
     (`describe tier:"index"` → `gesture-tap target:{index,version}`) navigates; the fixed
     stale-index case (navigate, then tap with the old version → `stale_index`, no
     injection); a two-target burst refuses `stale_index_in_burst`.
   - A2-M1 device half: on-device o200k token count for `describe tier:"index"` vs
     `tier:"compact"` on the Settings root and one sub-screen (N = 5 each, report medians).
2. One CI run `suite=latency`, default blocks, on the merged head. Pre-register (write in
   the Result before triggering): device suite green; every latency verb within its
   OFF↔OFF floor of run 34939934318 (A2-M4; `paste` floor 30 ms is the widest — report it);
   `injectStrategyCounts` unavailable = 0; landing 100 %.
3. Result: per-case outcomes, the on-device token pair, the verb table diff at floors,
   run id. Scoreboard: if the verb table holds, the planner adds ONE line "A1/A2 merged,
   default path unchanged (run <id>)" — nothing else.

## Process

Branch `feat/open-server-a3-consolidation`, worktree `../argent-fork-wt-a3` (never /tmp;
root `node_modules` symlinked; no npm install / gradle / emulator; vitest `--maxWorkers=2`;
Kotlin untouched). Do not touch `bench/androidworld/**` or the AW workflow (another agent).
Polling one `gh run view` per 10 min as a single background `sleep 540; gh run view` call;
never loop; one `gh run download`. PR to `open/main` for hygiene; prettier-clean. Do not
fast-forward `open/main`.

## Result — pre-registered gates (written 2026-09-15, BEFORE triggering the run)

Branch `feat/open-server-a3-consolidation` off `open/main` @ 227c706f, worktree
`../argent-fork-wt-a3` (root `node_modules` symlinked; no npm install / gradle /
emulator; Kotlin untouched). One CI run, `suite=latency`, default blocks
`OFF-1,ON-uiautomation,ON-input-manager,OFF-2`, on the merged head that carries the
seven new tool-level device cases. The gates below are fixed before the run grades
them (README rule: "Gate rules are pre-registered before the run they grade").

Reference run for the verb-table diff: **34939934318** (A2's latency run). Its
per-verb OFF-1↔OFF-2 drift is the noise floor this run must stay inside:

| verb              | OFF↔OFF floor (run 34939934318) |
| ----------------- | ------------------------------- |
| describe          | 0                               |
| gesture-tap       | 0                               |
| gesture-swipe     | 1                               |
| gesture-pinch     | 2                               |
| await-screen-idle | 5                               |
| await-ui-element  | 0                               |
| paste             | 30 (widest single verb)         |
| tap+describe      | 50 (composite)                  |

### Pre-registered pass conditions

1. **Device suite green** — the enforced device step passes, including the seven
   new A3 tool-level cases (report each case's name + outcome):
   - `A3 §1 (A1-M4)` gesture-tap `verify_not_found` via invokeTool: refusal issues
     no injection (`injectStrategyCounts` total unchanged), the incident header
     appears in the next describe, and a success advances the count and clears it.
   - `A3 §1 (A1-M4)` gesture-tap `verify_mismatch` via invokeTool: no injection,
     mismatch incident header.
   - `A3 §2 (A2-M3)` gesture-sequence with a `{kind:"wait"}` step: the wait
     pseudo-method runs (per-step `ms`, none skipped) and the burst navigates.
   - `A3 §2 (A2-M3)` tool-level index tap: `describe tier:"index"` →
     `gesture-tap target:{index,version}` navigates; injection advances.
   - `A3 §2 (A2-M3)` tool-level stale index: after navigating, the old
     index+version refuses `targetCode:"stale_index"` with no injection.
   - `A3 §2 (A2-M3)` two-index burst refuses `stale_index_in_burst` before any
     injection.
   - `A3 §3 (A2-M1)` on-device token medians `tier:"index"` vs `tier:"compact"`,
     N=5 each on the Settings root and one sub-screen (report the medians).
2. **Verb table within the floor** — every latency verb's OFF-1↔OFF-2 drift in this
   run is ≤ its floor above, and the ON-input-manager (default) vs OFF profile
   matches the reference (swipe/pinch/awaits win, gesture-tap accepted parity). The
   full verb table is diffed against 34939934318 at those floors; `paste` (30 ms) is
   the widest single-verb floor and is reported explicitly (every verb incl. paste).
3. **`injectStrategyCounts.unavailable` = 0** — no `unavailable` injection fallback
   in any block (0/total).
4. **First-attempt landing 100 %** — every block.

### Scoreboard rule (pre-registered)

If the verb table holds, the planner adds exactly ONE line to `2026-09-03-scoreboard.md`:
"A1/A2 merged, default path unchanged (run <id>)" — nothing else. This agent does not
edit the scoreboard and does not fast-forward `open/main`.
