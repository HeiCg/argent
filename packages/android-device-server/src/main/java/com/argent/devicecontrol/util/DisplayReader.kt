package com.argent.devicecontrol.util

import android.content.Context
import android.hardware.display.DisplayManager
import android.util.DisplayMetrics
import android.view.Display

/**
 * Idle-free display geometry (real size + rotation), read STRAIGHT from the
 * platform [Display] — never through `UiDevice` getters.
 *
 * `UiDevice.getDisplayRotation()` and `UiDevice.getCurrentPackageName()` call
 * `UiAutomation.waitForIdle(500 quiescence, 10 s cap)` internally (decompiled
 * uiautomator 2.3.0), so on a hot path they block until the UI stops animating —
 * up to 10 s during a fling or pinch-zoom. `getDisplayWidth/Height` do NOT, but
 * reading width, height and rotation from one [Display] snapshot keeps them
 * consistent and avoids the idle gate entirely.
 *
 * The rule this enforces: never call a `UiDevice` getter that triggers
 * `waitForIdle` on the tap / swipe / gesture / describe / state paths.
 */
object DisplayReader {
    data class Geometry(val width: Int, val height: Int, val rotation: Int)

    fun read(context: Context): Geometry {
        val dm = context.getSystemService(DisplayManager::class.java)
        val display = dm.getDisplay(Display.DEFAULT_DISPLAY)
        val metrics = DisplayMetrics()
        // getRealMetrics is rotation-aware: widthPixels/heightPixels reflect the
        // current orientation, matching getBoundsInScreen's pixel space (so the
        // describe / gesture coordinate math needs no rotation correction) and
        // UiDevice.getDisplayWidth/Height's values — without the idle gate.
        display.getRealMetrics(metrics)
        return Geometry(metrics.widthPixels, metrics.heightPixels, display.rotation)
    }
}
