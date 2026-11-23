import Foundation

enum WindowDragTakeover {
  static let samePress: TimeInterval = 0.03

  static func pressIsLatest(pressedAt: TimeInterval, lastDownAt: TimeInterval?) -> Bool {
    guard let lastDownAt else { return true }
    return lastDownAt <= pressedAt + samePress
  }

  static func takesOver(pressedAt: TimeInterval, lastDownAt: TimeInterval?, held: Bool) -> Bool {
    held && pressIsLatest(pressedAt: pressedAt, lastDownAt: lastDownAt)
  }
}
