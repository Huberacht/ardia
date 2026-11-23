import ArdiaDesign
import QuartzCore
import UIKit
import WebKit

@MainActor
final class GlassPageShot {
  private var gate = GlassSnapshotGate()
  private weak var web: WKWebView?
  private(set) var image: CGImage?
  private(set) var generation = 0
  private var rect: CGRect = .null
  private var offset: CGPoint = .zero
  private var zoom: CGFloat = 1
  private var takenAt: CFTimeInterval = 0
  private var pending = false
  private var movedWhilePending = false
  private var requestedOffset: CGPoint = .zero
  private var lastOffset: CGPoint?
  private var stillFrames = 0
  private(set) var latencies: [Double] = []
  private(set) var rejected = 0
  private(set) var uncovered = 0
  var onMainWork: ((Double) -> Void)?

  static func key(of web: WKWebView) -> (key: GlassPageKey, committed: Bool) {
    let document = PhonePages.shared.document(of: web)
    return (GlassPageKey(page: ObjectIdentifier(web).hashValue, navigation: document?.navigation ?? 0, committed: document?.committed ?? 0), document?.settled ?? true)
  }

  var isMoving: Bool { stillFrames < GlassFlowRules.stillFramesForSnapshot }

  @discardableResult
  func observe(_ web: WKWebView) -> Bool {
    let offset = web.scrollView.contentOffset
    if offset == lastOffset { stillFrames += 1 } else { stillFrames = 0 }
    lastOffset = offset
    if pending, offset != requestedOffset { movedWhilePending = true }
    let key = Self.key(of: web).key
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

  func request(_ web: WKWebView, around needed: CGRect, pixelsPerPoint: CGFloat, now: CFTimeInterval) {
    let (key, committed) = Self.key(of: web)
    let distance = image == nil ? .infinity : max(abs(web.scrollView.contentOffset.y - offset.y), abs(web.scrollView.contentOffset.x - offset.x))
    let ask = GlassSnapshotAsk(hasImage: image != nil, pending: pending, stillFrames: stillFrames, distance: distance, age: now - takenAt, committed: committed)
    guard gate.mayRequest(now: now, ask), key == gate.key else { return }
    let token = gate.begin(now: now)
    pending = true
    movedWhilePending = false
    let bounded = needed.intersection(web.bounds)
    let rect = GlassFlowRules.snapshotRect(around: bounded.isNull ? web.bounds : bounded)
    let configuration = WKSnapshotConfiguration()
    configuration.rect = rect
    configuration.afterScreenUpdates = GlassLaunch.snapshotAfterUpdates
    configuration.snapshotWidth = NSNumber(value: Double(rect.width * pixelsPerPoint / max(web.traitCollection.displayScale, 1)))
    let offset = web.scrollView.contentOffset
    requestedOffset = offset
    let zoom = web.scrollView.zoomScale
    let started = CACurrentMediaTime()
    web.takeSnapshot(with: configuration) { [weak self, weak web] image, _ in
      MainActor.assumeIsolated {
        let working = CACurrentMediaTime()
        guard let self else { return }
        defer { self.onMainWork?((CACurrentMediaTime() - working) * 1000) }
        guard let web, self.web === web, self.gate.accepts(token: token, key: key), Self.key(of: web).key == key else {
          self.rejected += 1
          return
        }
        self.pending = false
        let accepted = GlassFlowRules.acceptsSnapshot(requested: offset, now: web.scrollView.contentOffset, movedWhilePending: self.movedWhilePending, zoomRequested: zoom, zoomNow: web.scrollView.zoomScale)
        guard accepted else {
          self.rejected += 1
          return
        }
        guard let picture = image?.cgImage, Self.usable(picture, under: web) else {
          self.forgetImage()
          self.gate.failed(now: working)
          return
        }
        self.gate.succeeded()
        self.image = picture
        self.generation += 1
        self.rect = rect
        self.offset = offset
        self.zoom = zoom
        self.takenAt = working
        if PhoneTestBuild.isOn { self.latencies.append((working - started) * 1000) }
      }
    }
  }

  func covers(_ needed: CGRect, of web: WKWebView) -> Bool {
    guard image != nil, self.web === web, gate.key == Self.key(of: web).key, web.scrollView.zoomScale == zoom else { return false }
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
    context.clip(to: web.bounds)
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
    lastOffset = nil
    stillFrames = 0
    gate = GlassSnapshotGate()
  }

  private func forgetImage() {
    guard image != nil else { return }
    image = nil
    rect = .null
    generation += 1
  }

  private static func usable(_ image: CGImage, under web: WKWebView) -> Bool {
    let side = 16
    guard let context = CGContext(data: nil, width: side, height: side, bitsPerComponent: 8, bytesPerRow: side * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue), let data = context.data else { return false }
    context.interpolationQuality = .low
    context.draw(image, in: CGRect(x: 0, y: 0, width: side, height: side))
    var samples: [[Double]] = []
    var inked = false
    for index in 0..<(side * side) {
      let blue = Double(data.load(fromByteOffset: index * 4, as: UInt8.self)) / 255
      let green = Double(data.load(fromByteOffset: index * 4 + 1, as: UInt8.self)) / 255
      let red = Double(data.load(fromByteOffset: index * 4 + 2, as: UInt8.self)) / 255
      let alpha = Double(data.load(fromByteOffset: index * 4 + 3, as: UInt8.self)) / 255
      if alpha > 0 { inked = true }
      samples.append([red, green, blue, alpha])
    }
    guard inked else { return false }
    guard let flat = GlassFlowRules.uniform(samples) else { return true }
    return GlassFlowRules.acceptsUniform(flat, background: background(of: web))
  }

  private static func background(of web: WKWebView) -> [Double]? {
    let color = (web.underPageBackgroundColor ?? web.backgroundColor ?? .white).resolvedColor(with: web.traitCollection)
    var red: CGFloat = 0
    var green: CGFloat = 0
    var blue: CGFloat = 0
    var alpha: CGFloat = 0
    guard color.getRed(&red, green: &green, blue: &blue, alpha: &alpha) else { return nil }
    return [Double(red * alpha), Double(green * alpha), Double(blue * alpha), Double(alpha)]
  }
}

extension PhonePages {
  func document(of webView: WKWebView) -> (navigation: Int, committed: Int, settled: Bool)? {
    guard let tab = pageIDList.lazy.compactMap({ self.page($0) }).first(where: { $0.webView === webView }) else { return nil }
    return (tab.navigationGeneration, tab.committedDocuments, tab.hasCommittedLoad)
  }
}
