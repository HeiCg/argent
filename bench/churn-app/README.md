# churn-app — Phase E churn experiment (E-1)

A minimal Android app (framework widgets only, no AndroidX) that renders a
dynamic feed so the screen-graph template-edge mechanism can be measured against
a COUNTED number of content states.

## What it renders

- `FeedActivity` — a scrolling `ListView` (`id/list`) of `--ei items` rows. Each
  row has a **stable** title `Story <i>` (`id/row_title`) and a **churning**
  summary `Headline <seed>-<i>` (`id/row_summary`), plus a fixed title bar
  (`id/feed_toolbar` > `id/title` = "Feed") and a nested horizontal carousel
  (`id/carousel`). Tapping a row opens `DetailActivity`.
- `DetailActivity` — the **explosion** regime: the churning headline is the
  toolbar TITLE, so every item's detail has a distinct on-device `H_id`.
- `DetailMergeActivity` — the **false-merge** regime: a constant toolbar title
  with the headline in a `ScrollView` body (excluded from `H_id`). Kept so both
  regimes are exercisable; the harness taps the explosion rows.

Stable row title + churning detail is deliberate: it makes the OFF (control) arm
key a tap edge on stable text whose destination changes each session — the
`duplicateEdgeTargets` break the template arm folds away (E-0 §F4) — while the
size explosion is the linear node/edge/byte growth the template arm removes.

## Launch

    am start -n com.argent.churnapp/.FeedActivity --ei items 50 --ei seed 1001

Same `seed` → identical content (revisit); different `seed` → fresh content
(churn). The harness varies the seed per session for the churn=100 condition and
holds it fixed for churn=0.

## Build (CI ONLY)

    bash bench/churn-app/scripts/build.sh

Reuses the `android-device-server` Gradle wrapper via `-p`, so this app carries
no second `gradle-wrapper.jar`. Never build on the dev host (machine resource
policy); the screen-graph CI job builds and installs it under `BENCH_CHURN=1`.
