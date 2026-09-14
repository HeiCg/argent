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
