package com.argent.churnapp

import android.app.Activity
import android.os.Bundle
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

/**
 * The FALSE-MERGE regime (E-0 §F2): the toolbar title is CONSTANT ("Detail") and
 * the churning headline lives in the body inside a `ScrollView` (excluded from
 * `H_id`), so every item collapses onto ONE on-device node whose content is
 * silently overwritten. The template arm makes that merge EXPLICIT (one template
 * node with an `instances` count). Reachable by scrolling to the last rows; kept
 * so both regimes are exercisable in one build (harness taps the explosion rows).
 */
class DetailMergeActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val headline = intent.getStringExtra("headline") ?: "Headline"

        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val toolbar = LinearLayout(this).apply {
            id = R.id.detail_toolbar
            setPadding(32, 48, 32, 48)
        }
        toolbar.addView(TextView(this).apply {
            id = R.id.title
            text = "Detail"
            textSize = 22f
        })
        root.addView(toolbar)
        val scroll = ScrollView(this).apply { id = R.id.detail_scroll }
        scroll.addView(TextView(this).apply {
            id = R.id.detail_body
            text = headline
            setPadding(32, 32, 32, 32)
        })
        root.addView(scroll)
        setContentView(root)
    }
}
