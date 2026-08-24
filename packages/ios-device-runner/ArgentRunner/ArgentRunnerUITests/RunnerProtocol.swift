import Foundation

// MARK: - Argent iOS runner wire protocol (v1)
//
// One HTTP POST per command: the request body is a JSON `CommandRequest`, the
// reply a JSON `Envelope`. PROTOCOL.md at the package root documents the
// contract; the TypeScript client under
// packages/tool-server/src/utils/ios-device mirrors these shapes.

enum CommandKind: String, Codable {
  case status
  case viewport
  case tap
  case longPress
  case drag
  case type
  case keyboardReturn
  case keyboardDismiss
  case home
  case snapshot
  case screenshot
  case shutdown
}

extension CommandKind {
  /// Commands that read state without side effects. The client retries these
  /// freely; everything else is sent exactly once and recovered through the
  /// journal (`status` + `statusCommandId`) when a reply is lost in transit.
  var isReadOnly: Bool {
    switch self {
    case .status, .viewport, .snapshot, .screenshot:
      return true
    case .tap, .longPress, .drag, .type, .keyboardReturn, .keyboardDismiss, .home, .shutdown:
      return false
    }
  }

  /// Commands that target an app and therefore require `appBundleId`. The
  /// runner never redirects an app command to its own host app: an
  /// interaction without an explicit target is a caller bug, and silently
  /// retargeting would hide it.
  var requiresAppBundleId: Bool {
    switch self {
    case .viewport, .tap, .longPress, .drag, .type, .keyboardReturn, .keyboardDismiss, .snapshot:
      return true
    case .status, .home, .screenshot, .shutdown:
      return false
    }
  }

  /// Whether the journal keeps the full response JSON for `status` recovery.
  /// Snapshot and screenshot replies are large and read-only — replaying them
  /// is cheaper than letting them evict the mutation results the journal
  /// exists to protect.
  var retainsResponseInJournal: Bool {
    switch self {
    case .snapshot, .screenshot:
      return false
    default:
      return true
    }
  }

  /// Main-thread watchdog budget for one execution. `type` gets more room:
  /// XCTest types long strings in real time.
  var executionTimeout: TimeInterval {
    self == .type ? 55 : 30
  }
}

struct CommandRequest: Codable {
  let command: CommandKind
  let commandId: String?
  /// `status` only: the commandId whose journaled fate is requested.
  let statusCommandId: String?
  /// The app the command targets; required when `command.requiresAppBundleId`.
  let appBundleId: String?
  /// `tap`/`longPress`: absolute point (in points) in the app's coordinate space.
  let x: Double?
  let y: Double?
  /// `drag`: absolute start and end points.
  let fromX: Double?
  let fromY: Double?
  let toX: Double?
  let toY: Double?
  /// `longPress`: press duration. `drag`: duration of the movement.
  let durationMs: Double?
  /// `drag`: rest the touch at the destination before lifting so the scroll
  /// view reads ~0 release velocity (no fling) — mirrors the simulator's
  /// ease-out `settle` swipe.
  let settle: Bool?
  /// `type`: the text delivered to the focused input.
  let text: String?
  /// `snapshot`: keep only interactive elements.
  let interactiveOnly: Bool?
  /// `snapshot`: maximum emitted depth.
  let depth: Int?

  var normalizedCommandId: String? {
    guard let trimmed = commandId?.trimmingCharacters(in: .whitespacesAndNewlines),
      !trimmed.isEmpty
    else { return nil }
    return trimmed
  }

  var normalizedAppBundleId: String? {
    guard let trimmed = appBundleId?.trimmingCharacters(in: .whitespacesAndNewlines),
      !trimmed.isEmpty
    else { return nil }
    return trimmed
  }
}

/// Stable error codes shared with the TypeScript client. Only RUNNER_BUSY is
/// client-retryable; RUNNER_WEDGED tells the host to recycle the session.
enum RunnerErrorCode: String {
  case invalidRequest = "INVALID_REQUEST"
  case appBundleIdRequired = "APP_BUNDLE_ID_REQUIRED"
  case appNotAvailable = "APP_NOT_AVAILABLE"
  case textInputNotFocused = "TEXT_INPUT_NOT_FOCUSED"
  case unsupportedOperation = "UNSUPPORTED_OPERATION"
  case runnerBusy = "RUNNER_BUSY"
  case runnerWedged = "RUNNER_WEDGED"
  case xctestRecordedFailure = "XCTEST_RECORDED_FAILURE"
  case snapshotFailed = "SNAPSHOT_FAILED"
  case commandTimedOut = "COMMAND_TIMED_OUT"
  case commandFailed = "COMMAND_FAILED"
}

struct ErrorPayload: Encodable {
  let code: String
  let message: String
  let hint: String?
}

/// Type-erased Encodable so `Envelope` can carry any per-command payload
/// without a mega-struct of optionals.
struct AnyEncodable: Encodable {
  private let encodeInto: (Encoder) throws -> Void
  init<T: Encodable>(_ value: T) { self.encodeInto = value.encode(to:) }
  func encode(to encoder: Encoder) throws { try encodeInto(encoder) }
}

struct Envelope: Encodable {
  let ok: Bool
  let data: AnyEncodable?
  let error: ErrorPayload?

  static func success<T: Encodable>(_ payload: T) -> Envelope {
    Envelope(ok: true, data: AnyEncodable(payload), error: nil)
  }

  static func failure(_ code: RunnerErrorCode, _ message: String, hint: String? = nil) -> Envelope {
    Envelope(ok: false, data: nil, error: ErrorPayload(code: code.rawValue, message: message, hint: hint))
  }
}

// MARK: - Per-command payloads

struct MessagePayload: Encodable {
  let message: String
}

struct HealthPayload: Encodable {
  let uptimeMs: Double
  /// "idle" | "busy" | "wedged" — the main-thread gate's view of the runner.
  let state: String
}

struct CommandStatusPayload: Encodable {
  let commandId: String
  /// "notAccepted" | "accepted" | "started" | "completed" | "failed"
  let state: String
  let command: String?
  let responseOk: Bool?
  /// The completed command's full JSON envelope, when retained.
  let responseJson: String?
  let errorCode: String?
  let errorMessage: String?
  let errorHint: String?
}

struct ViewportPayload: Encodable {
  let x: Double
  let y: Double
  let width: Double
  let height: Double
}

struct ScreenshotPayload: Encodable {
  let imageBase64: String
}

struct SnapshotRect: Encodable {
  let x: Double
  let y: Double
  let width: Double
  let height: Double
}

struct SnapshotNodePayload: Encodable {
  let index: Int
  let type: String
  let label: String?
  let identifier: String?
  let value: String?
  let rect: SnapshotRect
  let enabled: Bool
  let focused: Bool?
  let selected: Bool?
  let hittable: Bool
  let depth: Int
  let parentIndex: Int?
  var hiddenContentAbove: Bool?
  var hiddenContentBelow: Bool?
}

struct SnapshotQualityPayload: Encodable {
  /// "healthy" | "degraded"
  let state: String
  let backend: String
  let reason: String?
  let reasonCode: String?
}

struct SnapshotPayload: Encodable {
  let nodes: [SnapshotNodePayload]
  let quality: SnapshotQualityPayload
}
