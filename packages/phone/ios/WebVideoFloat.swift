import AVKit
import UIKit
import WebKit

@MainActor
final class WebVideoFloat {
  enum Outcome: String {
    case floated
    case keptPlaying
  }

  static let keptPlayingCheck: TimeInterval = 5
  static let playbackAnswerLimit: TimeInterval = 1

  private var observer: NSObjectProtocol?
  private var departure = 0

  init(shownWebView: @escaping @MainActor () -> WKWebView?, report: @escaping @MainActor (Outcome) -> Void) {
    observer = NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
      MainActor.assumeIsolated { self?.leftForeground(shownWebView, report) }
    }
  }

  private func leftForeground(_ shownWebView: @escaping @MainActor () -> WKWebView?, _ report: @escaping @MainActor (Outcome) -> Void) {
    departure += 1
    guard Self.isPresentingWebVideo else { return }
    report(.floated)
    let departed = departure
    Task { @MainActor [weak self] in
      try? await Task.sleep(for: .seconds(Self.keptPlayingCheck))
      guard let self, self.departure == departed, UIApplication.shared.applicationState == .background, Self.isPresentingWebVideo,
            let webView = shownWebView(), await Self.isPlaying(webView),
            self.departure == departed, UIApplication.shared.applicationState == .background else { return }
      report(.keptPlaying)
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

  private static func isPlaying(_ webView: WKWebView) async -> Bool {
    await withCheckedContinuation { continuation in
      let answer = FirstAnswer(continuation)
      webView.requestMediaPlaybackState { state in
        MainActor.assumeIsolated { answer.give(state == .playing) }
      }
      DispatchQueue.main.asyncAfter(deadline: .now() + playbackAnswerLimit) {
        MainActor.assumeIsolated { answer.give(false) }
      }
    }
  }
}

@MainActor
private final class FirstAnswer: Sendable {
  private var continuation: CheckedContinuation<Bool, Never>?

  init(_ continuation: CheckedContinuation<Bool, Never>) {
    self.continuation = continuation
  }

  func give(_ playing: Bool) {
    continuation?.resume(returning: playing)
    continuation = nil
  }
}

extension PhonePages {
  func shownWebView() -> WKWebView? {
    engine.tabs.selectedTabID.flatMap(engine.existingWebTab)?.webView
  }

  func webVideoLeftForeground(_ outcome: WebVideoFloat.Outcome) {
    let shown = engine.tabs.selectedTabID
    pageSink?(["name": "pages.webVideo", "outcome": outcome.rawValue, "isPrivate": shown.map(engine.tabs.isPrivate) ?? false])
  }
}
