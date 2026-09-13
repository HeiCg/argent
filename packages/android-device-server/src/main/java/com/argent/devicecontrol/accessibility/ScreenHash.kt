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

    /**
     * Password bit (Phase B leftover B1), matching `FLAG_PASSWORD` (1 << 6 = 64)
     * in `packages/tool-server/src/screen-graph/types.ts`. Deliberately NOT part
     * of [flagsOf]: including it would change the structural / state hash of any
     * screen with a password field and break host↔device hash parity (which is
     * bits 0..5 only). It is layered onto the SERIALIZED `flags` of a compact
     * record (see [AxRecords.compact]) purely so the host can redact secrets.
     */
    const val FLAG_PASSWORD = 1 shl 6

    private val FNV_OFFSET = 0xcbf29ce484222325UL
    private val FNV_PRIME = 0x100000001b3UL

    // Field / record separators. Non-printable so they can't occur in a label.
    private const val US = '\u001F'
    private const val RS = '\u001E'

    private val SCROLLING_CONTAINERS = setOf(
        "RecyclerView", "ListView", "ScrollView", "HorizontalScrollView"
    )

    /**
     * Window-decor resource-ids that appear/disappear independently of the screen
     * (the status-bar / nav-bar backgrounds). Excluded from `H_id` so the same
     * screen hashes identically whether or not the decor node was captured
     * (screen-graph Phase D §1 — "exclude the status bar window").
     */
    private val SYSTEM_RIDS = setOf("statusBarBackground", "navigationBarBackground")

    /**
     * Text that is volatile between otherwise-identical screen states — a clock, a
     * battery/signal percentage, a size, a date, a bare counter. Kept in lockstep
     * with `VOLATILE_TEXT` in `packages/tool-server/src/screen-graph/plan.ts` and
     * the host `screen-hash.ts` twin. An identity title matching this is dropped
     * from `H_id` so a live counter cannot split a screen from itself.
     */
    private val VOLATILE_TEXT = Regex(
        "^\\s*(?:\\d{1,3}\\s*%|\\d{1,2}:\\d{2}(?:\\s*[ap]m)?|" +
            "\\d[\\d.,]*\\s*(?:%|min|hr|hrs|h|GB|MB|KB|B)?|" +
            "[A-Z][a-z]{2}\\s+\\d{1,2}|\\d{1,2}/\\d{1,2}(?:/\\d{2,4})?)\\s*$",
        RegexOption.IGNORE_CASE
    )

    fun isVolatileText(text: String): Boolean = VOLATILE_TEXT.matches(text.trim())

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

    /* ---------------------------------------------------------------------- */
    /* H_id — screen IDENTITY (screen-graph Phase D §1)                         */
    /* ---------------------------------------------------------------------- */

    /** A container whose id marks it as a toolbar / action-bar / app-bar. */
    fun isToolbarContainer(resourceId: String): Boolean {
        val r = resourceId.lowercase()
        return r.contains("toolbar") || r == "action_bar" || r.contains("app_bar")
    }

    /**
     * A node whose text is the screen's IDENTITY title: a collapsing-toolbar /
     * action-bar / dialog title, or a bare `title` sitting under a toolbar. The
     * Settings homepage's oversized `homepage_title` is deliberately NOT matched:
     * it collapses out of the tree on scroll (run 33806639520 roots 77a189ce vs
     * 299378e0), so keying identity on it would split one screen in two. Search
     * hints are excluded.
     */
    fun isIdentityTitle(resourceId: String, ancestorIsToolbar: Boolean): Boolean {
        val r = resourceId.lowercase()
        if (r.contains("search")) return false
        if (r.contains("collapsing_toolbar")) return true
        if (r == "action_bar_title" || r == "toolbar_title" || r == "actionbar_title" || r == "alerttitle") return true
        if (r == "title" && ancestorIsToolbar) return true
        return false
    }

    /**
     * H_id — the SCREEN identity used for graph node keys and routing (design D §1).
     * Unlike [structural] (`H`, which is scroll- and focus-sensitive: it appends a
     * scrolling container's first-child class sequence, quantised bounds and the
     * focus flag, so every Settings detail screen collapses onto one hash), `H_id`
     * is built to be STABLE across scroll and focus and DISTINCT across sibling
     * screens:
     *
     *   package
     *   + the texts of identity nodes (collapsing-toolbar / action-bar / dialog
     *     titles, and a `title` under a toolbar), volatile text dropped;
     *   + the resource-id MULTISET of non-scrollable subtrees, order-free;
     *   + for every scrolling container, `class#resourceId` ONLY — never its child
     *     sequence, never bounds.
     *
     * No bounds, no focus flags, no list content enter the hash. `H` and `H_text`
     * are unchanged (diff / awaitChange still use them). Same 64-bit FNV-1a and
     * US/RS separators as the other two, mirrored host-side in
     * `packages/tool-server/src/utils/screen-hash.ts` — edit the two in lockstep.
     */
    fun identity(roots: List<AxNode>, packageName: String): String {
        val titles = sortedSetOf<String>()
        val nonScrollRids = ArrayList<String>()
        val scTokens = sortedSetOf<String>()

        fun collectTitle(n: AxNode) {
            val t = (if (n.text.isNotEmpty()) n.text else n.contentDesc).trim()
            if (t.isNotEmpty() && !isVolatileText(t)) titles.add(t)
        }
        fun scanTitles(n: AxNode, ancestorIsToolbar: Boolean) {
            if (isIdentityTitle(n.resourceId, ancestorIsToolbar)) collectTitle(n)
            val childToolbar = ancestorIsToolbar || isToolbarContainer(n.resourceId)
            for (c in n.children) scanTitles(c, childToolbar)
        }
        fun scanRids(n: AxNode, insideScroll: Boolean) {
            if (isScrollingContainer(n)) {
                scTokens.add("SC:${n.className}#${n.resourceId}")
                for (c in n.children) scanRids(c, true)
            } else {
                if (!insideScroll && n.resourceId.isNotEmpty() && n.resourceId !in SYSTEM_RIDS) {
                    nonScrollRids.add(n.resourceId)
                }
                for (c in n.children) scanRids(c, insideScroll)
            }
        }
        for (r in roots) {
            scanTitles(r, isToolbarContainer(r.resourceId))
            scanRids(r, false)
        }
        nonScrollRids.sort()
        val sb = StringBuilder()
        sb.append(packageName).append(US)
            .append("ID:").append(titles.joinToString("|")).append(US)
            .append("RID:").append(nonScrollRids.joinToString(",")).append(US)
            .append("SC:").append(scTokens.joinToString(","))
        return fnv1a(sb.toString())
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
