import Foundation

enum WindowDragTakeover {
  enum Outcome: Equatable { case native, takeOver, stale }

  static func outcome(pressedAt: TimeInterval, latestPressAt: TimeInterval?, queuedPressAt: TimeInterval?, held: Bool) -> Outcome {
    if let latestPressAt, latestPressAt > pressedAt { return .stale }
    if let queuedPressAt, queuedPressAt > pressedAt { return .stale }
    return held ? .takeOver : .native
  }

  static func belongs(eventAt: TimeInterval, pressedAt: TimeInterval) -> Bool {
    eventAt >= pressedAt
  }
}
