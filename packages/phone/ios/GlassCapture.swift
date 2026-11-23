import ArdiaDesign
import CoreVideo
import Metal
import MetalPerformanceShaders
import QuartzCore
import UIKit
import WebKit

@MainActor
final class GlassCapture {
  private(set) var texture: MTLTexture?
  private(set) var rect: CGRect = .null
  private(set) var generation = 0
  private var signature: Int?
  private var settle = 0
  private var capturedAt: CFTimeInterval = 0
  private var pool: CVPixelBufferPool?
  private var poolSize: (Int, Int) = (0, 0)
  private var output: MTLTexture?
  private(set) var lastMs = 0.0

  func survey(_ source: FrostSourceView) {
    var hasher = Hasher()
    var budget = 4000
    Self.walk(source.layer, into: &hasher, budget: &budget)
    let value = hasher.finalize()
    if value != signature {
      signature = value
      settle = LiquidGlassRules.settleFrames
    }
  }

  func wants(_ wanted: CGRect, now: CFTimeInterval) -> Bool {
    if texture == nil || !rect.contains(wanted) || rect.width > wanted.width * 1.5 + 64 || rect.height > wanted.height * 1.5 + 64 { return true }
    if settle > 0 { return true }
    return now - capturedAt > LiquidGlassRules.idleRefresh
  }

  func capture(_ source: FrostSourceView, rect wanted: CGRect, pixelsPerPoint: CGFloat, sigma: Double, method: GlassLaunch.Capture, into buffer: MTLCommandBuffer, now: CFTimeInterval) -> Bool {
    guard method != .none else { return false }
    let started = CACurrentMediaTime()
    let width = max(Int((wanted.width * pixelsPerPoint / 16).rounded(.up)) * 16, 16)
    let height = max(Int((wanted.height * pixelsPerPoint / 16).rounded(.up)) * 16, 16)
    guard width <= 2048, height <= 2048 else { return false }
    let captured = CGRect(x: wanted.minX, y: wanted.minY, width: CGFloat(width) / pixelsPerPoint, height: CGFloat(height) / pixelsPerPoint)
    guard let pixels = makeBuffer(width: width, height: height) else { return false }
    CVPixelBufferLockBaseAddress(pixels, [])
    guard let context = CGContext(data: CVPixelBufferGetBaseAddress(pixels), width: width, height: height, bitsPerComponent: 8, bytesPerRow: CVPixelBufferGetBytesPerRow(pixels), space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue) else {
      CVPixelBufferUnlockBaseAddress(pixels, [])
      return false
    }
    context.clear(CGRect(x: 0, y: 0, width: width, height: height))
    context.interpolationQuality = .low
    context.translateBy(x: 0, y: CGFloat(height))
    context.scaleBy(x: pixelsPerPoint, y: -pixelsPerPoint)
    context.translateBy(x: -captured.minX, y: -captured.minY)
    switch method {
    case .hierarchy:
      UIGraphicsPushContext(context)
      source.drawHierarchy(in: source.bounds, afterScreenUpdates: false)
      UIGraphicsPopContext()
    case .layer:
      source.layer.render(in: context)
    case .none:
      break
    }
    CVPixelBufferUnlockBaseAddress(pixels, [])
    guard let (input, holder) = GlassMetal.shared.texture(of: pixels) else { return false }
    GlassMetal.shared.flushTextures()
    let blurred = outputTexture(like: input)
    if let blur = GlassMetal.shared.blur(sigma: sigma), let blurred {
      blur.encode(commandBuffer: buffer, sourceTexture: input, destinationTexture: blurred)
      texture = blurred
    } else {
      texture = input
    }
    let held = holder
    buffer.addCompletedHandler { _ in _ = held }
    rect = captured
    generation += 1
    capturedAt = now
    settle = max(settle - 1, 0)
    lastMs = (CACurrentMediaTime() - started) * 1000
    return true
  }

  func forget() {
    texture = nil
    output = nil
    rect = .null
    pool = nil
    signature = nil
  }

  private func makeBuffer(width: Int, height: Int) -> CVPixelBuffer? {
    if pool == nil || poolSize != (width, height) {
      let attributes: [String: Any] = [
        kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
        kCVPixelBufferWidthKey as String: width,
        kCVPixelBufferHeightKey as String: height,
        kCVPixelBufferMetalCompatibilityKey as String: true,
        kCVPixelBufferCGBitmapContextCompatibilityKey as String: true,
        kCVPixelBufferIOSurfacePropertiesKey as String: [:] as [String: Any],
      ]
      var made: CVPixelBufferPool?
      CVPixelBufferPoolCreate(nil, [kCVPixelBufferPoolMinimumBufferCountKey as String: 3] as CFDictionary, attributes as CFDictionary, &made)
      pool = made
      poolSize = (width, height)
      output = nil
    }
    guard let pool else { return nil }
    var buffer: CVPixelBuffer?
    CVPixelBufferPoolCreatePixelBuffer(nil, pool, &buffer)
    return buffer
  }

  private func outputTexture(like input: MTLTexture) -> MTLTexture? {
    if let output, output.width == input.width, output.height == input.height { return output }
    let descriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm, width: input.width, height: input.height, mipmapped: false)
    descriptor.usage = [.shaderRead, .shaderWrite]
    descriptor.storageMode = .private
    output = GlassMetal.shared.device?.makeTexture(descriptor: descriptor)
    return output
  }

  private static func walk(_ layer: CALayer, into hasher: inout Hasher, budget: inout Int) {
    guard budget > 0 else { return }
    budget -= 1
    let shown = layer.presentation() ?? layer
    if shown.isHidden || shown.opacity <= 0 {
      hasher.combine(0)
      return
    }
    hasher.combine(shown.position.x)
    hasher.combine(shown.position.y)
    hasher.combine(shown.bounds.origin.x)
    hasher.combine(shown.bounds.origin.y)
    hasher.combine(shown.bounds.width)
    hasher.combine(shown.bounds.height)
    hasher.combine(shown.opacity)
    let transform = shown.transform
    hasher.combine(transform.m11)
    hasher.combine(transform.m12)
    hasher.combine(transform.m21)
    hasher.combine(transform.m22)
    hasher.combine(transform.m41)
    hasher.combine(transform.m42)
    if let contents = layer.contents { hasher.combine(ObjectIdentifier(contents as AnyObject)) }
    hasher.combine(layer.backgroundColor.map { CFHash($0) } ?? 0)
    if let web = layer.delegate as? WKWebView {
      hasher.combine(web.scrollView.contentOffset.x)
      hasher.combine(web.scrollView.contentOffset.y)
      return
    }
    for sublayer in layer.sublayers ?? [] { walk(sublayer, into: &hasher, budget: &budget) }
  }
}

@MainActor
final class GlassFrames: NSObject {
  static let shared = GlassFrames()

  private let surfaces = NSHashTable<LiquidGlassSurface>.weakObjects()
  private var link: CADisplayLink?
  private var slowTimer: Timer?
  private var captures: [ObjectIdentifier: GlassCapture] = [:]
  private var stats = FrameStats()
  private var lastTimestamp: CFTimeInterval = 0

  func attach(_ surface: LiquidGlassSurface) {
    surfaces.add(surface)
    GlassMetal.shared.prepare()
    schedule()
  }

  func detach(_ surface: LiquidGlassSurface) {
    surfaces.remove(surface)
    schedule()
  }

  func metalChanged() {
    for surface in surfaces.allObjects { surface.metalChanged() }
    schedule()
  }

  func sourcesChanged() {
    for surface in surfaces.allObjects { surface.needsPath() }
    schedule()
  }

  func schedule() {
    let attached = surfaces.allObjects.filter { $0.window != nil }
    let wantsFrames = attached.contains { $0.wantsFrames }
    if wantsFrames, link == nil {
      let made = CADisplayLink(target: self, selector: #selector(frame(_:)))
      made.add(to: .main, forMode: .common)
      link = made
      lastTimestamp = 0
    } else if !wantsFrames, let link {
      link.invalidate()
      self.link = nil
    }
    let wantsSlow = attached.contains { $0.wantsPathChecks }
    if wantsSlow, slowTimer == nil {
      let timer = Timer(timeInterval: LiquidGlassRules.pageCheckInterval, repeats: true) { _ in
        MainActor.assumeIsolated { GlassFrames.shared.checkPaths() }
      }
      RunLoop.main.add(timer, forMode: .common)
      slowTimer = timer
    } else if !wantsSlow, let timer = slowTimer {
      timer.invalidate()
      slowTimer = nil
    }
  }

  private func checkPaths() {
    for surface in surfaces.allObjects where surface.window != nil && surface.wantsPathChecks { surface.needsPath() }
    schedule()
  }

  @objc private func frame(_ link: CADisplayLink) {
    let started = CACurrentMediaTime()
    let now = link.timestamp
    if lastTimestamp > 0 {
      let target = max(link.targetTimestamp - link.timestamp, 1.0 / 120)
      stats.note(interval: now - lastTimestamp, target: target)
    }
    lastTimestamp = now
    let live = surfaces.allObjects.filter { $0.window != nil && $0.wantsFrames }
    guard !live.isEmpty, let queue = GlassMetal.shared.queue, let buffer = queue.makeCommandBuffer() else {
      schedule()
      return
    }
    var bySource: [ObjectIdentifier: (FrostSourceView, [LiquidGlassSurface])] = [:]
    var unsourced: [LiquidGlassSurface] = []
    for surface in live {
      surface.followPresentation()
      if surface.choice.path == .live, let source = surface.foundSource {
        bySource[ObjectIdentifier(source), default: (source, [])].1.append(surface)
      } else {
        unsourced.append(surface)
      }
    }
    for (key, entry) in bySource {
      let (source, everyone) = entry
      let members = everyone.filter(\.isShownOnScreen)
      guard !members.isEmpty else { continue }
      let capture = captures[key] ?? GlassCapture()
      captures[key] = capture
      capture.survey(source)
      var wanted = CGRect.null
      var sigma = 0.0
      var pixelsPerPoint: CGFloat = 1
      for surface in members {
        guard let region = surface.regionInSource(source) else { continue }
        wanted = wanted.union(region.insetBy(dx: -surface.marginPoints, dy: -surface.marginPoints))
        sigma = max(sigma, surface.blurSigma)
        pixelsPerPoint = surface.capturePixelsPerPoint
      }
      wanted = wanted.intersection(source.bounds)
      if !wanted.isNull, !wanted.isEmpty, capture.wants(wanted, now: now) {
        if capture.capture(source, rect: wanted, pixelsPerPoint: pixelsPerPoint, sigma: sigma, method: GlassLaunch.capture, into: buffer, now: now) {
          stats.noteCapture(ms: capture.lastMs)
        }
      }
      for surface in members { surface.draw(with: capture, source: source, into: buffer) }
    }
    for surface in unsourced { surface.draw(with: nil, source: nil, into: buffer) }
    buffer.commit()
    let known = Set(surfaces.allObjects.compactMap { $0.foundSource.map(ObjectIdentifier.init) })
    for key in captures.keys where !known.contains(key) { captures[key] = nil }
    stats.noteTick(ms: (CACurrentMediaTime() - started) * 1000)
    if PhoneTestBuild.isOn, let line = stats.report(now: now, surfaces: live.count) { NSLog("%@", line) }
    schedule()
  }

  struct FrameStats {
    var frames = 0
    var late = 0
    var worstInterval = 0.0
    var captures = 0
    var captureMs = 0.0
    var worstCaptureMs = 0.0
    var tickMs = 0.0
    var worstTickMs = 0.0
    var since: CFTimeInterval = 0

    mutating func note(interval: CFTimeInterval, target: CFTimeInterval) {
      frames += 1
      if interval > target * 1.5 { late += 1 }
      worstInterval = max(worstInterval, interval)
    }

    mutating func noteCapture(ms: Double) {
      captures += 1
      captureMs += ms
      worstCaptureMs = max(worstCaptureMs, ms)
    }

    mutating func noteTick(ms: Double) {
      tickMs += ms
      worstTickMs = max(worstTickMs, ms)
    }

    mutating func report(now: CFTimeInterval, surfaces: Int) -> String? {
      if since == 0 { since = now }
      guard now - since >= 1, frames > 0 else { return nil }
      let line = String(format: "PAGELAB glass frames method=%@ surfaces=%d frames=%d late=%d worst_frame_ms=%.1f captures=%d capture_ms_avg=%.2f capture_ms_max=%.2f tick_ms_avg=%.2f tick_ms_max=%.2f", GlassLaunch.capture.rawValue, surfaces, frames, late, worstInterval * 1000, captures, captures > 0 ? captureMs / Double(captures) : 0, worstCaptureMs, tickMs / Double(frames), worstTickMs)
      self = FrameStats()
      since = now
      return line
    }
  }
}
