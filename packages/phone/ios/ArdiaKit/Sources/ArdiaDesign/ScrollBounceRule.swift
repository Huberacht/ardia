public enum ScrollBounceRule {
  static let keptPrefixes = ["WK", "UIPicker", "_UIPicker", "UIDatePicker", "_UIDatePicker", "UIKeyboard", "_UIKeyboard", "TUI"]

  public static func keepsBounce(className: String, refreshes: Bool, insideWebPage: Bool) -> Bool {
    refreshes || insideWebPage || keptPrefixes.contains { className.hasPrefix($0) }
  }

  public static func bounces(wanted: Bool, keeps: Bool) -> Bool {
    wanted && keeps
  }
}
