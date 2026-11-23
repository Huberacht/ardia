import AVKit
import UIKit

@MainActor
final class WebVideoFloat {
  enum Outcome: String {
    case floated
    case keptPlaying
  }

  static let keptPlayingCheck: TimeInterval = 5

  private var observer: NSObjectProtocol?
  private var departure = 0

  init(report: @escaping @MainActor (Outcome) -> Void) {
    observer = NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.leftForeground(report) }
    }
  }

  private func leftForeground(_ report: @escaping @MainActor (Outcome) -> Void) {
    departure += 1
    guard Self.isPresentingWebVideo else { return }
    report(.floated)
    let departed = departure
    DispatchQueue.main.asyncAfter(deadline: .now() + Self.keptPlayingCheck) { [weak self] in
      MainActor.assumeIsolated {
        guard let self, self.departure == departed, UIApplication.shared.applicationState == .background, Self.isPresentingWebVideo else { return }
        report(.keptPlaying)
      }
    }
  }

  static var isPresentingWebVideo: Bool {
    UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap(\.windows)
      .contains { window in
        !window.isHidden && window.rootViewController?.children.contains { $0 is AVPlayerViewController } == true
      }
  }
}

extension PhonePages {
  func webVideoLeftForeground(_ outcome: WebVideoFloat.Outcome) {
    let shown = engine.tabs.selectedTabID
    pageSink?(["name": "pages.webVideo", "outcome": outcome.rawValue, "isPrivate": shown.map(engine.tabs.isPrivate) ?? false])
  }
}
