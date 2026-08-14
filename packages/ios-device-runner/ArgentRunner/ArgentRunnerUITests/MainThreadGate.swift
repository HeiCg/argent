import Foundation

/// Marshals command work onto the main thread — pumped by the XCTWaiter in
/// ArgentRunnerSession — under a hard per-command budget, and remembers work
/// the budget abandoned.
///
/// XCTest work cannot be cancelled once started: when a block overruns, the
/// gate reports the timeout to its caller but the block keeps running on the
/// main thread. Queueing more work behind it would only bury the runner
/// deeper, so while any abandoned block is still draining the gate reports
/// `busy` and the session refuses new commands fast. Past `wedgeThreshold`
/// it reports `wedged`, the signal for the host to recycle the whole runner —
/// the only cure once the main thread is stuck for good.
final class MainThreadGate {
  enum Availability {
    case idle
    case busy(abandonedForSeconds: TimeInterval)
    case wedged(abandonedForSeconds: TimeInterval)
  }

  enum Failure: Error {
    case timedOut
  }

  /// One dispatched block's lifecycle flags; the lock arbitrates so exactly
  /// one of "finished in time" / "abandoned" is ever true.
  private final class WorkState {
    var finished = false
    var abandoned = false
  }

  private let lock = NSLock()
  private var abandonedCount = 0
  private var abandonedSince: Date?
  private let wedgeThreshold: TimeInterval

  init(wedgeThreshold: TimeInterval = 120) {
    self.wedgeThreshold = wedgeThreshold
  }

  func availability() -> Availability {
    lock.lock()
    defer { lock.unlock() }
    guard abandonedCount > 0 else { return .idle }
    let stuckFor = abandonedSince.map { Date().timeIntervalSince($0) } ?? 0
    return stuckFor > wedgeThreshold
      ? .wedged(abandonedForSeconds: stuckFor)
      : .busy(abandonedForSeconds: stuckFor)
  }

  func run<T>(timeout: TimeInterval, _ work: @escaping () throws -> T) throws -> T {
    if Thread.isMainThread {
      return try work()
    }
    let semaphore = DispatchSemaphore(value: 0)
    let state = WorkState()
    var result: Result<T, Error>?
    DispatchQueue.main.async {
      do {
        result = .success(try work())
      } catch {
        result = .failure(error)
      }
      self.lock.lock()
      if state.abandoned {
        self.abandonedCount -= 1
        if self.abandonedCount == 0 {
          self.abandonedSince = nil
          NSLog("ARGENT_RUNNER_ABANDONED_WORK_DRAINED")
        }
      } else {
        state.finished = true
      }
      self.lock.unlock()
      semaphore.signal()
    }
    if semaphore.wait(timeout: .now() + timeout) == .timedOut {
      lock.lock()
      if !state.finished {
        state.abandoned = true
        abandonedCount += 1
        if abandonedSince == nil {
          abandonedSince = Date()
        }
      }
      lock.unlock()
      throw Failure.timedOut
    }
    switch result {
    case .success(let value):
      return value
    case .failure(let error):
      throw error
    case .none:
      throw Failure.timedOut
    }
  }
}
