# Review findings — phase 3j (serialize once, compact payload, redir transport)

Reviewer: read-only researcher agent, 2026-09-05. Code branch `feat/android-open-server-p3j`
@ 07f0999d, CI branch `feat/bench-ci-3j` @ 72f9a645. Runs 33807101442 (sha 8ecc9f46) and
33814712705 (sha 64441a88). Rules of evidence: `2026-09-03-review-3h-3i-c3.md`.

## Verdict: REJECT

Two blocking reasons. (1) `compact:true` is **not** output-preserving — four constructed
counterexamples make the host trim emit a *different* DescribeNode from the compacted
payload, and compact is ON BY DEFAULT for every describe (`android/index.ts:108`). The
"byte-identical" claim is proven only on the one idle-Settings screen. (2) **Neither run
executed the reviewed head.** 07f0999d (the commit that adds the `benchDebug` double gate
and `BENCH_PHASE3J_EXPERIMENT`) is not an ancestor of 64441a88 or 8ecc9f46; both runs ran
the UNGATED build where `_padTo`/`_benchLegacyEncode` are honored by any client.

The idle-describe headline itself is a valid measurement and is listed as scoreboard-grade
below.

## Findings

### A. Compact vs the host v2 trim (challenge 1)

Rule sets side by side. Trim (`uiautomator-parser.ts:402-500`), in order: NOISY_CLASSES drop
subtree (`:411`) → system chrome drop subtree (`:412`) → WebView sentinel (`:435`) →
ImageView passthrough (`:451`) → LAYOUT_CONTAINERS passthrough (`:457`) → invisible+no-kept-
children drop (`:461`) → descendantText borrow (`:470`) → duplicate-wrapper collapse (`:478`)
→ StaticText dedupe. Compact (`open-server-tree.ts:236-266`, mirrored in
`NodeSerializer.kt:100-180`) implements only two: scaffold hoist (ImageView/LAYOUT_CONTAINERS,
non-interactive, no label) and zero-area empty leaf drop. The two dropped rules are exactly
where it breaks.

1. CRITICAL — **scroll-clip is defeated by the hoist.** `pruneSubtree` (`uiautomator-parser.ts:
   380-392`) hands each node the clip it must enforce *on its own children*, so a scrollable
   N's clip fires one level down, at N's scaffold child. Compact removes that child
   (`open-server-tree.ts:251`), the grandchildren become N's direct children, and the clip
   never fires. Reproduced offline against the shipped sources: ScrollView[0,0,1080,1000] →
   LinearLayout(scaffold) → row at y=1500. Full tree emits 1 child ("VisibleRow"); compacted
   tree emits 2, adding "ScrolledOutRow" as a phantom tap target. ScrollView/RecyclerView over
   a bare LinearLayout is the commonest Android list shape. Fix: never hoist a scaffold whose
   parent (or self) is scrollable, or move the clip filter onto the node itself.
2. HIGH — **system chrome subtree escape.** `computeNodeOutput:412` drops a systemui node AND
   its subtree; compact hoists that node's children into a non-system parent, where they are
   re-evaluated. Reproduced both ways: a `com.android.systemui`-packaged FrameLayout and a
   `resource-id="com.android.systemui:id/…"` `android.view.View` each yield `children: []` on
   the full tree and one kept StaticText on the compacted tree. Fix: exclude
   SYSTEM_PACKAGES / SYSTEM_RID_PREFIXES from the scaffold predicate on both sides.
3. MEDIUM — **`[password]` lost from a borrowed label.** `descendantText` emits "[password]"
   for a password node even with empty text (`uiautomator-parser.ts:306-312`), but compact's
   rule 2 drops a zero-area label-less leaf regardless of `password`
   (`open-server-tree.ts:259`). Reproduced: clickable row label "[password] / Row" → "Row".
4. MEDIUM — NOISY_CLASSES (`com.horcrux.svg.*`) are safe by luck only: none is a
   LAYOUT_CONTAINER and none ends `.ImageView`, so the hoist cannot fire on them. Not asserted
   by any test.
5. HIGH — **golden coverage is thin.** `open-server-trim-golden.test.ts:167-210` runs compact
   over three fixtures: two hand-written toys and `describe-host-idle-settings.nested.json`,
   which the test labels "committed idle-Settings capture" but whose own header says
   "Synthetic but realistically shaped" (126 nodes). The ten popup/window goldens from 3g are
   NOT routed through compact — `open-server-window-goldens.test.ts` contains no `compact`
   reference. No fixture has a scroll container with an off-viewport child, systemui chrome,
   a WebView, or a password field.
6. HIGH — **no cross-language test.** `NodeSerializerCompactTest.kt` covers only the four pure
   predicates; nothing exercises `compactChildrenInPlace`/`compactNode`, and nothing asserts
   the Kotlin output equals `compactNestedRoots`. The equivalence is a code comment.
7. VERIFIED (positive) — on the one real screen the two implementations do agree exactly. The
   full capture from run 33792592764 (`real-nested-reply.json`, 163 nodes / 31317 B) compacts
   host-side to 73 nodes / 14481 B; the on-device compact capture in 33814712705 is 73 nodes /
   14483 B, and both lower to an identical DescribeNode. That is why tokens stayed 657 and
   Jaccard 1.0 — it is one screen, not a proof.

### B. 0.0.0.0 bind and redir (challenge 2)

8. VERIFIED — the bind decision is on-device from `ro.kernel.qemu` / `ro.boot.qemu`
   (`EmulatorDetect.kt:30-39`), called at `DeviceControlInstrumentation.kt:92-97`. Non-qemu
   emulators (Genymotion) and physical devices stay loopback-only unless `-e bindAll true`,
   which is logged at WARN (`:98`). Run 33814712705 proves the on-device path: the workflow
   deliberately does not set `ARGENT_OPEN_SERVER_BIND_ALL` (yml env comment, step "Latency
   bench") yet the redir arm reports `available=true`, so `allPort` came from the device.
9. HIGH — **redir mapping leaks on a failed proof.** `android-open-server.ts:604` assigns
   `redirHostPort` only AFTER the ping at `:602`. If `redirAdd` succeeds and the ping throws,
   the cleanup at `:611` sees `undefined` and never runs `redir del`. A host port then
   forwards into the guest's unauthenticated device-control server for the emulator's
   lifetime. Fix: capture `hostPort` in the outer scope before `redirAdd`.
10. MEDIUM — the 0.0.0.0 listener is started on every emulator regardless of whether redir is
    ever used (no console token, non-emulator serial, host that never calls). It carries no
    auth. Exposure is bounded by qemu slirp on a default AVD; it is not bounded on a bridged /
    tap-networked emulator. Whether the emulator binds the `redir` host port to 127.0.0.1 or
    0.0.0.0 was NOT verified (no emulator available to this review).
11. MEDIUM — `redir del` runs only on normal dispose (`:947-950`). A killed tool-server leaves
    the mapping. Loopback listener is unaffected and still present (`TCPServer.kt:46`).

### C. Bench-debug gating (challenge 3)

12. VERIFIED at head — `_padTo` honored only under `benchDebug` (`JsonRpcHandler.kt:113`),
    `_benchLegacyEncode` likewise (`StateHandler.kt:88`), `benchDebug` set only from
    `-e benchDebug true` (`DeviceControlInstrumentation.kt:74`), which the blueprint passes
    only when `ARGENT_OPEN_SERVER_BENCH_DEBUG=1` (`android-open-server.ts:374`). Real double
    gate, default off, not reachable from a normal client.
13. CRITICAL — **that gate was never run.** `07f0999d` is not an ancestor of either run's sha
    (`git merge-base --is-ancestor` → NO for 64441a88 and 8ecc9f46). Both runs used the
    ungated build. The diff 64441a88→72f9a645 touches `JsonRpcHandler.kt`, `StateHandler.kt`,
    `android-open-server.ts` and the bench script (50 insertions) — the shipped APK at head has
    no CI run behind it.
14. HIGH — **cross-request mutable state on a thread pool.** `TCPServer.kt:37` is a cached
    thread pool, one thread per connection, and `handle()` is not synchronized, yet the splice
    now depends on `stateHandler.lastTreeJson` (`StateHandler.kt:41`) and `handler.lastPadTo`
    (`JsonRpcHandler.kt:76`) surviving between `execute` and the write. Two concurrent
    `getState` calls on one listener can splice the wrong tree or ship the literal
    `__ARGENT_RAW_TREE_9f83c1__` string where the tree belongs. The "requests run serially on
    one connection thread" comment holds only for a single connection.

### D. A/B validity, timed window, run hygiene (challenges 4, 5, 8)

15. HIGH — **the four A/B arms are sequential, not interleaved** (`bench-open-vs-proprietary.ts:
    1018-1030`), and two of them are the SAME configuration. `encodeOnce` and `compactOn` both
    send `{compact:true}` on the serialize-once path, so their difference is pure position
    drift: run 33814712705 ON-uia handle 21.85 vs 19.07 p50 (2.78 ms), run 33807101442 ON-uia
    31.50 vs 23.25 (8.25 ms), N=20 each. In 33807101442 the claimed compact gain
    (compactOff 30.57 → compactOn 23.25 = 7.32 ms) is smaller than that 8.25 ms
    identical-config drift — **void as a handle-time result in that run**. In 33814712705 the
    gain is 6.08 ms against 2.78 ms drift, so at most ~3.3 ms is attributable. Wire bytes
    (31885 → 14967) and encodeMs (15 → 6) are deterministic and stand.
16. HIGH — **the A/B does not decompose the describe row.** Same block, same params, same
    transport, N=20 each, run 33814712705 ON-uia: timed idle describe reports server
    encodeMs p50 25, hostRtt p50 41.67, wire 14967; the `compactOn` arm reports encodeMs 6,
    hostRtt 19.72, wire 14967. A 2x server-side difference on an identical call. The describe
    loop runs first (`:1284`), the arms ~140 RPCs later (`:1379`). Mechanism unconfirmed
    (position/JIT is the only candidate I can support). Until a same-position A/B exists, the
    3j stage table cannot be read as "this is what describe costs".
17. HIGH — **the experiment is ON-only and runs before every verb except idle describe.**
    `runPhase3j` sits at `:1379`; `verbs.push` for gesture-tap onward is `:1420+` and
    `describeSplitAfterTap` is `:1466`. So in both runs the ON blocks got ~140 extra RPCs, a
    redir add/del and extra sockets that the OFF blocks never got, ahead of every row except
    describe. The idle-describe headline is unaffected (measured before). Every other ON row in
    these two runs is not like-for-like with OFF.
18. VERIFIED — the timed window is unchanged from 3i: `describeIdleLatencyWithStages`
    (`:585-617`) wall-clocks `reg.invokeTool("describe")` — tool call to rendered text — with
    3 warmups and the stages collected from the same N iterations. ON skips real work (compact
    payload, no adb spawn, redir) rather than measuring less.
19. MEDIUM — **no log line proves the timed describes used redir.** `transport` is plumbed to
    describe metadata (`contract.ts:118`, `index.ts:151`) but the bench never records it; the
    only `transport=` output is `console.debug` and appears in neither bench log. Evidence is
    indirect: describeIdle hostRecvMs p50/p95 0.244/0.349 in 33814712705 vs 0/40.444 in
    33807101442, same block, N=20.
20. MEDIUM — the stated mechanism ("any reply larger than one MSS shows ~40 ms") is wrong as
    written. In every adb-forward arm recv **p50 is 0** and only p95 is ~41 (33814712705
    ON-uia 0/40.99; ON-scrcpy 0/41.00). The stall hits a minority of replies. The padding
    diagnostic did not remove it (p95 40.86), so "last partial segment" is disproven; redir
    removing it points at the adb-server hop, which is the right conclusion from the wrong
    premise.
21. MEDIUM — the transport arms' own baseline is unstable: adb-forward rtt p50 19.69 (ON-uia)
    vs 41.92 (ON-scrcpy) in the same run. Only the recv-gap contrast is robust.
22. LOW — the claimed "hostRecvMs 0.24/0.35" and "recv 0.86 redir" mix blocks and runs. Per
    block, run 33814712705: ON-uia describeIdle 0.244/0.349, ON-scrcpy 0.279/0.412; redir arm
    ON-uia 0.327/1.186, ON-scrcpy 0.255/0.520.

### E. Workflow and device tests (challenges 6, 7)

23. VERIFIED — the gate is real and it is what turned the run red. `bench-open-vs-proprietary.yml`
    device-test step sets `set -o pipefail` before `npx vitest … | tee` (yml:256-259) and the
    final step `Fail the job if device tests failed` (yml:371-379) fires on
    `steps.devtest.outcome == 'failure'` after artifact upload. `gh run view 33814712705`:
    conclusion failure, the only failed step is "Fail the job if device tests failed". The
    latency step also sets pipefail (yml:279), so the `run_block` pipe no longer eats exits.
24. HIGH — **the device-test failure is mischaracterized.** 4/17 failed, but only three are the
    scrcpy fast-inject family. The fourth, `3f gesture-pinch + gesture-rotate`, is the Kotlin
    MotionInjector path (device-test.log:86, `expected 0 to be greater than 0.02`). All four
    assert a png diff of **exactly 0** — identical screenshots — which points at one common
    cause (input not landing, or a stale/frozen capture), not at a scrcpy-only regression, and
    contradicts "fixed on 3h".
25. VERIFIED — no verb regression beyond the drift floor vs run 33792592764 (the comparable
    pre-3j run: OFF-1 describe 52/53 in both). ON-uia/ON-scrcpy p50: gesture-tap 74/51 → 69/51,
    await-ui-element 76/77 → 33/33, await-screen-idle 508/507 → 458/459, paste 346/292 →
    298/300, tap+describe(settle:true) 510/394 → 469/379, (settle:false) 541/401 → 425/387.
    Run 33812265077 is not a usable comparator (its OFF-1 await rows are 4028 ms).
26. LOW — run time 33814712705 22:47:48→00:06:22Z = 1 h 18 m; 33807101442 = 1 h 15 m.

## Scoreboard-grade numbers

Run 33814712705, sha 64441a88 (NOT the branch head), x86_64 KVM hosted runner, N=20 per block.

| metric | OFF-1 | ON-uiautomation | ON-scrcpy | OFF-2 |
|---|---|---|---|---|
| describe idle p50/p95 ms, n=20 | 52/53 | 43/45 | 43/45 | 52/53 |
| describe tokens o200k, 1 sample | 657 | 657 | 657 | 657 |
| describe wire bytes p50, n=20 | n/a | 14967 | 14966 | n/a |
| describe hostRecvMs p50/p95, n=20 | n/a | 0.244/0.349 | 0.279/0.412 | n/a |
| ping p50/p95 ms, n=20 | n/a | 0.734/0.852 | — | n/a |

Fidelity Jaccard 1.0 on 17 keys (OFF-1 vs ON-uia). OFF-1 vs OFF-2 drift, p50 ms: describe 0,
gesture-tap 0, gesture-pinch 0, swipe 8, await-screen-idle 2, await-ui-element 4,
tap+describe 103, paste 160.

Deterministic, in-run, ON-uia, n=20 (run 33814712705): compact wireBytes 31885 → 14967;
server encodeMs 15 → 6. Transport recv gap, n=20 per arm: adb-forward p50/p95 0/40.99,
+pad1448 0/40.86, redir 0.327/1.186.

Void: "compact output is byte-identical" (findings 1-3); the compact handle-time gain in run
33807101442 (finding 15); any transfer of the A/B deltas to the describe row (finding 16);
every ON verb row other than describe in these two runs as like-for-like with OFF (finding 17);
the gating claim as *tested* (finding 13); "4/17 scrcpy family" (finding 24).

## Minimum to re-run

Fix findings 1-3 (or restrict compact to non-scrolled, non-system subtrees), add goldens for
scroll-clip / systemui / password / WebView and route the 3g window goldens through compact,
add a Kotlin↔host equivalence test on a real capture, fix the redir leak (9) and the splice
race (14), interleave or repeat the A/B arms at the describe loop's position, record
`transport` per describe in the block JSON, and run CI on the actual head.
