package com.argent.devicecontrol.accessibility

/**
 * Structural (H) and state (H_text) fingerprints of an accessibility tree
 * (Screen-graph Phase A, design §2.1 / §3).
 *
 * `H` identifies a *screen*: `(className, resourceId, quantized bounds, flags)`
 * per node in DFS order, EXCLUDING text. `H_text` adds `(text, contentDesc)` so
 * it identifies the screen's *state*. `quant` buckets bounds to 1/32 of the
 * screen dims to tolerate small layout jitter; `flags` is the actionability
 * bitmask `clickable|scrollable|editable|checkable|enabled|focused`.
 *
 * The hash is 64-bit FNV-1a over a canonical UTF-8 string. The EXACT same string
 * construction, field order, separators and constants are implemented host-side
 * in TypeScript (`packages/tool-server/src/utils/screen-hash.ts`); on an
 * identical tree the two produce the same hex, so a device hash can be compared
 * to a host-computed one. Edit the two in lockstep.
 */
object ScreenHash {
    // Flag bit positions — MUST match screen-hash.ts.
    const val FLAG_CLICKABLE = 1 shl 0
    const val FLAG_SCROLLABLE = 1 shl 1
    const val FLAG_EDITABLE = 1 shl 2
    const val FLAG_CHECKABLE = 1 shl 3
    const val FLAG_ENABLED = 1 shl 4
    const val FLAG_FOCUSED = 1 shl 5

    private val FNV_OFFSET = 0xcbf29ce484222325UL
    private val FNV_PRIME = 0x100000001b3UL

    // Field / record separators. Non-printable so they can't occur in a label.
    private const val US = '\u001F'
    private const val RS = '\u001E'

    private val SCROLLING_CONTAINERS = setOf(
        "RecyclerView", "ListView", "ScrollView", "HorizontalScrollView"
    )

    fun flagsOf(n: AxNode): Int {
        var f = 0
        if (n.clickable) f = f or FLAG_CLICKABLE
        if (n.scrollable) f = f or FLAG_SCROLLABLE
        if (n.editable) f = f or FLAG_EDITABLE
        if (n.checkable) f = f or FLAG_CHECKABLE
        if (n.enabled) f = f or FLAG_ENABLED
        if (n.focused) f = f or FLAG_FOCUSED
        return f
    }

    /** A scrolling container is hashed by container + its first child's class seq only. */
    fun isScrollingContainer(n: AxNode): Boolean {
        if (n.scrollable) return true
        return n.className in SCROLLING_CONTAINERS || n.className.startsWith("ViewPager")
    }

    private fun quant(v: Int, dim: Int): Int {
        if (dim <= 0) return 0
        return Math.floorDiv(v.toLong() * 32L, dim.toLong()).toInt()
    }

    /** H — structural, text-excluded, recycler rule applied. */
    fun structural(roots: List<AxNode>, screenW: Int, screenH: Int): String {
        val sb = StringBuilder()
        for (r in roots) appendStructural(r, screenW, screenH, sb)
        return fnv1a(sb.toString())
    }

    private fun appendStructural(n: AxNode, w: Int, h: Int, sb: StringBuilder) {
        sb.append(n.className).append(US)
            .append(n.resourceId).append(US)
            .append(quant(n.x1, w)).append(',').append(quant(n.y1, h)).append(',')
            .append(quant(n.x2, w)).append(',').append(quant(n.y2, h)).append(US)
            .append(flagsOf(n)).append(RS)
        if (isScrollingContainer(n)) {
            // Recycler rule (design §6): container node + the class sequence of
            // its FIRST child subtree only, so item count / content does not
            // change H. Remaining children are skipped for H.
            val first = n.children.firstOrNull()
            if (first != null) appendClassSeq(first, sb)
        } else {
            for (c in n.children) appendStructural(c, w, h, sb)
        }
    }

    private fun appendClassSeq(n: AxNode, sb: StringBuilder) {
        sb.append(n.className).append(RS)
        for (c in n.children) appendClassSeq(c, sb)
    }

    /** H_text — structural + (text, contentDesc), ALL children, no recycler rule. */
    fun state(roots: List<AxNode>, screenW: Int, screenH: Int): String {
        val sb = StringBuilder()
        for (r in roots) appendState(r, screenW, screenH, sb)
        return fnv1a(sb.toString())
    }

    private fun appendState(n: AxNode, w: Int, h: Int, sb: StringBuilder) {
        sb.append(n.className).append(US)
            .append(n.resourceId).append(US)
            .append(quant(n.x1, w)).append(',').append(quant(n.y1, h)).append(',')
            .append(quant(n.x2, w)).append(',').append(quant(n.y2, h)).append(US)
            .append(flagsOf(n)).append(US)
            .append(n.text).append(US)
            .append(n.contentDesc).append(RS)
        for (c in n.children) appendState(c, w, h, sb)
    }

    private fun fnv1a(s: String): String {
        var hash = FNV_OFFSET
        for (b in s.toByteArray(Charsets.UTF_8)) {
            hash = hash xor (b.toInt() and 0xFF).toULong()
            hash *= FNV_PRIME
        }
        return java.lang.Long.toUnsignedString(hash.toLong(), 16).padStart(16, '0')
    }
}
