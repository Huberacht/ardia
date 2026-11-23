import CoreGraphics
import Foundation

public struct GlassPageKey: Hashable, Sendable {
  public var page: Int
  public var navigation: Int

  public init(page: Int, navigation: Int) {
    self.page = page
    self.navigation = navigation
  }
}

public struct GlassSnapshotGate: Sendable {
  public private(set) var key: GlassPageKey?
  public private(set) var token = 0
  public private(set) var failures = 0
  public private(set) var nextRequest: TimeInterval = 0
  public private(set) var lastRequest: TimeInterval = -.infinity

  public init() {}

  @discardableResult
  public mutating func observe(_ key: GlassPageKey) -> Bool {
    guard key != self.key else { return false }
    self.key = key
    token += 1
    failures = 0
    nextRequest = 0
    return true
  }

  public func mayRequest(now: TimeInterval, changed: Bool, pending: Bool) -> Bool {
    guard !pending, now >= nextRequest else { return false }
    let since = now - lastRequest
    return changed ? since >= GlassFlowRules.snapshotGap : since >= GlassFlowRules.snapshotRefresh
  }

  public mutating func begin(now: TimeInterval) -> Int {
    token += 1
    lastRequest = now
    return token
  }

  public func accepts(token: Int, key: GlassPageKey) -> Bool {
    token == self.token && key == self.key
  }

  public mutating func succeeded() {
    failures = 0
    nextRequest = 0
  }

  public mutating func failed(now: TimeInterval) {
    failures += 1
    nextRequest = now + LiquidGlassRules.captureRetryDelay(failures: failures)
  }
}

public struct GlassFlight: Sendable {
  public private(set) var inFlight = 0
  public let limit: Int

  public init(limit: Int = LiquidGlassRules.framesInFlight) {
    self.limit = limit
  }

  public var hasRoom: Bool { inFlight < limit }

  public mutating func reserve() -> Bool {
    guard hasRoom else { return false }
    inFlight += 1
    return true
  }

  public mutating func finish() {
    inFlight = max(inFlight - 1, 0)
  }
}

public enum GlassFlowRules {
  public static let snapshotGap: TimeInterval = 1.0 / 20
  public static let snapshotRefresh: TimeInterval = 0.5
  public static let quietFramesForRecapture = 2
  public static let scrollReach: CGFloat = 200
  public static let scrollStep: CGFloat = 120

  public static func scrollBucket(_ offset: CGPoint) -> [Int] {
    [Int((offset.x / scrollStep).rounded(.down)), Int((offset.y / scrollStep).rounded(.down))]
  }

  public static func snapshotCovers(image: CGRect, shift: CGPoint, needed: CGRect) -> Bool {
    guard !image.isNull, !needed.isNull, !needed.isEmpty else { return false }
    return image.offsetBy(dx: -shift.x, dy: -shift.y).contains(needed)
  }

  public static func canAcquireDrawable(outstanding: Int, maximum: Int) -> Bool {
    outstanding <= maximum - 3
  }

  public static func overFrame(captureMs: Double, frameMs: Double) -> Bool {
    captureMs > frameMs
  }

  public static func recaptureNow(changed: Bool, quietFrames: Int, sinceCapture: TimeInterval, gap: TimeInterval) -> Bool {
    guard changed else { return false }
    return sinceCapture >= gap || quietFrames >= quietFramesForRecapture
  }
}
