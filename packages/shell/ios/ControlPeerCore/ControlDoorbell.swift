import Darwin
import Foundation

public final class ControlDoorbell {
  public enum Outcome: String {
    case once, halfHour, always, deny, unshown, timeout, left, stopped, full, quiet, unsaved
  }

  public struct Ask {
    public let id: Int
    public let key: String?
    public let peer: ControlPeer
    public let deadline: Date
    public fileprivate(set) var connections: Set<Int>
  }

  public static let defaultDeadline: TimeInterval = 60
  public static let maxWaiting = 8
  public static let quietAfterRefusal: TimeInterval = 30

  public typealias Open = (_ connection: Int, _ fd: Int32, _ key: String?) -> Void
  public typealias Send = (_ name: String, _ body: [String: Any]) -> Bool

  private let queue: DispatchQueue
  private let deadline: TimeInterval
  private let tick: TimeInterval
  private let now: () -> Date
  private let open: Open
  private let send: Send
  private var waiting: [Int: (fd: Int32, ask: Int)] = [:]
  private var asks: [Int: Ask] = [:]
  private var quiet: [String: Date] = [:]
  private var nextAsk = 0
  private var timer: DispatchSourceTimer?

  public init(
    queue: DispatchQueue, deadline: TimeInterval = ControlDoorbell.defaultDeadline, tick: TimeInterval = 1, now: @escaping () -> Date = Date.init,
    open: @escaping Open, send: @escaping Send
  ) {
    self.queue = queue
    self.open = open
    self.send = send
    self.deadline = deadline
    self.tick = tick
    self.now = now
  }

  public var waitingCount: Int { waiting.count }
  public var openAsks: [Ask] { asks.values.sorted { $0.id < $1.id } }

  public func ring(connection: Int, fd: Int32, peer: ControlPeer, key: String?) {
    dispatchPrecondition(condition: .onQueue(queue))
    let at = now()
    quiet = quiet.filter { $0.value > at }
    if let key, quiet[key] != nil { return Self.refuse(fd, .quiet) }
    guard waiting.count < Self.maxWaiting else { return Self.refuse(fd, .full) }
    if let key, let shared = asks.values.first(where: { $0.key == key }) {
      asks[shared.id]?.connections.insert(connection)
      waiting[connection] = (fd, shared.id)
      return
    }
    nextAsk += 1
    let ask = Ask(id: nextAsk, key: key, peer: peer, deadline: at.addingTimeInterval(deadline), connections: [connection])
    let told = send("onPeerAsk", [
      "ask": ask.id, "name": peer.name, "signedBy": peer.signedBy, "path": peer.path ?? "", "identifier": peer.identifier ?? "",
      "remember": key != nil, "deadline": ask.deadline.timeIntervalSince1970 * 1000,
    ])
    guard told else { return Self.refuse(fd, .unshown) }
    asks[ask.id] = ask
    waiting[connection] = (fd, ask.id)
    arm()
  }

  @discardableResult
  public func answer(_ id: Int, _ outcome: Outcome, approvals: ControlApprovals?) -> Bool {
    dispatchPrecondition(condition: .onQueue(queue))
    guard let ask = asks[id] else { return false }
    switch outcome {
    case .once:
      end(id, .once, admit: true, key: nil)
    case .halfHour, .always:
      let decision: ControlPeerDecision = outcome == .always ? .always : .halfHour
      if let key = ask.key, let approval = decision.approval(for: ask.peer, key: key, now: now()), approvals?.add(approval, now: now()) == true {
        end(id, outcome, admit: true, key: key)
      } else {
        end(id, .unsaved, admit: true, key: nil)
      }
    case .deny:
      if let key = ask.key { quiet[key] = now().addingTimeInterval(Self.quietAfterRefusal) }
      end(id, .deny, admit: false, key: nil)
    case .unshown:
      end(id, .unshown, admit: false, key: nil)
    default:
      return false
    }
    return true
  }

  public func check() {
    dispatchPrecondition(condition: .onQueue(queue))
    for (connection, entry) in waiting where Self.peerLeft(entry.fd) {
      Darwin.close(entry.fd)
      waiting[connection] = nil
      asks[entry.ask]?.connections.remove(connection)
    }
    let at = now()
    for ask in openAsks {
      if ask.connections.isEmpty {
        end(ask.id, .left, admit: false, key: nil)
      } else if ask.deadline <= at {
        if let key = ask.key { quiet[key] = at.addingTimeInterval(Self.quietAfterRefusal) }
        end(ask.id, .timeout, admit: false, key: nil)
      }
    }
    if asks.isEmpty { disarm() }
  }

  public func stop() {
    dispatchPrecondition(condition: .onQueue(queue))
    for ask in openAsks { end(ask.id, .stopped, admit: false, key: nil) }
    for entry in waiting.values { Darwin.close(entry.fd) }
    waiting.removeAll()
    quiet.removeAll()
    disarm()
  }

  private func arm() {
    guard timer == nil else { return }
    let source = DispatchSource.makeTimerSource(queue: queue)
    source.schedule(deadline: .now() + tick, repeating: tick)
    source.setEventHandler { [weak self] in self?.check() }
    timer = source
    source.activate()
  }

  private func disarm() {
    timer?.cancel()
    timer = nil
  }

  private func end(_ id: Int, _ outcome: Outcome, admit: Bool, key: String?) {
    guard let ask = asks.removeValue(forKey: id) else { return }
    for connection in ask.connections.sorted() {
      guard let entry = waiting.removeValue(forKey: connection) else { continue }
      if admit { open(connection, entry.fd, key) } else { Self.refuse(entry.fd, outcome) }
    }
    _ = send("onPeerAskEnded", ["ask": id, "outcome": outcome.rawValue])
    if asks.isEmpty { disarm() }
  }

  public static func peerLeft(_ fd: Int32) -> Bool {
    var byte: UInt8 = 0
    let got = recv(fd, &byte, 1, MSG_PEEK | MSG_DONTWAIT)
    if got == 0 { return true }
    if got > 0 { return false }
    return errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR
  }

  public static func refusal(_ outcome: Outcome) -> String {
    switch outcome {
    case .deny, .quiet: return "You chose Don't Allow when Ardia asked whether this program may control it."
    case .timeout: return "Ardia asked whether this program may control it, and nobody answered in time."
    case .unshown: return "Ardia has to ask before this program may control it, and nobody can see the question (no Ardia window is on screen, or Ardia runs in the background)."
    case .full: return "Too many programs are waiting for Ardia to let them in. Try again in a minute."
    case .stopped: return "Control was turned off before anyone answered."
    default: return "Ardia didn't let this program control it."
    }
  }

  public static func refuse(_ fd: Int32, _ outcome: Outcome) {
    let body: [String: Any] = ["id": NSNull(), "error": ["code": "refused", "message": refusal(outcome)]]
    if var data = try? JSONSerialization.data(withJSONObject: body) {
      data.append(10)
      _ = data.withUnsafeBytes { Darwin.send(fd, $0.baseAddress, data.count, MSG_DONTWAIT) }
    }
    Darwin.close(fd)
  }
}
