import CoreGraphics

public enum ScrollBounceTarget {
  public static let ancestorsSearched = 6
  public static let viewsSearched = 400
  public static let tolerance: CGFloat = 2

  public static func matches(className: String, frame: CGRect, mine: CGRect) -> Bool {
    guard !className.hasPrefix("WK"), !mine.isEmpty, !frame.isEmpty else { return false }
    return abs(frame.minX - mine.minX) <= tolerance && abs(frame.minY - mine.minY) <= tolerance && abs(frame.width - mine.width) <= tolerance && abs(frame.height - mine.height) <= tolerance
  }
}
