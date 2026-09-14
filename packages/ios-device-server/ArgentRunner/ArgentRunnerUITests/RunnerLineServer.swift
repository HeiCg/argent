import Foundation
import Network

/// Newline-delimited JSON-RPC 2.0 TCP endpoint on NWListener, mirroring the
/// Android `TCPServer.kt`: each line is one complete request; the reply is a
/// single JSON line + `\n`. The listener is unauthenticated, so it binds
/// loopback only — on the simulator the host reaches it straight over
/// `127.0.0.1:<port>`; on a physical device it terminates on the device's own
/// loopback behind the usbmux forward.
///
/// Replaces base B's `RunnerHTTPServer` (one HTTP POST per command). Framing is
/// now line-oriented so the host reuses `open-server-transport`'s NDJSON reader.
final class RunnerLineServer {
    /// The dispatch closure gets one request line and a `deliver` callback that
    /// writes exactly one reply line back on the same connection. `finish` is
    /// true when the reply is a `shutdown` ack, after which the session ends.
    typealias Dispatch = (Data, @escaping (Data, _ finish: Bool) -> Void) -> Void

    /// Upper bound on a single buffered line. A request carries one command, so a
    /// larger line indicates a client bug or a framing error.
    private static let maxLineBytes = 4 * 1024 * 1024

    private let queue = DispatchQueue(label: "argent.runner.transport")
    private let dispatch: Dispatch
    private let onFinish: () -> Void
    private var listener: NWListener?

    init(dispatch: @escaping Dispatch, onFinish: @escaping () -> Void) {
        self.dispatch = dispatch
        self.onFinish = onFinish
    }

    /// Starts listening on loopback, on `port` or a system-assigned one when
    /// `port` is 0. `allowLocalEndpointReuse` mirrors the Android server's
    /// `SO_REUSEADDR`, so a quick relaunch does not fail to bind.
    func start(port: UInt16) throws {
        let tcpOptions = NWProtocolTCP.Options()
        // Reply lines are small and single; disable Nagle so each reply flushes
        // immediately (the Android server sets TCP_NODELAY for the same reason).
        tcpOptions.noDelay = true
        let parameters = NWParameters(tls: nil, tcp: tcpOptions)
        parameters.requiredInterfaceType = .loopback
        parameters.allowLocalEndpointReuse = true

        let listener: NWListener
        if port > 0, let nwPort = NWEndpoint.Port(rawValue: port) {
            listener = try NWListener(using: parameters, on: nwPort)
        } else {
            listener = try NWListener(using: parameters)
        }

        listener.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready:
                // The host greps this line for the actual bound port when it asked
                // for 0 (an Xcode-run session).
                NSLog("ARGENT_RUNNER_LISTENING port=%d", Int(self?.listener?.port?.rawValue ?? 0))
            case .failed(let error):
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

    /// Accumulates bytes, splitting on `\n`; each complete line is dispatched and
    /// its reply written back with a trailing `\n`.
    private func receive(on connection: NWConnection, buffered: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 1 << 20) {
            [weak self] data, _, isComplete, error in
            guard let self else { return }

            var buffer = buffered
            if let data, !data.isEmpty {
                buffer.append(data)
            }

            // Drain every complete line currently in the buffer.
            let newline = UInt8(ascii: "\n")
            while let idx = buffer.firstIndex(of: newline) {
                let line = buffer.subdata(in: buffer.startIndex..<idx)
                buffer.removeSubrange(buffer.startIndex...idx)

                let trimmed = Self.trimmed(line)
                if trimmed.isEmpty { continue }

                self.dispatch(trimmed) { reply, finish in
                    self.send(reply, over: connection, finish: finish)
                }
            }

            if buffer.count > Self.maxLineBytes {
                NSLog("ARGENT_RUNNER_LINE_OVERFLOW bytes=%d", buffer.count)
                connection.cancel()
                return
            }

            if isComplete || (error != nil) {
                connection.cancel()
                return
            }

            self.receive(on: connection, buffered: buffer)
        }
    }

    /// Writes one reply line (`<json>\n`) and, for a shutdown ack, ends the
    /// session after the bytes are flushed so the ack reaches the client first.
    private func send(_ reply: Data, over connection: NWConnection, finish: Bool) {
        var payload = reply
        payload.append(UInt8(ascii: "\n"))
        connection.send(
            content: payload,
            isComplete: false,
            completion: .contentProcessed { [weak self] error in
                if let error {
                    NSLog("ARGENT_RUNNER_SEND_FAILED error=%@", String(describing: error))
                }
                if finish {
                    self?.onFinish()
                }
            }
        )
    }

    /// Drops leading/trailing ASCII whitespace (spaces, `\r`, tabs) so a `\r\n`
    /// line ending or padded reply never reaches the JSON decoder.
    private static func trimmed(_ data: Data) -> Data {
        let ws: Set<UInt8> = [0x20, 0x09, 0x0d, 0x0a]
        var start = data.startIndex
        var end = data.endIndex
        while start < end, ws.contains(data[start]) { start = data.index(after: start) }
        while end > start, ws.contains(data[data.index(before: end)]) { end = data.index(before: end) }
        return data.subdata(in: start..<end)
    }
}
