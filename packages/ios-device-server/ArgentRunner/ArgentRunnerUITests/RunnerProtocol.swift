import Foundation

// MARK: - Argent iOS open server wire protocol (NDJSON JSON-RPC 2.0)
//
// The open iOS server speaks the SAME contract as the open Android server
// (`@argent/android-device-server`): newline-delimited JSON-RPC 2.0 over a
// loopback TCP socket, one request object per line, one `\n`-terminated reply
// per request. The method names and reply shapes mirror the Kotlin
// `JsonRpcHandler`; the TypeScript client is `ios-open-server-client.ts`, which
// reuses the same `open-server-transport` NDJSON framing the Android client uses.
//
// This replaces base B's HTTP/1.1-per-command `RunnerProtocol`. The XCTest
// command logic (snapshot, gestures, screenshot, text entry) is carried over
// from B, re-expressed onto these types.

/// The methods this phase (iOS-1) implements. Kept as a single Swift source of
/// truth: the host method-parity test reads these `case` names off this file
/// (the same disk-read lockstep base B used for the describe adapter) and asserts
/// the host method list matches it exactly.
enum RunnerMethod: String, CaseIterable {
    case ping
    case getInfo
    case getScreenSize
    case getState
    case getNestedState
    case tap
    case longPress
    case swipe
    case typeText
    case key
    case screenshot
    case launchApp
    case terminateApp
    case flushInput
    case batch
    case shutdown
}

/// Methods that are part of the Android contract but deferred to iOS-2/3/4. They
/// are answered with a stable JSON-RPC "unsupported" error rather than
/// "method not found", so the host can tell "not this phase" from "never".
enum DeferredMethod: String, CaseIterable {
    case query
    case diff
    case awaitChange
    case gesture
    case setClipboard
    case getAccessibilityTree
    case waitForIdle
}

/// JSON-RPC error codes. `-32601`/`-32700`/`-32603` are the standard codes;
/// `unsupported` reuses `-32601`'s "method not found" family with a distinct
/// message so a deferred method reads differently from a typo.
enum RpcErrorCode {
    static let parse = -32700
    static let methodNotFound = -32601
    static let invalidParams = -32602
    static let internalError = -32603
    /// Deferred-to-a-later-phase method (query/diff/awaitChange/gesture/…).
    static let unsupported = -32004
}

/// A JSON-RPC id: a number, a string, or null. Echoed back verbatim on the reply
/// so the host correlates replies to requests. Integers round-trip as integers.
enum JsonRpcId: Codable {
    case number(Double)
    case string(String)
    case null

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self = .null
        } else if let n = try? container.decode(Double.self) {
            self = .number(n)
        } else if let s = try? container.decode(String.self) {
            self = .string(s)
        } else {
            self = .null
        }
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        switch self {
        case .number(let n):
            if n.rounded() == n, abs(n) < 9_007_199_254_740_992 {
                try container.encode(Int(n))
            } else {
                try container.encode(n)
            }
        case .string(let s):
            try container.encode(s)
        case .null:
            try container.encodeNil()
        }
    }
}

/// The flat parameter bag every method decodes from. Every field is optional so
/// one decoder serves all methods, mirroring base B's `CommandRequest` and the
/// Kotlin server's `params.opt*` reads.
struct RunnerParams: Decodable {
    // getState / getNestedState
    let includeScreenshot: Bool?
    let maxElements: Int?

    // tap / longPress (screen points)
    let x: Double?
    let y: Double?
    let clickCount: Int?
    let holdMs: Double?
    let gapMs: Double?
    let durationMs: Double?

    // swipe (screen points)
    let startX: Double?
    let startY: Double?
    let endX: Double?
    let endY: Double?
    let steps: Int?
    let holdEndMs: Double?

    // typeText / key
    let text: String?
    let key: String?

    // launchApp / terminateApp and the app-scoped target override
    let bundleId: String?

    // screenshot
    let format: String?
    let quality: Int?
    let scale: Double?

    // batch
    let actions: [BatchAction]?

    static let empty = RunnerParams(
        includeScreenshot: nil, maxElements: nil, x: nil, y: nil, clickCount: nil,
        holdMs: nil, gapMs: nil, durationMs: nil, startX: nil, startY: nil,
        endX: nil, endY: nil, steps: nil, holdEndMs: nil, text: nil, key: nil,
        bundleId: nil, format: nil, quality: nil, scale: nil, actions: nil
    )
}

/// One entry in a `batch` request: a nested method + its params, run in order.
struct BatchAction: Decodable {
    let method: String
    let params: RunnerParams?
}

/// A decoded top-level JSON-RPC request line.
struct RunnerRequest: Decodable {
    let method: String
    let id: JsonRpcId?
    let params: RunnerParams?
}

// MARK: - Reply envelopes

/// Type-erased Encodable so one reply encoder carries any per-method payload.
struct AnyEncodable: Encodable {
    private let encodeInto: (Encoder) throws -> Void
    init<T: Encodable>(_ value: T) { self.encodeInto = value.encode(to:) }
    func encode(to encoder: Encoder) throws { try encodeInto(encoder) }
}

/// A JSON-RPC success reply `{ "jsonrpc": "2.0", "id": …, "result": … }`.
struct RpcSuccess: Encodable {
    let jsonrpc = "2.0"
    let id: JsonRpcId?
    let result: AnyEncodable

    init<T: Encodable>(id: JsonRpcId?, result: T) {
        self.id = id
        self.result = AnyEncodable(result)
    }
}

/// A JSON-RPC error reply `{ "jsonrpc": "2.0", "id": …, "error": {code,message} }`.
struct RpcError: Encodable {
    struct Body: Encodable {
        let code: Int
        let message: String
    }
    let jsonrpc = "2.0"
    let id: JsonRpcId?
    let error: Body

    init(id: JsonRpcId?, code: Int, message: String) {
        self.id = id
        self.error = Body(code: code, message: message)
    }
}

// MARK: - Per-method payloads

struct PingReply: Encodable {
    let status: String
}

/// `getInfo`: the target app's bundle id, orientation, keyboard visibility, and
/// the main screen size in POINTS with the backing scale — read from
/// `XCUIScreen.main`, never from a screenshot.
struct InfoReply: Encodable {
    let bundleId: String
    let orientation: String
    let keyboardVisible: Bool
    let screenWidth: Double
    let screenHeight: Double
    let scale: Double
    /// Monotonic snapshot hash-change counter (see `ArgentRunnerSession.version`).
    let version: Int
}

/// `getScreenSize`: cheap geometry with no accessibility read.
struct ScreenSizeReply: Encodable {
    let screenWidth: Double
    let screenHeight: Double
    let scale: Double
}

/// Bounds in SCREEN POINTS, `{x1,y1,x2,y2}`, matching the Android nested
/// `bounds` shape so the host adapter treats both platforms alike.
struct NodeBounds: Encodable {
    let x1: Double
    let y1: Double
    let x2: Double
    let y2: Double
}

/// One node of the nested accessibility tree (`children` arrays), so the host
/// `openServerIosNestedToDescribeNode` lowers it the same way the Android nested
/// adapter lowers its tree.
struct NestedNode: Encodable {
    let type: String
    let label: String?
    let identifier: String?
    let value: String?
    let bounds: NodeBounds
    let enabled: Bool
    let hittable: Bool
    let selected: Bool
    let focused: Bool
    let children: [NestedNode]
}

/// Per-stage capture timings. The device suite asserts
/// `snapshotMs + serializeMs + encodeMs ≈ captureMs`.
struct StateTimings: Encodable {
    let snapshotMs: Double
    let serializeMs: Double
    let encodeMs: Double
    let captureMs: Double
}

struct StateInfo: Encodable {
    let bundleId: String
    let orientation: String
    let keyboardVisible: Bool
    let screenWidth: Double
    let screenHeight: Double
    let scale: Double
}

/// `getState` / `getNestedState` reply. `screenshot` is absent on the nested
/// (describe/await) path.
struct StateReply: Encodable {
    let tree: [NestedNode]
    let truncated: Bool
    let info: StateInfo
    let version: Int
    let timings: StateTimings
    let screenshot: String?
}

/// `tap`: XCUITest cannot report whether an event was dropped, so `dropped` is
/// always false and `dropReporting` says the capability is unsupported (unlike
/// the Android dispatcher, which can reject an injected event).
struct TapReply: Encodable {
    let success: Bool
    let dropped: Bool
    let dropReporting: String
}

struct OkReply: Encodable {
    let success: Bool
}

struct TypeTextReply: Encodable {
    let success: Bool
    let charsTyped: Int
}

struct LaunchAppReply: Encodable {
    let success: Bool
    let bundleId: String
}

/// `screenshot`: base64 image bytes with the mime type and pixel dimensions,
/// matching the Android `OpenServerScreenshot` shape the host already consumes.
struct ScreenshotReply: Encodable {
    let data: String
    let mimeType: String
    let width: Int
    let height: Int
}

/// `batch`: the ordered sub-results, each either the method's result or `{error}`.
struct BatchReply: Encodable {
    let results: [AnyEncodable]
}
