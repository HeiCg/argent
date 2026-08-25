import Foundation
import Network

/// Minimal single-purpose HTTP/1.1 endpoint on NWListener: each connection
/// carries one POSTed JSON command and receives one JSON reply, then closes.
///
/// The listener is unauthenticated, so it binds loopback-only. That covers
/// the whole transport: the host reaches the runner through a usbmux
/// forwarded stream that terminates on the device's own loopback — verified
/// on hardware (a full session runs end-to-end over the loopback bind, and
/// an off-loopback probe to the runner port is refused).
/// Transport-level framing lives here and nothing else does: bodies are
/// opaque bytes handed to the dispatch closure.
final class RunnerHTTPServer {
  struct Reply {
    let status: Int
    let body: Data
    /// When set, the server invokes `onFinish` after this reply has been
    /// flushed — the shutdown acknowledgement must reach the client before
    /// the session tears the listener down.
    let finishAfterSend: Bool

    init(status: Int, body: Data, finishAfterSend: Bool = false) {
      self.status = status
      self.body = body
      self.finishAfterSend = finishAfterSend
    }
  }

  /// One command per request keeps the protocol trivially recoverable; a body
  /// larger than this is a client bug, not a bigger command.
  private static let maxRequestBytes = 2 * 1024 * 1024
  private let queue = DispatchQueue(label: "argent.runner.transport")
  private let dispatch: (Data, @escaping (Reply) -> Void) -> Void
  private let onFinish: () -> Void
  private var listener: NWListener?

  init(
    dispatch: @escaping (Data, @escaping (Reply) -> Void) -> Void,
    onFinish: @escaping () -> Void
  ) {
    self.dispatch = dispatch
    self.onFinish = onFinish
  }

  func start(port: UInt16) throws {
    // Loopback via requiredInterfaceType rather than a 127.0.0.1
    // requiredLocalEndpoint: the interface restriction admits loopback
    // traffic of either address family and leaves the port-0 auto-assign
    // branch — and the .port readback feeding the listening log — untouched.
    let parameters = NWParameters.tcp
    parameters.requiredInterfaceType = .loopback
    let listener: NWListener
    if port > 0, let nwPort = NWEndpoint.Port(rawValue: port) {
      listener = try NWListener(using: parameters, on: nwPort)
    } else {
      listener = try NWListener(using: parameters)
    }
    listener.stateUpdateHandler = { [weak self] state in
      switch state {
      case .ready:
        NSLog("ARGENT_RUNNER_LISTENING port=%d", Int(self?.listener?.port?.rawValue ?? 0))
      case .failed(let error):
        // A dead listener means no future command can arrive — end the
        // session so the host sees the exit instead of a silent hang.
        NSLog("ARGENT_RUNNER_LISTENER_FAILED error=%@", String(describing: error))
        self?.onFinish()
      default:
        break
      }
    }
    listener.newConnectionHandler = { [weak self] connection in
      guard let self else { return }
      connection.start(queue: self.queue)
      self.receive(on: connection, buffered: Data())
    }
    self.listener = listener
    listener.start(queue: queue)
  }

  func stop() {
    listener?.cancel()
    listener = nil
  }

  private func receive(on connection: NWConnection, buffered: Data) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) {
      [weak self] data, _, _, _ in
      guard let self, let data, !data.isEmpty else {
        connection.cancel()
        return
      }
      var buffer = buffered
      buffer.append(data)
      if buffer.count > Self.maxRequestBytes {
        self.send(
          Reply(status: 413, body: Self.oversizedRequestBody(limit: Self.maxRequestBytes)),
          over: connection
        )
        return
      }
      switch Self.requestVerdict(in: buffer) {
      case .complete(let body):
        self.dispatch(body) { reply in self.send(reply, over: connection) }
      case .incomplete:
        self.receive(on: connection, buffered: buffer)
      case .malformed:
        self.send(Reply(status: 400, body: Self.malformedRequestBody()), over: connection)
      case .oversized:
        self.send(
          Reply(status: 413, body: Self.oversizedRequestBody(limit: Self.maxRequestBytes)),
          over: connection
        )
      }
    }
  }

  private func send(_ reply: Reply, over connection: NWConnection) {
    let head = [
      "HTTP/1.1 \(reply.status) \(reply.status == 200 ? "OK" : "Error")",
      "Content-Type: application/json",
      "Content-Length: \(reply.body.count)",
      "Connection: close",
      "",
      "",
    ].joined(separator: "\r\n")
    var payload = Data(head.utf8)
    payload.append(reply.body)
    connection.send(
      content: payload,
      isComplete: true,
      completion: .contentProcessed { [weak self] error in
        if let error {
          NSLog("ARGENT_RUNNER_SEND_FAILED error=%@", String(describing: error))
        }
        connection.cancel()
        if reply.finishAfterSend {
          self?.onFinish()
        }
      }
    )
  }

  /// Verdict on the bytes buffered so far for one request.
  enum RequestVerdict: Equatable {
    /// Header block or declared body still in flight; keep receiving.
    case incomplete
    /// A full request; the payload is the raw body bytes.
    case complete(Data)
    /// The header block ended without a usable Content-Length (missing,
    /// non-numeric, negative, or overflowing). No later bytes can repair a
    /// finished header block, so waiting for more would hang the connection.
    case malformed
    /// The declared Content-Length alone exceeds `maxRequestBytes`, so the
    /// request is doomed before its body arrives.
    case oversized
  }

  static func requestVerdict(in buffer: Data) -> RequestVerdict {
    guard let headEnd = buffer.range(of: Data("\r\n\r\n".utf8)) else { return .incomplete }
    let head = String(decoding: buffer.subdata(in: buffer.startIndex..<headEnd.lowerBound), as: UTF8.self)
    var contentLength: Int?
    for line in head.split(separator: "\r\n") {
      let parts = line.split(separator: ":", maxSplits: 1)
      guard parts.count == 2 else { continue }
      if parts[0].trimmingCharacters(in: .whitespaces).lowercased() == "content-length" {
        contentLength = Int(parts[1].trimmingCharacters(in: .whitespaces))
      }
    }
    guard let contentLength, contentLength >= 0 else { return .malformed }
    guard contentLength <= maxRequestBytes else { return .oversized }
    let bodyStart = headEnd.upperBound
    guard buffer.distance(from: bodyStart, to: buffer.endIndex) >= contentLength else { return .incomplete }
    return .complete(buffer.subdata(in: bodyStart..<buffer.index(bodyStart, offsetBy: contentLength)))
  }

  private static func oversizedRequestBody(limit: Int) -> Data {
    Data(
      #"{"ok":false,"error":{"code":"INVALID_REQUEST","message":"request body exceeds \#(limit) bytes"}}"#
        .utf8
    )
  }

  private static func malformedRequestBody() -> Data {
    Data(
      #"{"ok":false,"error":{"code":"INVALID_REQUEST","message":"request headers lack a usable Content-Length"}}"#
        .utf8
    )
  }
}
