package com.argent.churnapp

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.BaseAdapter
import android.widget.HorizontalScrollView
import android.widget.LinearLayout
import android.widget.ListView
import android.widget.TextView

/**
 * The dynamic feed: a scrolling `ListView` of `items` seeded rows (title stable,
 * summary churning), a fixed collapsing-toolbar-style title bar, and a nested
 * horizontal carousel — the two-scrollable shape the containment resolver must
 * attribute correctly (design D1 option B). Launch:
 *   am start -n com.argent.churnapp/.FeedActivity --ei items 50 --ei seed 1001
 */
class FeedActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val items = intent.getIntExtra("items", 50)
        val seed = intent.getIntExtra("seed", 0)

        val root = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }

        // Fixed title bar — id contains "toolbar", child id "title" → folded into H_id.
        val toolbar = LinearLayout(this).apply {
            id = R.id.feed_toolbar
            setPadding(32, 48, 32, 48)
        }
        toolbar.addView(TextView(this).apply {
            id = R.id.title
            text = "Feed"
            textSize = 22f
        })
        root.addView(toolbar)

        // Nested horizontal carousel (always present so the feed H_id is stable).
        val carousel = HorizontalScrollView(this).apply { id = R.id.carousel }
        val strip = LinearLayout(this).apply { orientation = LinearLayout.HORIZONTAL }
        for (c in 0 until 5) {
            strip.addView(TextView(this).apply {
                id = R.id.carousel_item
                text = "Card $c"
                setPadding(48, 48, 48, 48)
                isClickable = true
                setOnClickListener { openDetail("Card $c", "Card headline $seed-$c") }
            })
        }
        carousel.addView(strip)
        root.addView(carousel)

        val list = ListView(this).apply { id = R.id.list }
        list.adapter = FeedAdapter(this, items, seed) { story, headline -> openDetail(story, headline) }
        root.addView(
            list,
            LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT
            )
        )

        setContentView(root)
    }

    private fun openDetail(story: String, headline: String) {
        startActivity(Intent(this, DetailActivity::class.java).apply {
            putExtra("story", story)
            putExtra("headline", headline)
        })
    }
}

/**
 * A recycling adapter — only ~a windowful of rows is ever materialized. The row
 * TITLE is its own clickable node so its text is EXACTLY `Story <i>` (stable),
 * which the graph keys the tap edge on; the SUMMARY churns with the seed so the
 * feed's `stateHash` moves every session (the volatile-content case).
 */
private class FeedAdapter(
    private val activity: Activity,
    private val count: Int,
    private val seed: Int,
    private val onOpen: (story: String, headline: String) -> Unit
) : BaseAdapter() {
    override fun getCount(): Int = count

    override fun getItem(position: Int): Any = position

    override fun getItemId(position: Int): Long = position.toLong()

    override fun getView(position: Int, convertView: View?, parent: ViewGroup?): View {
        val row = (convertView as? LinearLayout) ?: LinearLayout(activity).apply {
            id = R.id.row
            orientation = LinearLayout.VERTICAL
            setPadding(32, 40, 32, 40)
            gravity = Gravity.START
            addView(TextView(activity).apply { id = R.id.row_title; textSize = 18f; isClickable = true })
            addView(TextView(activity).apply { id = R.id.row_summary; textSize = 14f })
        }
        val story = Items.rowTitle(position)
        val headline = Items.rowSummary(seed, position)
        (row.getChildAt(0) as TextView).apply {
            text = story
            setOnClickListener { onOpen(story, headline) }
        }
        (row.getChildAt(1) as TextView).text = headline
        return row
    }
}
