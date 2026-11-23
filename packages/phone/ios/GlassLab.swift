import QuartzCore
import UIKit
import WebKit

@MainActor
final class GlassLabScroll: NSObject {
  private static var running: GlassLabScroll?

  private let web: WKWebView
  private let seconds: Double
  private var link: CADisplayLink?
  private var started: CFTimeInterval = 0

  private init(web: WKWebView, seconds: Double) {
    self.web = web
    self.seconds = seconds
  }

  static func start(after delay: Double, for seconds: Double) {
    DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
      MainActor.assumeIsolated {
        let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
        guard let web = windows.flatMap(pages).max(by: { $0.bounds.width * $0.bounds.height < $1.bounds.width * $1.bounds.height }) else {
          NSLog("PAGELAB glass scroll found no page")
          return
        }
        let scroll = GlassLabScroll(web: web, seconds: seconds)
        running = scroll
        scroll.begin()
      }
    }
  }

  private static func pages(in view: UIView) -> [WKWebView] {
    if let web = view as? WKWebView { return web.window != nil && !web.isHidden ? [web] : [] }
    return view.subviews.flatMap(pages)
  }

  private func begin() {
    started = CACurrentMediaTime()
    let made = CADisplayLink(target: self, selector: #selector(tick(_:)))
    made.add(to: .main, forMode: .common)
    link = made
    NSLog("PAGELAB glass scroll started for %.0f s", seconds)
  }

  @objc private func tick(_ link: CADisplayLink) {
    let elapsed = CACurrentMediaTime() - started
    let scroll = web.scrollView
    let reach = max(min(scroll.contentSize.height - scroll.bounds.height, 2400), 0)
    let wave = (1 - cos(elapsed / 4 * 2 * Double.pi)) / 2
    scroll.contentOffset = CGPoint(x: scroll.contentOffset.x, y: CGFloat(wave) * reach - scroll.adjustedContentInset.top)
    guard elapsed >= seconds else { return }
    link.invalidate()
    self.link = nil
    Self.running = nil
    NSLog("PAGELAB glass scroll done")
  }
}
