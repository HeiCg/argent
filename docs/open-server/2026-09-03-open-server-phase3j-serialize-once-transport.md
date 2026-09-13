# Ticket: phase 3j — serialize once on device, compact the payload, kill the fixed ~40 ms adb-forward gap

Repo: ARGENT FORK. Continue in worktree `argent-p3i` on branch
`feat/android-open-server-p3i` (or branch `feat/android-open-server-p3j` from
its head; either is fine, say which). CI branch `feat/bench-ci-3i` (rebase the
workflow enforcement from 3h when it lands; keep step names identical). NO local
emulator/adb; CI only.

## Measured starting point (run 33784227150, x86_64 KVM, N=20, same-sample)

Idle describe p50: OFF 52, ON-uiautomation 106, ON-scrcpy 103. ON decomposition
(ms p50): server handle 64 = capture 37 (serialize 8 + encode 26 + root/windows
2) + response `toString` ≈ 27; server write+flush 0.39; host TTFB 64; host recv
(first→last byte) 40; host parse+render 0.85; RTT 104; wire 31877 B; ping 1.2.
Host recv is 40 ms for 31 KB and 41.5 ms for 168 KB: a fixed per-request cost,
not bandwidth. Low-contention run 33781603888 had ON 63 vs OFF 72 (met).

## Work, in order, each with a before/after by the same method in the same run

1. **Serialize once.** The handler builds the hierarchy JSON, calls
   `toString()` to time `encodeMs`, discards it, then `successResponse`
   re-serializes the whole tree. Emit the response by streaming: write the
   envelope prefix, stream the hierarchy JSON straight into the socket's
   buffered writer (or serialize once to a `String` and wrap without
   re-encoding), then the suffix + newline, flush once. `encodeMs` becomes the
   time of that single pass. Expected: −25 to −30 ms. Keep the `timings` block
   and the goldens byte-identical (the wire JSON may reorder keys; the host
   parse must not care — assert with the goldens).
2. **Compact payload (`compact:true`).** Server drops, before serializing, the
   nodes and fields the host v2 trim discards anyway: invisible nodes, nodes
   with no text/contentDescription/resourceId/clickable/etc. that the trim
   prunes, default-false booleans, empty strings, zero-size bounds (read the
   trim rules in `open-server-tree.ts` and port exactly those; anything the
   trim keeps must still arrive). Host output must stay byte-identical: the
   two golden tests are the contract, plus a new golden that feeds the same
   fixture through compact and non-compact paths and asserts identical
   `DescribeNode` trees. Report wire bytes before/after and the serialize time
   before/after. Describe uses compact by default; `compact:false` stays for
   raw dumps.
3. **The fixed 40 ms host-recv gap.** Hypothesis: Nagle on the sender of the
   last hop (host adb server → tool-server client) plus Linux delayed ACK
   (40 ms minimum) on our receiving socket; the final partial TCP segment of a
   multi-segment reply is held until the delayed ACK. Predictions: single-
   segment replies (ping) show no gap (true: 1.2 ms); any reply larger than one
   MSS shows ~40 ms regardless of size (true: 31 KB ≈ 168 KB); the Kotlin-side
   `tcpNoDelay` did not remove it because that hop is not the stalled one.
   Experiments in ONE CI run, each N=20 `getNestedState` RTT + recv gap:
   a. baseline via `adb forward` (as today);
   b. direct path via the emulator console `redir add tcp:<host>:<guest 9008>`
      (bypasses adbd and the adb server; sender on the last hop is qemu slirp);
   c. diagnostic only: pad the reply with trailing spaces to the next multiple
      of 1448 bytes before the newline and see whether the gap disappears
      (confirms the last-partial-segment theory; never ship padding);
   d. if (b) removes the gap, make it the default transport for emulators
      when the console port is known (serial `emulator-NNNN` ⇒ console NNNN;
      auth token from `~/.emulator_console_auth_token`), with `adb forward` as
      the fallback for physical devices; log which path is in use in the
      describe metadata (`transport: "redir" | "adb-forward"`).
   Report the four numbers with the run id.
4. **Same-run target.** After 1–3: idle describe ON ≤ OFF in the same run
   (OFF now ≈52 after the adb-spawn removal). Report OFF-1/ON-uia/ON-scrcpy/
   OFF-2 p50/p95, the same-sample decomposition table after, wire bytes,
   tokens (657/657), goldens status, `describe` after-tap row too (must not
   regress), and the fallback counter per block.

## Rules
Same as 3i: numbers name statistic/block/N/run id; a target is not a result;
never blend runs; OFF-1 vs OFF-2 drift stated per verb; adversarial review
before the scoreboard. Append "v11 / phase 3j" to
`/Users/heicg/Desktop/projects/device-farm/docs/specs/2026-09-02-open-vs-proprietary-results-v4.md`
with the tables above and the transport finding. Commit + push, report.
