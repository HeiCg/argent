package com.argent.devicecontrol.util

import org.json.JSONObject

/**
 * Normalized (0..1) gesture coordinates converted to device pixels ON the device
 * (versionCode 31+). The host used to read `getScreenSize` before every gesture
 * just to do this multiplication; sending `nx/ny` instead drops that RPC.
 *
 * The conversion is the host's old `toPixels`: `Math.round(n * extent)` against
 * the rotation-aware real metrics [DisplayReader] reads (the same snapshot
 * `getScreenSize` returns), so a gesture lands on the same pixel either way and a
 * mid-session rotation is picked up on the next gesture. Kotlin's `Math.round`
 * rounds a half up, like JavaScript's, for the non-negative values seen here.
 */
object NormalizedCoords {

    /** Wait before re-reading a 0x0 display (a display mid-reconfiguration). */
    const val ZERO_GEOMETRY_RETRY_MS = 50L

    /**
     * The display geometry for a normalized gesture. A 0x0 read (the display is
     * reconfiguring, e.g. mid-rotation) is read once more after
     * [ZERO_GEOMETRY_RETRY_MS]; a geometry still 0x0 then fails in [toPixels].
     */
    fun readGeometry(
        read: () -> DisplayReader.Geometry,
        sleep: (Long) -> Unit = { Thread.sleep(it) }
    ): DisplayReader.Geometry {
        val first = read()
        if (first.width > 0 && first.height > 0) return first
        sleep(ZERO_GEOMETRY_RETRY_MS)
        return read()
    }

    /**
     * One normalized coordinate to a pixel along an extent of [extentPx]. [name] is
     * the wire key, quoted in the error. Out of [0, 1] (or NaN) is an error rather
     * than a clamp: the host clamps before sending, so a value outside is a bad
     * request, not a gesture to guess at.
     */
    fun toPixel(n: Double, extentPx: Int, name: String): Int {
        require(n >= 0.0 && n <= 1.0) { "$name must be a normalized coordinate in [0, 1], got $n" }
        return Math.round(n * extentPx).toInt()
    }

    /**
     * A normalized point to device pixels against the live display [geo]. A 0x0
     * geometry (a display mid-reconfiguration) fails the gesture instead of
     * tapping the origin; the host then falls back.
     */
    fun toPixels(
        geo: DisplayReader.Geometry,
        nx: Double,
        ny: Double,
        xName: String = "nx",
        yName: String = "ny"
    ): Pair<Int, Int> {
        check(geo.width > 0 && geo.height > 0) {
            "display geometry is ${geo.width}x${geo.height}; cannot convert $xName/$yName"
        }
        return toPixel(nx, geo.width, xName) to toPixel(ny, geo.height, yName)
    }

    /**
     * Read one point from RPC [params]: the normalized pair ([nxKey], [nyKey]) when
     * either is present, converted against [geometry] (read once per request by the
     * caller), else the pixel pair ([xKey], [yKey]) as before. Half a normalized pair
     * is an error.
     */
    fun pointParam(
        params: JSONObject,
        xKey: String,
        yKey: String,
        nxKey: String,
        nyKey: String,
        geometry: () -> DisplayReader.Geometry
    ): Pair<Int, Int> {
        if (!params.has(nxKey) && !params.has(nyKey)) {
            return params.getInt(xKey) to params.getInt(yKey)
        }
        require(params.has(nxKey) && params.has(nyKey)) {
            "$nxKey and $nyKey must be sent together"
        }
        return toPixels(geometry(), params.getDouble(nxKey), params.getDouble(nyKey), nxKey, nyKey)
    }
}
