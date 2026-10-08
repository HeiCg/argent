package com.argent.devicecontrol.util

/**
 * Normalized (0..1) gesture coordinates converted to device pixels ON the device
 * (versionCode 31+). The host used to read `getScreenSize` before every gesture
 * just to do this multiplication; sending `nx/ny` instead drops that RPC.
 */
object NormalizedCoords {

    /** One normalized coordinate to a pixel along an extent of [extentPx]. */
    fun toPixel(n: Double, extentPx: Int, name: String): Int {
        TODO("normalized conversion: $name=$n over $extentPx px")
    }

    /** A normalized point to device pixels against the live display [geo]. */
    fun toPixels(
        geo: DisplayReader.Geometry,
        nx: Double,
        ny: Double,
        xName: String = "nx",
        yName: String = "ny"
    ): Pair<Int, Int> = toPixel(nx, geo.width, xName) to toPixel(ny, geo.height, yName)
}
