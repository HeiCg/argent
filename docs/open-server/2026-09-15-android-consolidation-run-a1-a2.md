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
