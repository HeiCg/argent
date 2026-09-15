package com.argent.churnapp

import android.app.Activity
import android.os.Bundle
import android.widget.LinearLayout
import android.widget.TextView

/**
 * The EXPLOSION regime (E-0 §F2): the churning headline is the toolbar TITLE, so
 * every item's detail gets a distinct on-device `H_id`. On the OFF arm that is
 * one node per item per session; the template arm's `destinationShape` is
 * text-free, so all of them collapse to ONE template node.
 */
class DetailActivity : Activity() {
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
            text = headline
            textSize = 22f
        })
        root.addView(toolbar)
        root.addView(TextView(this).apply {
            id = R.id.detail_body
            text = "Detail body for $headline"
            setPadding(32, 32, 32, 32)
        })
        setContentView(root)
    }
}
