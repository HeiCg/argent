# Spec: script-runner hardening (port of argent PR #995 fix classes)

Date: 2026-09-01. Branch: `fix/ci-failures` (work on top of current uncommitted
tree — do NOT touch unrelated modified files). Repo root:
`/Users/heicg/Desktop/projects/device-farm`.

Context: we hardened argent's `run-script` tool (child-process isolation,
SIGTERM→SIGKILL, process-group kill, log tail on timeout, insertion-time log
caps, honest docs). This spec applies the same classes to our own runners.
Trust model differs: scripts here come from our own agent/hooks behind bearer
auth — goal is operational robustness + accidental-secret exposure, not
containment of hostile code. Docs fixes (CLAUDE.md, runbooks, READMEs) are
handled separately by the planner — do not edit .md files except where a task
below says so.

## P0-1: SIGTERM→SIGKILL escalation + settled promise
`device-stream/packages/dsl/src/script-runner.ts:104-117` uses
`execFileAsync(..., { timeout })` — default killSignal SIGTERM, no escalation.
A script with `process.on('SIGTERM', () => {})` survives; promise never
settles; caller hangs holding the MCP per-device mutex
(`mcp/src/dsl/register.ts:61`) or the hook chain.

Fix: replace with manual `spawn`/`execFile` wrapper: on deadline send SIGTERM,
after ~5s grace send SIGKILL, and settle the promise on the deadline regardless
of whether `close` fires (collect whatever stdout/stderr arrived). Copy the
proven pattern at `server/pipelines/internal/device-stream-executor.ts:50-54`.
Keep the existing result shape (stdout, stderr, exit info, timedOut flag or
equivalent) so `mcp/src/dsl/script-tool.ts` and
`server/hooks/internal/script-runner.ts` keep working.

## P0-2: process-group kill
Same file: spawn the child with `detached: true` and signal the group
(`process.kill(-pid, sig)`, fallback `child.kill(sig)` on throw). Reason:
DSL scripts shell out (`device-stream/packages/dsl/src/shell.ts:10` — adb,
xcrun); grandchildren must die with the script and must not hold the stdio
pipe open past the kill.

## P0-3: log tail on MCP timeout path
`mcp/src/dsl/script-tool.ts:117-121` — on `e.killed` returns only
"script timed out after Nms and was killed", discarding `e.stdout`/`e.stderr`.
Fix: append `capTail` of the captured output (same helper used on the success
path at :45-48, :112-113) to the timeout error message so the agent sees how
far the script got.

## P1-4: env allowlist for script children
`device-stream/packages/dsl/src/script-runner.ts:110-111` spreads raw
`process.env` — child (and every adb/xcrun grandchild) inherits
`DEVICE_FARM_TOKEN` (`mcp/src/index.ts:22`), `GITHUB_TOKEN`, DB URLs.

Fix: build the child env from a curated base instead of a full spread:
- passthrough by name: `PATH`, `HOME`, `TMPDIR`, `USER`, `SHELL`, `LANG`,
  `LC_ALL`, `NODE_ENV`, `NODE_OPTIONS`
- passthrough by prefix: `ANDROID_`, `JAVA_`, `XDG_`, `DEVICE_FARM_VAR_`
- plus the injected `DS_SCRIPT_*` vars (unchanged)
- plus an explicit escape hatch: `opts.extraEnv?: Record<string,string>`
  merged last, so callers can opt specific vars in.
Verify nothing in `device-stream/packages/dsl/src/` or the android/ios drivers
reads other env vars at runtime inside the child (grep `process.env` in the
dsl package and its driver deps; add any legitimately needed name/prefix to
the allowlist — e.g. anything go-ios/WDA/simctl paths need).
`DEVICE_FARM_VARS_JSON` should also pass through if the hook executor sets it.

## P1-5: pipelines masking gap (spec claim vs code)
`server/pipelines/internal/internal-clone-executor.ts:55` exports the password
via `opts.onExport('PASSWORD', account.password)` → `service.ts:585` puts it
in `ctx.exportedEnv` without registering it as a secret; masking only covers
values seen on `##device-farm[setvariable …]` lines
(`server/pipelines/internal/inter-stage-env.ts:37-38`), and each stage builds
a fresh parser with empty `secretValues`
(`device-stream-executor.ts:37-40`). Result: next stage can
`console.log(process.env.PASSWORD)` unmasked into `stage_log` events
(`service.ts:639`).

Fix (minimal): make callback-exported values flow into the secret set — e.g.
`onExport(key, value, { secret: true })` from the clone executor for PASSWORD
(and any credential-shaped key), persist those values in the pipeline context,
and seed every subsequently created `InterStageEnvParser`'s `secretValues`
with them. Do not build a general secret scanner.

## P2-6: cap inter-stage line buffer
`server/pipelines/internal/inter-stage-env.ts:47` — `buffer += chunk`
unbounded; newline-free flood grows server heap. Cap the pending line buffer
(e.g. 64 KB): on overflow, flush the truncated chunk as a log line (after
masking) and reset.

## P2-7: shell hook maxBuffer parity
`server/hooks/internal/hook-executor.ts:173-176` — shell path has no
`maxBuffer` (Node default 1 MB → ENOBUFS reported as hook failure). Pass the
same 16 MB the script path uses.

## P2-8: don't cache rejected session promise
`mcp/src/dsl/register.ts:100-102` — `cached ??= factory()` keeps a rejected
promise forever; one transient connect failure bricks all DSL tools. On
rejection clear `cached` (attach `.catch` that resets, still propagate the
error to the caller).

## P2-9: reserved vars keys
`device-stream/packages/dsl/src/script-runner.ts:66-77` — a `vars` key named
`ds`/`ctx`/`vars` produces a confusing redeclaration SyntaxError; `console`/
`process`/`require` silently shadow. Reject those keys up front with a clear
error listing the reserved names (throw before spawning).

## P2-10: startup sweep of .df-hook-tmp
Leftover `<projectRoot>/.df-hook-tmp/run-*` dirs accumulate after hard kills;
nothing sweeps them. Add a best-effort sweep of entries older than 24h,
invoked once from the script-runner module on first run (lazy, non-blocking,
errors swallowed). Keep it in the dsl package so both hook and MCP paths get
it.

## Tests
- script-runner (add to `device-stream/packages/dsl/tests/` or a new spec
  file colocated with existing test layout):
  - SIGTERM-ignoring script (`process.on('SIGTERM',()=>{}); while(true){}`
    or a long sleep loop) with short timeout → promise settles, timedOut,
    within timeout+grace+slack.
  - env allowlist: script printing `process.env.DEVICE_FARM_TOKEN` (set in
    parent for the test) sees undefined; `ANDROID_HOME` passes through.
  - reserved vars key `ds` → clear error before spawn.
- mcp (`mcp/__tests__/`): timeout result includes log tail marker printed
  before the hang; follow existing dsl-*.spec.ts mocking style.
- register cache: factory rejects once then resolves → second call succeeds.
- pipelines: unit test that a callback-exported secret value is masked in a
  later stage's parsed log line; buffer cap test with newline-free input.
- hook-executor shell path: output >1MB no longer errors (can simulate with
  smaller injected maxBuffer if faster).

## Acceptance
- `npm test` (server, repo root) green; `cd mcp && npm test` (or the repo's
  equivalent vitest invocation for mcp/__tests__) green;
  dsl package tests green (`device-stream/packages/dsl` — use whatever test
  script exists; if none, wire vitest minimally consistent with the monorepo).
- `npm run lint` (device-stream root tsc --noEmit) clean for touched packages;
  server `npm run build` clean.
- No changes to unrelated modified files in the working tree; do not commit —
  leave changes uncommitted on `fix/ci-failures` (tree already has uncommitted
  work being batched).
- Report per-item status + test counts.
