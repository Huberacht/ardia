import ArdiaDesign
import QuartzCore
import UIKit
import WebKit

@MainActor
final class GlassPageShot {
  static let reach: CGFloat = 320

  private var gate = GlassSnapshotGate()
  private weak var web: WKWebView?
  private(set) var image: CGImage?
  private(set) var generation = 0
  private var rect: CGRect = .null
  private var offset: CGPoint = .zero
  private var zoom: CGFloat = 1
  private var pending = false
  private(set) var latencies: [Double] = []
  private(set) var rejected = 0
  private(set) var uncovered = 0

  static func key(of web: WKWebView) -> GlassPageKey {
    GlassPageKey(page: ObjectIdentifier(web).hashValue, navigation: PhonePages.shared.navigationGeneration(of: web) ?? 0)
  }

  @discardableResult
  func observe(_ web: WKWebView) -> Bool {
    let key = Self.key(of: web)
    let changed = gate.observe(key) || self.web !== web
    guard changed else {
      if image != nil, web.scrollView.zoomScale != zoom { forgetImage() }
      return false
    }
    self.web = web
    pending = false
    forgetImage()
    return true
  }

  func request(_ web: WKWebView, pixelsPerPoint: CGFloat, changed: Bool, now: CFTimeInterval) {
    guard gate.mayRequest(now: now, changed: changed || image == nil, pending: pending), let key = gate.key else { return }
    let token = gate.begin(now: now)
    pending = true
    let rect = web.bounds.insetBy(dx: 0, dy: -Self.reach)
    let configuration = WKSnapshotConfiguration()
    configuration.rect = rect
    configuration.afterScreenUpdates = true
    configuration.snapshotWidth = NSNumber(value: Double(rect.width * pixelsPerPoint / max(web.traitCollection.displayScale, 1)))
    let offset = web.scrollView.contentOffset
    let zoom = web.scrollView.zoomScale
    let started = CACurrentMediaTime()
    web.takeSnapshot(with: configuration) { [weak self, weak web] image, _ in
      MainActor.assumeIsolated {
        guard let self else { return }
        guard let web, self.web === web, self.gate.accepts(token: token, key: key), Self.key(of: web) == key else {
          self.rejected += 1
          return
        }
        self.pending = false
        let finished = CACurrentMediaTime()
        guard let picture = image?.cgImage, Self.hasInk(picture), web.scrollView.zoomScale == zoom else {
          self.forgetImage()
          self.gate.failed(now: finished)
          return
        }
        self.gate.succeeded()
        self.image = picture
        self.generation += 1
        self.rect = rect
        self.offset = offset
        self.zoom = zoom
        if PhoneTestBuild.isOn { self.latencies.append((finished - started) * 1000) }
      }
    }
  }

  func covers(_ needed: CGRect, of web: WKWebView) -> Bool {
    guard image != nil, self.web === web, gate.key == Self.key(of: web), web.scrollView.zoomScale == zoom else { return false }
    let shift = CGPoint(x: web.scrollView.contentOffset.x - offset.x, y: web.scrollView.contentOffset.y - offset.y)
    let covered = GlassFlowRules.snapshotCovers(image: rect, shift: shift, needed: needed.intersection(web.bounds))
    if !covered { uncovered += 1 }
    return covered
  }

  func draw(_ web: WKWebView, transform: CGAffineTransform, in context: CGContext) -> Bool {
    guard let image, self.web === web, web.scrollView.zoomScale == zoom else { return false }
    let shift = CGPoint(x: web.scrollView.contentOffset.x - offset.x, y: web.scrollView.contentOffset.y - offset.y)
    context.saveGState()
    defer { context.restoreGState() }
    context.concatenate(transform)
    UIImage(cgImage: image).draw(in: rect.offsetBy(dx: -shift.x, dy: -shift.y))
    return true
  }

  func takeLatencies() -> [Double] {
    defer { latencies.removeAll() }
    return latencies
  }

  func takeCounts() -> (rejected: Int, uncovered: Int) {
    defer {
      rejected = 0
      uncovered = 0
    }
    return (rejected, uncovered)
  }

  func release() {
    forgetImage()
    pending = false
    web = nil
    gate = GlassSnapshotGate()
  }

  private func forgetImage() {
    guard image != nil else { return }
    image = nil
    rect = .null
    generation += 1
  }

  private static func hasInk(_ image: CGImage) -> Bool {
    let side = 16
    guard let context = CGContext(data: nil, width: side, height: side, bitsPerComponent: 8, bytesPerRow: side * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue) else { return false }
    context.interpolationQuality = .low
    context.draw(image, in: CGRect(x: 0, y: 0, width: side, height: side))
    guard let data = context.data else { return false }
    for index in 0..<(side * side) where data.load(fromByteOffset: index * 4 + 3, as: UInt8.self) > 0 { return true }
    return false
  }
}
