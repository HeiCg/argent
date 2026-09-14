package com.argent.devicecontrol.input

/**
 * Selectable touch-injection strategy for a single tap/swipe/gesture RPC
 * (phase 3n). The host passes the wire value on the `inject` param; absence (or
 * any unknown value) resolves to [DEFAULT] so the pre-3n behaviour is unchanged.
 *
 * The three explicit strategies exist so the bench can carry each as its own arm
 * in one CI run and compare RPC latency and scroll fidelity like-for-like against
 * the UiAutomation control arm:
 *
 *  - [UIA_SYNC]: every frame through `UiAutomation.injectInputEvent`, the final
 *    ACTION_UP injected SYNCHRONOUSLY — the RPC returns only after the whole
 *    gesture has been dispatched. This is what a swipe/gesture does by default
 *    today; naming it lets a tap opt into the same blocking-UP behaviour.
 *  - [UIA_ASYNC]: every frame INCLUDING the final UP through
 *    `UiAutomation.injectInputEvent(ev, sync=false)`; the RPC returns after the
 *    last injection call and the dispatcher drain is folded into the next read
 *    (the same async-UP tracker a default tap uses, drained by the next
 *    state/hierarchy capture) — an async-UP asymmetry that folds the drain into
 *    the next read, so the row stays like-for-like across arms.
 *  - [INPUT_MANAGER]: every frame through a reflective
 *    `android.hardware.input.InputManager.injectInputEvent(InputEvent, int)` with
 *    `INJECT_INPUT_EVENT_MODE_ASYNC`, carrying device timestamps from the
 *    timeline, carrying device timestamps. When the hidden API is
 *    blocked in this instrumentation process (hiddenapi policy) the RPC falls
 *    back to [UIA_ASYNC] and reports `strategy: "unavailable"` with the exception
 *    text; it NEVER silently changes `hidden_api_policy`.
 *
 * [DEFAULT] is call-site specific (a default tap keeps its async UP, a default
 * swipe/gesture keeps its synchronous UP), which is why it is a distinct value
 * rather than an alias of [UIA_SYNC] or [UIA_ASYNC].
 */
enum class InjectStrategy(val wire: String) {
    DEFAULT("default"),
    UIA_SYNC("uia-sync"),
    UIA_ASYNC("uia-async"),
    INPUT_MANAGER("input-manager");

    companion object {
        /** Parse the host `inject` param; null / "" / unknown → [DEFAULT] (unchanged behaviour). */
        fun fromWire(value: String?): InjectStrategy =
            when (value) {
                UIA_SYNC.wire -> UIA_SYNC
                UIA_ASYNC.wire -> UIA_ASYNC
                INPUT_MANAGER.wire -> INPUT_MANAGER
                else -> DEFAULT
            }
    }
}

/**
 * What an injection call actually did, surfaced on the RPC response so the host
 * (and the bench) can confirm the arm and detect a hiddenapi fallback.
 *
 * @property dropped any injected event was rejected by the dispatcher (R1).
 * @property strategy the strategy that RAN, as a wire value, OR `"unavailable"`
 *   when an [InjectStrategy.INPUT_MANAGER] request could not resolve the hidden
 *   API and fell back.
 * @property fellBackTo the strategy actually used when [strategy] is
 *   `"unavailable"` (always `"uia-async"`), else null.
 * @property error the reflection exception text when [strategy] is
 *   `"unavailable"`, else null.
 */
data class InjectOutcome(
    val dropped: Boolean,
    val strategy: String,
    val fellBackTo: String? = null,
    val error: String? = null
) {
    companion object {
        const val UNAVAILABLE = "unavailable"
    }
}

/**
 * Process-global count of injections per REPORTED strategy (phase 3n.1 P7). Every
 * `MotionInjector.inject` / `injectTaps` records the strategy it actually ran
 * (`default` / `uia-sync` / `uia-async` / `input-manager` / `unavailable`), so a
 * block's `getInfo` can report `injectStrategyReported` as a per-RPC count over the
 * whole block — not a single post-hoc probe (review 3N-M1). Each bench block runs a
 * fresh instrumentation process, so the counts are per-block. Thread-safe; the RPC
 * loop is serialized but the counter is shared, so a concurrent connection cannot
 * corrupt it.
 */
object InjectStrategyCounter {
    private val counts = java.util.concurrent.ConcurrentHashMap<String, Int>()

    fun record(strategy: String) {
        counts.merge(strategy, 1) { a, b -> a + b }
    }

    /** Immutable snapshot of the current counts, for `getInfo`. */
    fun snapshot(): Map<String, Int> = HashMap(counts)

    fun resetForTest() {
        counts.clear()
    }
}
