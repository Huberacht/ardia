import CoreGraphics
import Foundation

public struct GlassPageKey: Hashable, Sendable {
  public var page: Int
  public var navigation: Int
  public var committed: Int

  public init(page: Int, navigation: Int, committed: Int = 0) {
    self.page = page
    self.navigation = navigation
    self.committed = committed
  }
}

public struct GlassSnapshotAsk: Equatable, Sendable {
  public var hasImage: Bool
  public var pending: Bool
  public var stillFrames: Int
  public var distance: CGFloat
  public var age: TimeInterval
  public var committed: Bool

  public init(hasImage: Bool, pending: Bool, stillFrames: Int, distance: CGFloat, age: TimeInterval, committed: Bool) {
    self.hasImage = hasImage
    self.pending = pending
    self.stillFrames = stillFrames
    self.distance = distance
    self.age = age
    self.committed = committed
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

  public func mayRequest(now: TimeInterval, _ ask: GlassSnapshotAsk) -> Bool {
    guard !ask.pending, now >= nextRequest, ask.committed, ask.stillFrames >= GlassFlowRules.stillFramesForSnapshot else { return false }
    guard ask.hasImage else { return true }
    return ask.distance >= GlassFlowRules.snapshotRefetchDistance || ask.age >= GlassFlowRules.snapshotRefresh
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
  public static let snapshotRefresh: TimeInterval = 1
  public static let stillFramesForSnapshot = 3
  public static let snapshotRefetchDistance: CGFloat = 600
  public static let uniformTolerance = 4.0 / 255
  public static let backgroundTolerance = 10.0 / 255
  public static let quietFramesForRecapture = 2
  public static let scrollReach: CGFloat = 200
  public static let scrollStep: CGFloat = 120
  public static let snapshotReach: CGFloat = 1500

  public static func snapshotRect(around needed: CGRect) -> CGRect {
    needed.insetBy(dx: 0, dy: -snapshotReach)
  }

  public static func scrollBucket(_ offset: CGPoint) -> [Int] {
    [Int((offset.x / scrollStep).rounded(.down)), Int((offset.y / scrollStep).rounded(.down))]
  }

  public static func acceptsSnapshot(requested: CGPoint, now: CGPoint, movedWhilePending: Bool, zoomRequested: CGFloat, zoomNow: CGFloat) -> Bool {
    !movedWhilePending && requested == now && zoomRequested == zoomNow
  }

  public static func uniform(_ samples: [[Double]]) -> [Double]? {
    guard let first = samples.first else { return nil }
    for channel in first.indices {
      let values = samples.map { $0[channel] }
      guard let low = values.min(), let high = values.max(), high - low <= uniformTolerance else { return nil }
    }
    return first
  }

  public static func acceptsUniform(_ color: [Double], background: [Double]?) -> Bool {
    guard let background, background.count == color.count else { return false }
    return zip(color, background).allSatisfy { abs($0 - $1) <= backgroundTolerance }
  }

  public static func footprint(of glass: CGRect, margin: CGFloat) -> CGRect {
    glass.insetBy(dx: -margin, dy: -margin)
  }

  public static func shiftable(pageIndex: Int?, overlapsAbove: [Bool]) -> Bool {
    guard let pageIndex else { return false }
    return !overlapsAbove.enumerated().contains { $0.offset > pageIndex && $0.element }
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
