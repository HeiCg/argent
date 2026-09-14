import Foundation
import XCTest

/// A handler error carrying a JSON-RPC error code + message. Extensions throw it;
/// the dispatch loop turns it into a JSON-RPC error reply.
struct RunnerError: Error {
    let code: Int
    let message: String

    static func invalidParams(_ message: String) -> RunnerError {
        RunnerError(code: RpcErrorCode.invalidParams, message: message)
    }
    static func failed(_ message: String) -> RunnerError {
        RunnerError(code: RpcErrorCode.internalError, message: message)
    }
    static func unsupported(_ message: String) -> RunnerError {
        RunnerError(code: RpcErrorCode.unsupported, message: message)
    }
}

/// The Argent open iOS server, hosted inside an XCUITest. XCUITest is the only
/// Apple-supported way to drive arbitrary apps, so this "test" starts a JSON-RPC
/// TCP server and parks in a long wait instead of running one scripted scenario.
///
/// Layering: `RunnerLineServer` (NDJSON framing) → `dispatch` here (JSON-RPC
/// decode, method table, serial execution) → command extensions (XCTest work,
/// carried over from base B). One serial queue fronts every XCUITest call, so no
/// two XCTest interactions ever run concurrently.
final class ArgentRunnerSession: XCTestCase {
    let gate = MainThreadGate()

    /// Commands execute here one at a time, in arrival order.
    private let executionQueue = DispatchQueue(label: "argent.runner.execution")

    private let finishLock = NSLock()
    private var done: XCTestExpectation?

    /// The app the app-scoped methods (getState, tap, swipe, type, …) target.
    /// Set by `launchApp`; the runner targets Settings this way, never the empty
    /// host app. Protected by `stateLock`.
    private var currentBundleId: String?

    /// Monotonic snapshot hash-change counter and the last canonical hash, so the
    /// reported `version` advances only when the screen actually changes.
    private var versionCounter = 0
    private var lastHash: String?
    private let stateLock = NSLock()

    override func setUp() {
        continueAfterFailure = true
    }

    // MARK: - Entry point

    /// Starts the JSON-RPC TCP server and parks until `shutdown` or a listener
    /// failure ends the session.
    @MainActor
    func testServeCommands() throws {
        let port = Self.configuredPort()
        NSLog("ARGENT_RUNNER_STARTING requestedPort=%d", Int(port))

        let done = expectation(description: "argent runner shutdown")
        finishLock.lock()
        self.done = done
        finishLock.unlock()

        let server = RunnerLineServer(
            dispatch: { [weak self] line, deliver in
                self?.dispatch(line: line, deliver: deliver)
            },
            onFinish: { [weak self] in self?.finish() }
        )

        try server.start(port: port)
        NSLog("ARGENT_RUNNER_SERVING")

        // The wait pumps the main run loop so handlers can hop onto the main
        // thread while Network.framework serves connections on background queues.
        let outcome = XCTWaiter.wait(for: [done], timeout: 24 * 60 * 60)
        NSLog("ARGENT_RUNNER_STOPPED outcome=%@", String(describing: outcome))
        server.stop()

        if outcome != .completed {
            XCTFail("runner session ended without a shutdown command (\(outcome))")
        }
    }

    /// The port requested through the `.xctestrun` environment
    /// (`TEST_RUNNER_ARGENT_RUNNER_PORT`, which xcodebuild strips to
    /// `ARGENT_RUNNER_PORT`). 0 lets the system pick one for a direct Xcode run.
    static func configuredPort() -> UInt16 {
        if let raw = ProcessInfo.processInfo.environment["ARGENT_RUNNER_PORT"],
            let port = UInt16(raw)
        {
            return port
        }
        return 0
    }

    private func finish() {
        finishLock.lock()
        let expectation = done
        done = nil
        finishLock.unlock()
        expectation?.fulfill()
    }

    // MARK: - Dispatch

    /// Decodes one JSON-RPC line, executes it, and delivers the reply line.
    private func dispatch(line: Data, deliver: @escaping (Data, Bool) -> Void) {
        let request: RunnerRequest
        do {
            request = try JSONDecoder().decode(RunnerRequest.self, from: line)
        } catch {
            deliver(Self.encodeError(id: nil, code: RpcErrorCode.parse, message: "Parse error: \(error)"), false)
            return
        }

        let id = request.id
        let method = request.method
        let params = request.params ?? .empty

        // `ping`, `shutdown` and `flushInput` need no XCTest work, so they answer
        // inline without hopping to the main thread.
        switch method {
        case RunnerMethod.ping.rawValue:
            deliver(Self.encode(id: id, result: PingReply(status: "ok")), false)
            return
        case RunnerMethod.flushInput.rawValue:
            deliver(Self.encode(id: id, result: OkReply(success: true)), false)
            return
        case RunnerMethod.shutdown.rawValue:
            deliver(Self.encode(id: id, result: PingReply(status: "ok")), true)
            return
        default:
            break
        }

        // Everything else runs on the serial execution queue, hopping to the main
        // thread for the XCTest calls. `batch` recurses through the same executor.
        executionQueue.async { [weak self] in
            guard let self else { return }
            let reply = self.encodeExecuted(id: id, method: method, params: params)
            deliver(reply, false)
        }
    }

    /// Runs one method and encodes its JSON-RPC reply (success or error).
    private func encodeExecuted(id: JsonRpcId?, method: String, params: RunnerParams) -> Data {
        do {
            let result = try executeReturningEncodable(method: method, params: params)
            return Self.encode(id: id, result: result)
        } catch let e as RunnerError {
            return Self.encodeError(id: id, code: e.code, message: e.message)
        } catch {
            return Self.encodeError(id: id, code: RpcErrorCode.internalError, message: String(describing: error))
        }
    }

    /// Executes one method, returning its result payload. Runs the XCTest body on
    /// the main thread under the watchdog gate.
    private func executeReturningEncodable(method: String, params: RunnerParams) throws -> AnyEncodable {
        // Deferred-to-a-later-phase methods answer with a stable "unsupported".
        if DeferredMethod(rawValue: method) != nil {
            throw RunnerError.unsupported("\(method) is not implemented in this phase (iOS-1); deferred to iOS-2/3/4")
        }
        guard let m = RunnerMethod(rawValue: method) else {
            throw RunnerError(code: RpcErrorCode.methodNotFound, message: "Method not found: \(method)")
        }

        switch m {
        case .ping:
            return AnyEncodable(PingReply(status: "ok"))
        case .flushInput:
            return AnyEncodable(OkReply(success: true))
        case .shutdown:
            return AnyEncodable(PingReply(status: "ok"))
        case .batch:
            return AnyEncodable(try executeBatch(params))
        default:
            break
        }

        // The remaining methods touch XCUITest, so they run on the main thread.
        return try runOnMain {
            switch m {
            case .getInfo:
                return AnyEncodable(try self.getInfo(params))
            case .getScreenSize:
                return AnyEncodable(self.getScreenSize())
            case .getState:
                return AnyEncodable(try self.captureState(params, includeScreenshotDefault: true))
            case .getNestedState:
                return AnyEncodable(try self.captureState(params, includeScreenshotDefault: false, forceNoScreenshot: true))
            case .tap:
                return AnyEncodable(try self.handleTap(params))
            case .longPress:
                return AnyEncodable(try self.handleLongPress(params))
            case .swipe:
                return AnyEncodable(try self.handleSwipe(params))
            case .typeText:
                return AnyEncodable(try self.handleTypeText(params))
            case .key:
                return AnyEncodable(try self.handleKey(params))
            case .screenshot:
                return AnyEncodable(try self.captureScreenshot(params))
            case .launchApp:
                return AnyEncodable(try self.handleLaunchApp(params))
            case .terminateApp:
                return AnyEncodable(try self.handleTerminateApp(params))
            case .ping, .flushInput, .shutdown, .batch:
                // Handled above.
                throw RunnerError.failed("unreachable")
            }
        }
    }

    /// Runs `work` on the main thread under the per-command watchdog budget and
    /// rethrows its error. XCUITest calls must run on the main thread.
    private func runOnMain<T>(_ work: @escaping () throws -> T) throws -> T {
        do {
            return try gate.run(timeout: 75, work)
        } catch MainThreadGate.Failure.timedOut {
            throw RunnerError.failed("command exceeded its main-thread budget; the work was abandoned")
        }
    }

    private func executeBatch(_ params: RunnerParams) throws -> BatchReply {
        guard let actions = params.actions else {
            throw RunnerError.invalidParams("batch requires an 'actions' array")
        }
        var results: [AnyEncodable] = []
        for action in actions {
            do {
                let r = try executeReturningEncodable(method: action.method, params: action.params ?? .empty)
                results.append(r)
            } catch let e as RunnerError {
                results.append(AnyEncodable(RpcError.Body(code: e.code, message: e.message)))
            } catch {
                results.append(AnyEncodable(RpcError.Body(code: RpcErrorCode.internalError, message: String(describing: error))))
            }
        }
        return BatchReply(results: results)
    }

    // MARK: - Target app + version state (used by the extensions)

    /// The currently targeted app, or nil until `launchApp` set one.
    func targetBundleId() -> String? {
        stateLock.lock()
        defer { stateLock.unlock() }
        return currentBundleId
    }

    func setTargetBundleId(_ id: String) {
        stateLock.lock()
        currentBundleId = id
        stateLock.unlock()
    }

    /// Advance the version counter iff the canonical snapshot hash changed, and
    /// return the current counter. Called from the serial queue (still locked).
    func versionForHash(_ hash: String) -> Int {
        stateLock.lock()
        defer { stateLock.unlock() }
        if lastHash != hash {
            versionCounter += 1
            lastHash = hash
        }
        return versionCounter
    }

    /// The current version without recomputing a hash (for `getInfo`).
    func currentVersion() -> Int {
        stateLock.lock()
        defer { stateLock.unlock() }
        return versionCounter
    }

    // MARK: - Reply encoding

    static func encode<T: Encodable>(id: JsonRpcId?, result: T) -> Data {
        (try? JSONEncoder().encode(RpcSuccess(id: id, result: result)))
            ?? encodeError(id: id, code: RpcErrorCode.internalError, message: "reply encoding failed")
    }

    static func encode(id: JsonRpcId?, result: AnyEncodable) -> Data {
        (try? JSONEncoder().encode(RpcSuccess(id: id, result: result)))
            ?? encodeError(id: id, code: RpcErrorCode.internalError, message: "reply encoding failed")
    }

    static func encodeError(id: JsonRpcId?, code: Int, message: String) -> Data {
        (try? JSONEncoder().encode(RpcError(id: id, code: code, message: message)))
            ?? Data(#"{"jsonrpc":"2.0","id":null,"error":{"code":-32603,"message":"error encoding failed"}}"#.utf8)
    }
}
