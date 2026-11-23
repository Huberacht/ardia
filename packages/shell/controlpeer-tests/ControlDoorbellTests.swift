import ArdiaControlPeerCore
import Darwin
import Foundation
import XCTest

final class ControlDoorbellTests: XCTestCase {
  private let queue = DispatchQueue(label: "doorbell-tests")
  private var clock = Date(timeIntervalSince1970: 5_000_000)
  private var opened: [(Int, Int32, String?)] = []
  private var events: [(String, [String: Any])] = []
  private var listening = true
  private var clients: [Int32] = []
  private var scratch: URL!

  override func setUpWithError() throws {
    scratch = URL(fileURLWithPath: "/private/tmp").appendingPathComponent("acd-\(getpid())-\(UInt32.random(in: 0...UInt32.max))")
    try FileManager.default.createDirectory(at: scratch, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
  }

  override func tearDownWithError() throws {
    clients.forEach { close($0) }
    opened.forEach { close($0.1) }
    try? FileManager.default.removeItem(at: scratch)
  }

  private func doorbell(deadline: TimeInterval = 60, tick: TimeInterval = 3600) -> ControlDoorbell {
    ControlDoorbell(
      queue: queue, deadline: deadline, tick: tick, now: { [unowned self] in self.clock },
      open: { [unowned self] connection, fd, key in self.opened.append((connection, fd, key)) },
      send: { [unowned self] name, body in
        guard self.listening else { return false }
        self.events.append((name, body))
        return true
      })
  }

  private func pair() -> Int32 {
    var fds: [Int32] = [0, 0]
    XCTAssertEqual(socketpair(AF_UNIX, SOCK_STREAM, 0, &fds), 0)
    clients.append(fds[1])
    return fds[0]
  }

  private func refusal(_ client: Int32) -> String? {
    var buffer = [UInt8](repeating: 0, count: 4096)
    let got = recv(client, &buffer, buffer.count, MSG_DONTWAIT)
    guard got > 0, let object = try? JSONSerialization.jsonObject(with: Data(buffer[..<got])) as? [String: Any] else { return nil }
    XCTAssertTrue(object["id"] is NSNull)
    return (object["error"] as? [String: Any])?["code"] as? String
  }

  private let tool = ControlPeer(pid: 9, path: "/opt/tool", identifier: "com.x.tool", signer: .team("XXXXXXXXXX"), developer: "X Inc", cdhash: "cc", hardened: true)

  func testAllowOnceOpensEveryConnectionOfTheAskWithoutRemembering() {
    let bell = doorbell()
    let a = pair(), b = pair()
    queue.sync {
      bell.ring(connection: 1, fd: a, peer: tool, key: tool.approvalKey)
      bell.ring(connection: 2, fd: b, peer: tool, key: tool.approvalKey)
    }
    XCTAssertEqual(events.map(\.0), ["onPeerAsk"])
    XCTAssertEqual(events[0].1["name"] as? String, "tool")
    XCTAssertEqual(events[0].1["signedBy"] as? String, "Signed by X Inc (XXXXXXXXXX)")
    XCTAssertEqual(events[0].1["remember"] as? Bool, true)
    let ask = events[0].1["ask"] as! Int
    XCTAssertTrue(queue.sync { bell.answer(ask, .once, approvals: nil) })
    XCTAssertEqual(opened.map(\.0), [1, 2])
    XCTAssertEqual(opened.map(\.2), [nil, nil])
    XCTAssertEqual(events.last?.1["outcome"] as? String, "once")
    XCTAssertFalse(queue.sync { bell.answer(ask, .deny, approvals: nil) })
    XCTAssertEqual(queue.sync { bell.waitingCount }, 0)
  }

  func testAlwaysAndHalfHourAreSavedAndKeyed() {
    let store = ControlApprovals(directory: scratch.path)
    let bell = doorbell()
    queue.sync { bell.ring(connection: 1, fd: pair(), peer: tool, key: tool.approvalKey) }
    XCTAssertTrue(queue.sync { bell.answer(events[0].1["ask"] as! Int, .halfHour, approvals: store) })
    XCTAssertEqual(opened.map(\.2), [tool.approvalKey])
    let saved = store.load(now: clock)
    XCTAssertEqual(saved.map(\.key), [tool.approvalKey!])
    XCTAssertEqual(saved.first?.until, clock.timeIntervalSince1970 + 1800)
    queue.sync { bell.ring(connection: 2, fd: pair(), peer: tool, key: tool.approvalKey) }
    XCTAssertTrue(queue.sync { bell.answer(events.last!.1["ask"] as! Int, .always, approvals: store) })
    XCTAssertNil(store.load(now: clock.addingTimeInterval(1_000_000)).first?.until)
  }

  func testAnUnrememberablePeerIsOpenedOnceEvenForAlways() {
    let bell = doorbell()
    let unsigned = ControlPeer(pid: 3, path: "/c/tool", identifier: nil, signer: .other, developer: nil, cdhash: nil, hardened: false)
    queue.sync { bell.ring(connection: 1, fd: pair(), peer: unsigned, key: nil) }
    XCTAssertEqual(events[0].1["remember"] as? Bool, false)
    XCTAssertTrue(queue.sync { bell.answer(events[0].1["ask"] as! Int, .always, approvals: ControlApprovals(directory: scratch.path)) })
    XCTAssertEqual(opened.map(\.2), [nil])
    XCTAssertEqual(events.last?.1["outcome"] as? String, "unsaved")
  }

  func testDenyRefusesAndQuietsTheSameProgramForAWhile() {
    let bell = doorbell()
    let fd = pair()
    let client = clients.last!
    queue.sync { bell.ring(connection: 1, fd: fd, peer: tool, key: tool.approvalKey) }
    XCTAssertTrue(queue.sync { bell.answer(events[0].1["ask"] as! Int, .deny, approvals: nil) })
    XCTAssertEqual(refusal(client), "refused")
    XCTAssertTrue(opened.isEmpty)
    queue.sync { bell.ring(connection: 2, fd: pair(), peer: tool, key: tool.approvalKey) }
    XCTAssertEqual(refusal(clients.last!), "refused")
    XCTAssertEqual(events.filter { $0.0 == "onPeerAsk" }.count, 1)
    clock = clock.addingTimeInterval(ControlDoorbell.quietAfterRefusal + 1)
    queue.sync { bell.ring(connection: 3, fd: pair(), peer: tool, key: tool.approvalKey) }
    XCTAssertEqual(events.filter { $0.0 == "onPeerAsk" }.count, 2)
  }

  func testTimeoutAndPeerLeaving() {
    let bell = doorbell(deadline: 10)
    let left = pair()
    let leftClient = clients.last!
    let other = ControlPeer(pid: 4, path: "/d/other", identifier: "com.y.other", signer: .team("YYYYYYYYYY"), developer: nil, cdhash: "dd", hardened: true)
    queue.sync {
      bell.ring(connection: 1, fd: left, peer: tool, key: tool.approvalKey)
      bell.ring(connection: 2, fd: pair(), peer: other, key: other.approvalKey)
    }
    let waitingClient = clients.last!
    close(leftClient)
    clients.removeAll { $0 == leftClient }
    queue.sync { bell.check() }
    XCTAssertEqual(events.filter { $0.0 == "onPeerAskEnded" }.map { $0.1["outcome"] as? String }, ["left"])
    clock = clock.addingTimeInterval(11)
    queue.sync { bell.check() }
    XCTAssertEqual(events.filter { $0.0 == "onPeerAskEnded" }.map { $0.1["outcome"] as? String }, ["left", "timeout"])
    XCTAssertEqual(refusal(waitingClient), "refused")
    XCTAssertTrue(opened.isEmpty)
    XCTAssertEqual(queue.sync { bell.waitingCount }, 0)
  }

  func testNobodyListeningAndTooManyWaitingAreRefused() {
    listening = false
    let bell = doorbell()
    queue.sync { bell.ring(connection: 1, fd: pair(), peer: tool, key: tool.approvalKey) }
    XCTAssertEqual(refusal(clients.last!), "refused")
    listening = true
    queue.sync {
      for n in 0..<ControlDoorbell.maxWaiting { bell.ring(connection: 10 + n, fd: pair(), peer: tool, key: nil) }
      bell.ring(connection: 99, fd: pair(), peer: tool, key: nil)
    }
    XCTAssertEqual(refusal(clients.last!), "refused")
    XCTAssertEqual(queue.sync { bell.waitingCount }, ControlDoorbell.maxWaiting)
    queue.sync { bell.stop() }
    XCTAssertEqual(queue.sync { bell.waitingCount }, 0)
    XCTAssertEqual(events.filter { $0.0 == "onPeerAskEnded" }.count, ControlDoorbell.maxWaiting)
    XCTAssertTrue(events.filter { $0.0 == "onPeerAskEnded" }.allSatisfy { $0.1["outcome"] as? String == "stopped" })
  }

  func testTimerEndsAnUnansweredAsk() {
    let bell = ControlDoorbell(
      queue: queue, deadline: 0.2, tick: 0.05,
      open: { _, _, _ in XCTFail("nothing opens") },
      send: { [unowned self] name, body in
        self.events.append((name, body))
        return true
      })
    let ended = expectation(description: "ended")
    queue.sync { bell.ring(connection: 1, fd: pair(), peer: tool, key: nil) }
    queue.asyncAfter(deadline: .now() + 0.6) {
      if self.events.contains(where: { $0.0 == "onPeerAskEnded" && $0.1["outcome"] as? String == "timeout" }) { ended.fulfill() }
    }
    wait(for: [ended], timeout: 2)
  }
}
