import Network
import XCTest

/// The Argent on-device automation server, hosted inside an XCUITest.
///
/// XCUITest is the only Apple-supported way to drive arbitrary apps on a
/// physical iOS device, but a test normally runs one scripted scenario and
/// exits. This "test" instead starts an HTTP command server and parks in an
/// XCTWaiter wait for 24 hours. That wait pumps the main run loop, so command
/// handlers can hop onto the main thread (where every XCTest UI call must
/// run) while Network.framework serves connections on background queues.
///
/// Layering: RunnerHTTPServer (framing) → dispatch here (decode, journal,
/// duplicate-send coalescing, busy gate) → command extensions (XCTest work).
final class ArgentRunnerSession: XCTestCase {
  /// Set when the session instance is created, before the server accepts its
  /// first connection — a lazy anchor would report an uptime of ~0 forever.
  private let launchedAt = Date()

  let gate = MainThreadGate()
  private let journal = CommandJournal()
  /// Serial: commands execute one at a time, in arrival order. `status` never
  /// enters this queue, so health checks and lost-reply recovery stay
  /// responsive while a command runs.
  private let executionQueue = DispatchQueue(label: "argent.runner.execution")

  private let finishLock = NSLock()
  private var done: XCTestExpectation?

  /// Duplicate transport sends of one commandId (a client retry racing a slow
  /// execution) attach to the in-flight execution and share its reply instead
  /// of executing twice.
  private let inFlightLock = NSLock()
  private var inFlightReplies: [String: [(RunnerHTTPServer.Reply) -> Void]] = [:]

  private let suppressedIssuesLock = NSLock()
  private var suppressedIssueCount = 0

  override func setUp() {
    continueAfterFailure = true
  }

  // MARK: - Issue filtering

  /// The suppression matchers, verbatim. This wording is Apple-owned —
  /// XCTIssue exposes no stable code for these shapes, so classification
  /// substring-matches `compactDescription` — and an Xcode release that
  /// rewords any of these strings makes suppression miss silently: recorded
  /// issues accumulate and healthy mutations start failing as
  /// XCTEST_RECORDED_FAILURE. The health payload's `suppressedIssues` /
  /// `recordedFailures` counters make that miss observable from the host
  /// (`suppressedIssues` flat while `recordedFailures` climbs is the drift
  /// signal); PROTOCOL.md's `status` section pins the same strings as part of
  /// the contract. Exact strings matched:
  ///   gate         — "Failed to get matching snapshot"
  ///   keepRecorded — "Timed out while evaluating UI query"
  ///   noise        — "kAXError", "No matches found for"
  enum SuppressedIssueWording {
    static let gate = "Failed to get matching snapshot"
    static let keepRecorded = "Timed out while evaluating UI query"
    static let noise = ["kAXError", "No matches found for"]
  }

  /// XCTest tears the whole test down once recorded issues accumulate — fatal
  /// for a server that must outlive thousands of commands. Two issue shapes
  /// are pure accessibility noise on heavy screens and are muted: an AX
  /// server error (`kAXError*`) inside a "Failed to get matching snapshot"
  /// fetch, and the "No matches found for …" variant a stale element produces
  /// right after the UI it referenced moved on. The "Timed out while
  /// evaluating UI query" shape stays recorded on purpose: it marks a
  /// genuinely hung query, which the recorded-failure check must keep seeing.
  static func isSuppressedAccessibilityIssue(_ description: String) -> Bool {
    guard description.contains(SuppressedIssueWording.gate) else { return false }
    if description.contains(SuppressedIssueWording.keepRecorded) { return false }
    return SuppressedIssueWording.noise.contains { description.contains($0) }
  }

  override func record(_ issue: XCTIssue) {
    let description = issue.compactDescription
    if Self.isSuppressedAccessibilityIssue(description) {
      suppressedIssuesLock.lock()
      suppressedIssueCount += 1
      let count = suppressedIssueCount
      suppressedIssuesLock.unlock()
      NSLog("ARGENT_RUNNER_AX_ISSUE_SUPPRESSED count=%ld description=%@", count, description)
      return
    }
    super.record(issue)
  }

  // MARK: - Entry point

  @MainActor
  func testServeCommands() throws {
    let port = Self.configuredPort()
    NSLog("ARGENT_RUNNER_STARTING requestedPort=%d", Int(port))
    let done = expectation(description: "argent runner shutdown")
    finishLock.lock()
    self.done = done
    finishLock.unlock()

    let server = RunnerHTTPServer(
      dispatch: { [weak self] body, deliver in self?.dispatch(body: body, deliver: deliver) },
      onFinish: { [weak self] in self?.finish() }
    )
    try server.start(port: port)
    NSLog("ARGENT_RUNNER_SERVING")

    let outcome = XCTWaiter.wait(for: [done], timeout: 24 * 60 * 60)
    NSLog("ARGENT_RUNNER_STOPPED outcome=%@", String(describing: outcome))
    server.stop()
    if outcome != .completed {
      XCTFail("runner session ended without a shutdown command (\(outcome))")
    }
  }

  /// The port arrives through the .xctestrun environment; 0 lets the system
  /// pick one (useful when running the session directly from Xcode).
  static func configuredPort() -> UInt16 {
    if let raw = ProcessInfo.processInfo.environment["ARGENT_RUNNER_PORT"],
      let port = UInt16(raw) {
      return port
    }
    return 0
  }

  private func finish() {
    // Reachable from both the shutdown reply and a listener failure; the
    // lock plus nil-out makes the expectation fulfill exactly once.
    finishLock.lock()
    let expectation = done
    done = nil
    finishLock.unlock()
    expectation?.fulfill()
  }

  // MARK: - Dispatch (transport queue)

  private func dispatch(body: Data, deliver: @escaping (RunnerHTTPServer.Reply) -> Void) {
    let request: CommandRequest
    do {
      request = try JSONDecoder().decode(CommandRequest.self, from: body)
    } catch {
      deliver(
        Self.encodeReply(
          status: 400,
          envelope: .failure(
            .invalidRequest,
            "unrecognized command payload: \(error)",
            hint: "Check the command name and fields against PROTOCOL.md."
          )
        )
      )
      return
    }
    // Status is answered inline on the transport queue — it must work exactly
    // when the execution queue does not.
    if request.command == .status {
      deliver(Self.encodeReply(status: 200, envelope: statusEnvelope(for: request)))
      return
    }
    if attachToInFlight(request, deliver: deliver) {
      return
    }
    NSLog(
      "ARGENT_RUNNER_COMMAND_ACCEPTED command=%@ commandId=%@",
      request.command.rawValue,
      request.normalizedCommandId ?? ""
    )
    journal.accept(request)
    executionQueue.async {
      self.journal.started(request)
      let envelope = self.executeGated(request)
      let reply = Self.encodeReply(
        status: envelope.ok ? 200 : 500,
        envelope: envelope,
        finishAfterSend: request.command == .shutdown && envelope.ok
      )
      self.journal.finished(request, envelope: envelope, encodedEnvelope: reply.body)
      NSLog(
        "ARGENT_RUNNER_COMMAND_FINISHED command=%@ commandId=%@ ok=%d",
        request.command.rawValue,
        request.normalizedCommandId ?? "",
        envelope.ok ? 1 : 0
      )
      self.deliverReleasingInFlight(request, reply: reply, deliver: deliver)
    }
  }

  private func statusEnvelope(for request: CommandRequest) -> Envelope {
    if let id = request.statusCommandId?.trimmingCharacters(in: .whitespacesAndNewlines),
      !id.isEmpty {
      return .success(journal.status(commandId: id))
    }
    let state: String
    switch gate.availability() {
    case .idle: state = "idle"
    case .busy: state = "busy"
    case .wedged: state = "wedged"
    }
    return .success(
      HealthPayload(
        uptimeMs: Date().timeIntervalSince(launchedAt) * 1000,
        state: state,
        suppressedIssues: currentSuppressedIssueCount(),
        // Informational monotonic counter; reading it off the main thread is
        // fine for health reporting — status must answer while a command runs.
        recordedFailures: testRun?.totalFailureCount ?? 0
      )
    )
  }

  /// Read by the health payload above and by `performOnMain`, which brackets
  /// each command with before/after reads so a suppression delta on an ok
  /// mutation can surface as an envelope warning.
  func currentSuppressedIssueCount() -> Int {
    suppressedIssuesLock.lock()
    defer { suppressedIssuesLock.unlock() }
    return suppressedIssueCount
  }

  private func attachToInFlight(
    _ request: CommandRequest,
    deliver: @escaping (RunnerHTTPServer.Reply) -> Void
  ) -> Bool {
    guard let id = request.normalizedCommandId else { return false }
    inFlightLock.lock()
    defer { inFlightLock.unlock() }
    if inFlightReplies[id] != nil {
      inFlightReplies[id]?.append(deliver)
      NSLog("ARGENT_RUNNER_DUPLICATE_SEND_COALESCED commandId=%@", id)
      return true
    }
    inFlightReplies[id] = []
    return false
  }

  private func deliverReleasingInFlight(
    _ request: CommandRequest,
    reply: RunnerHTTPServer.Reply,
    deliver: (RunnerHTTPServer.Reply) -> Void
  ) {
    var waiters: [(RunnerHTTPServer.Reply) -> Void] = []
    if let id = request.normalizedCommandId {
      inFlightLock.lock()
      waiters = inFlightReplies.removeValue(forKey: id) ?? []
      inFlightLock.unlock()
    }
    deliver(reply)
    for waiter in waiters {
      waiter(reply)
    }
  }

  // MARK: - Execution (serial queue → main thread)

  /// Refuses fast while the main thread is still digesting abandoned work,
  /// otherwise hops the command onto the main thread under its watchdog
  /// budget.
  private func executeGated(_ request: CommandRequest) -> Envelope {
    switch gate.availability() {
    case .busy(let seconds):
      NSLog(
        "ARGENT_RUNNER_BUSY command=%@ abandonedFor=%.1f", request.command.rawValue, seconds
      )
      return .failure(
        .runnerBusy,
        "The runner is still finishing a previous command that overran its watchdog "
          + "(usually an accessibility capture on a heavy or animating screen).",
        hint:
          "Wait a few seconds and retry. If snapshots keep failing on this screen, use "
          + "screenshot as visual truth and interact by coordinates."
      )
    case .wedged(let seconds):
      NSLog("ARGENT_RUNNER_WEDGED abandonedFor=%.1f", seconds)
      return .failure(
        .runnerWedged,
        "The runner's main thread has been stuck in abandoned work for \(Int(seconds))s "
          + "and cannot recover on its own.",
        hint: "Restart the runner session, then retry the command."
      )
    case .idle:
      break
    }
    do {
      return try gate.run(timeout: request.command.executionTimeout) {
        self.performOnMain(request)
      }
    } catch MainThreadGate.Failure.timedOut {
      return .failure(
        .commandTimedOut,
        "\(request.command.rawValue) exceeded its \(Int(request.command.executionTimeout))s "
          + "main-thread budget; the work was abandoned and may still complete on the device.",
        hint:
          "Retry after a few seconds; the runner reports busy until the abandoned work drains."
      )
    } catch {
      return .failure(.commandFailed, String(describing: error))
    }
  }

  static func encodeReply(
    status: Int,
    envelope: Envelope,
    finishAfterSend: Bool = false
  ) -> RunnerHTTPServer.Reply {
    let body =
      (try? JSONEncoder().encode(envelope))
      ?? Data(#"{"ok":false,"error":{"code":"COMMAND_FAILED","message":"response encoding failed"}}"#.utf8)
    return RunnerHTTPServer.Reply(status: status, body: body, finishAfterSend: finishAfterSend)
  }
}
