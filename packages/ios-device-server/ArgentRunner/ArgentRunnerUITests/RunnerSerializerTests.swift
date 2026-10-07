import XCTest

/// Device-free unit tests for the pure wire logic: JSON-RPC framing, the reply
/// serializer, the version hash, and the method table. They do not launch a
/// target app, so they exercise only the code XCTest can run without driving the
/// UI. Run with:
///   xcodebuild test -only-testing:ArgentRunnerUITests/RunnerSerializerTests
final class RunnerSerializerTests: XCTestCase {
    // MARK: - JSON-RPC framing

    func testDecodesRequestLine() throws {
        let line = Data(#"{"jsonrpc":"2.0","id":7,"method":"tap","params":{"x":10,"y":20}}"#.utf8)
        let req = try JSONDecoder().decode(RunnerRequest.self, from: line)
        XCTAssertEqual(req.method, "tap")
        XCTAssertEqual(req.params?.x, 10)
        XCTAssertEqual(req.params?.y, 20)
        if case .number(let n)? = req.id { XCTAssertEqual(n, 7) } else { XCTFail("id") }
    }

    func testEncodesSuccessReplyEchoingId() throws {
        let reply = ArgentRunnerSession.encode(id: .number(7), result: PingReply(status: "ok"))
        let text = String(decoding: reply, as: UTF8.self)
        XCTAssertTrue(text.contains(#""jsonrpc":"2.0""#))
        XCTAssertTrue(text.contains(#""id":7"#))
        XCTAssertTrue(text.contains(#""status":"ok""#))
        XCTAssertFalse(text.contains("\n"), "the framing newline is added by the transport, not the encoder")
    }

    func testEncodesErrorReply() throws {
        let reply = ArgentRunnerSession.encodeError(id: .string("abc"), code: RpcErrorCode.methodNotFound, message: "Method not found: nope")
        let text = String(decoding: reply, as: UTF8.self)
        XCTAssertTrue(text.contains(#""id":"abc""#))
        XCTAssertTrue(text.contains(#""code":-32601"#))
    }

    func testStringAndNullIdRoundTrip() throws {
        let s = String(decoding: ArgentRunnerSession.encode(id: .string("x1"), result: PingReply(status: "ok")), as: UTF8.self)
        XCTAssertTrue(s.contains(#""id":"x1""#))
        let n = String(decoding: ArgentRunnerSession.encode(id: JsonRpcId.null, result: PingReply(status: "ok")), as: UTF8.self)
        XCTAssertTrue(n.contains(#""id":null"#))
    }

    // MARK: - version hash

    func testCanonicalHashChangesWithLabel() {
        let a = NestedNode(type: "Button", label: "General", identifier: nil, value: nil,
                           bounds: NodeBounds(x1: 0, y1: 0, x2: 10, y2: 10),
                           enabled: true, hittable: true, selected: false, focused: false, children: [])
        let b = NestedNode(type: "Button", label: "Wi-Fi", identifier: nil, value: nil,
                           bounds: NodeBounds(x1: 0, y1: 0, x2: 10, y2: 10),
                           enabled: true, hittable: true, selected: false, focused: false, children: [])
        XCTAssertEqual(ArgentRunnerSession.canonicalHash([a]), ArgentRunnerSession.canonicalHash([a]))
        XCTAssertNotEqual(ArgentRunnerSession.canonicalHash([a]), ArgentRunnerSession.canonicalHash([b]))
    }

    // MARK: - swipe velocity

    func testSwipeVelocityIsDistanceOverDuration() {
        // 400 pt in 500 ms = 800 pt/s; 400 pt in 2000 ms = 200 pt/s.
        XCTAssertEqual(ArgentRunnerSession.swipeVelocity(distance: 400, durationMs: 500), 800)
        XCTAssertEqual(ArgentRunnerSession.swipeVelocity(distance: 400, durationMs: 2000), 200)
    }

    func testSwipeVelocityClampsToBounds() {
        // 300 pt in 10 s = 30 pt/s, raised to 60; 600 pt in 50 ms = 12000 pt/s, cut to 5000.
        XCTAssertEqual(ArgentRunnerSession.swipeVelocity(distance: 300, durationMs: 10_000), 60)
        XCTAssertEqual(ArgentRunnerSession.swipeVelocity(distance: 600, durationMs: 50), 5000)
    }

    func testSwipeVelocityIsNilWithoutDurationOrDistance() {
        XCTAssertNil(ArgentRunnerSession.swipeVelocity(distance: 400, durationMs: nil))
        XCTAssertNil(ArgentRunnerSession.swipeVelocity(distance: 400, durationMs: 0))
        XCTAssertNil(ArgentRunnerSession.swipeVelocity(distance: 0, durationMs: 300))
    }

    // MARK: - screen geometry

    func testScaleIsPanelPixelsOverPointsOnTheLongSide() {
        // iPhone 17: 1206×2622 px panel, 402×874 pt, in either orientation.
        XCTAssertEqual(ArgentRunnerSession.roundedScale(panelLongSidePx: 2622, pointSize: CGSize(width: 402, height: 874)), 3)
        XCTAssertEqual(ArgentRunnerSession.roundedScale(panelLongSidePx: 2622, pointSize: CGSize(width: 874, height: 402)), 3)
    }

    func testScaleRoundsToHundredths() {
        // 2622 / 873 = 3.00343… → 3; 2000 / 600 = 3.3333… → 3.33.
        XCTAssertEqual(ArgentRunnerSession.roundedScale(panelLongSidePx: 2622, pointSize: CGSize(width: 402, height: 873)), 3)
        XCTAssertEqual(ArgentRunnerSession.roundedScale(panelLongSidePx: 2000, pointSize: CGSize(width: 300, height: 600)), 3.33)
    }

    func testScaleIsNilForUnusableInput() {
        XCTAssertNil(ArgentRunnerSession.roundedScale(panelLongSidePx: 2622, pointSize: .zero))
        XCTAssertNil(ArgentRunnerSession.roundedScale(panelLongSidePx: 0, pointSize: CGSize(width: 402, height: 874)))
        XCTAssertNil(ArgentRunnerSession.roundedScale(panelLongSidePx: .nan, pointSize: CGSize(width: 402, height: 874)))
        // Fewer pixels than points is not a framebuffer scale.
        XCTAssertNil(ArgentRunnerSession.roundedScale(panelLongSidePx: 400, pointSize: CGSize(width: 402, height: 874)))
    }

    func testGeometryCacheHitsOnlyTheStoredKey() {
        var cache = GeometryCache()
        let portrait = GeometryCache.Key(bundleId: "com.apple.Preferences", orientation: 1)
        let geo = ScreenGeometry(width: 402, height: 874, scale: 3)
        XCTAssertNil(cache.geometry(for: portrait))
        cache.store(geo, for: portrait)
        XCTAssertEqual(cache.geometry(for: portrait), geo)
        // A rotation or another target is a miss.
        XCTAssertNil(cache.geometry(for: GeometryCache.Key(bundleId: "com.apple.Preferences", orientation: 3)))
        XCTAssertNil(cache.geometry(for: GeometryCache.Key(bundleId: "com.apple.mobilesafari", orientation: 1)))
    }

    func testGeometryCacheInvalidateKeepsThePanelMeasurement() {
        var cache = GeometryCache()
        let key = GeometryCache.Key(bundleId: "com.apple.Preferences", orientation: 1)
        cache.panelLongSidePx = 2622
        cache.store(ScreenGeometry(width: 402, height: 874, scale: 3), for: key)
        cache.invalidate()
        XCTAssertNil(cache.geometry(for: key))
        // The panel does not change within a session, so no new screenshot is due.
        XCTAssertEqual(cache.panelLongSidePx, 2622)
    }

    // MARK: - method table

    func testMethodTableHasNoDeferredOverlap() {
        let supported = Set(RunnerMethod.allCases.map(\.rawValue))
        let deferred = Set(DeferredMethod.allCases.map(\.rawValue))
        XCTAssertTrue(supported.isDisjoint(with: deferred))
    }

    func testMethodTableCoversTheContract() {
        let supported = Set(RunnerMethod.allCases.map(\.rawValue))
        let expected: Set<String> = [
            "ping", "getInfo", "getScreenSize", "getState", "getNestedState",
            "tap", "longPress", "swipe", "typeText", "key", "screenshot",
            "launchApp", "terminateApp", "flushInput", "batch", "shutdown",
        ]
        XCTAssertEqual(supported, expected)
    }
}
