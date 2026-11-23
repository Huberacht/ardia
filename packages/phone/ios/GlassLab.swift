import ArdiaBrowser
import QuartzCore
import UIKit
import WebKit

@MainActor
final class GlassLabScroll: NSObject {
  private static var running: GlassLabScroll?

  private let web: WKWebView
  private let seconds: Double
  private let period: Double
  private var link: CADisplayLink?
  private var started: CFTimeInterval = 0

  private init(web: WKWebView, seconds: Double, period: Double) {
    self.web = web
    self.seconds = seconds
    self.period = period
  }

  static func start(after delay: Double, for seconds: Double, period: Double = 4) {
    DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
      MainActor.assumeIsolated {
        let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
        guard let web = windows.flatMap(pages).max(by: { $0.bounds.width * $0.bounds.height < $1.bounds.width * $1.bounds.height }) else {
          NSLog("PAGELAB glass scroll found no page")
          return
        }
        let scroll = GlassLabScroll(web: web, seconds: seconds, period: period)
        running = scroll
        scroll.begin()
      }
    }
  }

  static func pages(in view: UIView) -> [WKWebView] {
    if view.isHidden || view.alpha <= 0.01 { return [] }
    if let web = view as? WKWebView {
      guard let window = web.window, web.convert(web.bounds, to: window).intersects(window.bounds) else { return [] }
      return [web]
    }
    return view.subviews.flatMap(pages)
  }

  private func begin() {
    started = CACurrentMediaTime()
    WebTab.labScrollCountsAsTouch = true
    let made = CADisplayLink(target: self, selector: #selector(tick(_:)))
    made.add(to: .main, forMode: .common)
    link = made
    NSLog("PAGELAB glass scroll started for %.0f s", seconds)
  }

  @objc private func tick(_ link: CADisplayLink) {
    let elapsed = CACurrentMediaTime() - started
    let scroll = web.scrollView
    let reach = max(min(scroll.contentSize.height - scroll.bounds.height, 2400), 0)
    let wave = (1 - cos(elapsed / period * 2 * Double.pi)) / 2
    scroll.contentOffset = CGPoint(x: scroll.contentOffset.x, y: CGFloat(wave) * reach - scroll.adjustedContentInset.top)
    guard elapsed >= seconds else { return }
    link.invalidate()
    self.link = nil
    WebTab.labScrollCountsAsTouch = false
    Self.running = nil
    NSLog("PAGELAB glass scroll done")
  }
}

@MainActor
enum GlassLabRim {
  static func start(after delay: Double) {
    DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
      MainActor.assumeIsolated {
        let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
        guard let window = windows.first(where: \.isKeyWindow) ?? windows.first else { return }
        let board = UIView(frame: window.bounds)
        board.backgroundColor = .white
        board.isUserInteractionEnabled = false
        let solid = UIView(frame: CGRect(x: 0, y: 0, width: window.bounds.width, height: window.bounds.height / 2))
        solid.backgroundColor = UIColor(red: 0.1, green: 0.45, blue: 0.8, alpha: 1)
        let wash = UIView(frame: CGRect(x: 0, y: window.bounds.height / 2, width: window.bounds.width, height: window.bounds.height / 2))
        wash.backgroundColor = UIColor(red: 1, green: 0.5, blue: 0.1, alpha: 0.5)
        board.addSubview(solid)
        board.addSubview(wash)
        for (index, top) in [200.0, 300.0, window.bounds.height / 2 + 150, window.bounds.height / 2 + 250].enumerated() {
          let glass = LiquidGlassSurface(frame: CGRect(x: 40, y: top, width: 220, height: 64))
          glass.label = "rimProbe\(index)"
          glass.dark = false
          glass.rimDisabled = index % 2 == 1
          board.addSubview(glass)
        }
        window.addSubview(board)
        NSLog("PAGELAB glass rim probe shown")
      }
    }
  }
}

@MainActor
enum GlassLabReload {
  static func start(after delay: Double) {
    DispatchQueue.main.asyncAfter(deadline: .now() + delay) {
      MainActor.assumeIsolated {
        let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
        guard let web = windows.flatMap(GlassLabScroll.pages).first else { return }
        NSLog("PAGELAB glass reload %@", web.url?.host ?? "-")
        web.reload()
      }
    }
  }
}

