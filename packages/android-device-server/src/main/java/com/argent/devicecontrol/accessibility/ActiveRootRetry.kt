package com.argent.devicecontrol.accessibility

/**
 * Bounded re-read of the active window root when the first read comes back null.
 *
 * Bench run 37561512651: a `getState` issued while no window is active (a freshly
 * started activity whose process was killed before its first frame, so its
 * ActivityRecord is on top with no window, until WindowManager removes it ~0.4 s
 * later) found no active root on either path of [NestedWindowSerializer.activeRoot]
 * and returned an empty tree with no retry. The host then left the open path.
 *
 * [resolve] re-reads up to [MAX_RETRIES] times, sleeping [RETRY_SLEEP_MS] before
 * each re-read, and stops early once [RETRY_BUDGET_MS] has elapsed (a single
 * `rootInActiveWindow` read can block ~200 ms mid-transition). A first read that
 * returns a root costs nothing extra. The caller reports [Result.attempts] and
 * [Result.retryMs] so the latency of a retried read is visible.
 *
 * Pure (the reader, sleeper and clock are passed in) so it runs as a plain JVM
 * unit test, like [WindowTimings].
 */
object ActiveRootRetry {
    const val MAX_RETRIES = 10
    const val RETRY_SLEEP_MS = 50L
    const val RETRY_BUDGET_MS = 500L

    /** Reason reported with `treeEmpty: true` when every read found no active root. */
    const val REASON_NO_ACTIVE_WINDOW = "no_active_window"

    /**
     * [value]: the first non-null read, or null when all reads were null.
     * [attempts]: reads made, including the first (1 = no retry).
     * [retryMs]: time from the end of the first read to the end of the last one
     * (0 when the first read returned a value).
     */
    data class Result<T>(val value: T?, val attempts: Int, val retryMs: Long)

    fun <T : Any> resolve(
        read: () -> T?,
        sleep: (Long) -> Unit,
        clock: () -> Long,
        maxRetries: Int = MAX_RETRIES,
        sleepMs: Long = RETRY_SLEEP_MS,
        budgetMs: Long = RETRY_BUDGET_MS
    ): Result<T> {
        val first = read()
        if (first != null) return Result(first, 1, 0)
        val start = clock()
        var attempts = 1
        while (attempts <= maxRetries && clock() - start < budgetMs) {
            sleep(sleepMs)
            attempts++
            val v = read()
            if (v != null) return Result(v, attempts, clock() - start)
        }
        return Result(null, attempts, clock() - start)
    }
}
