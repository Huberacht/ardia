import ArdiaDesign
import CoreVideo
import Metal
import MetalPerformanceShaders
import QuartzCore
import UIKit
import WebKit

@MainActor
final class GlassCapture {
  enum Outcome {
    case captured
    case failed
    case waiting
  }

  private(set) var texture: MTLTexture?
  private(set) var rect: CGRect = .null
  private(set) var generation = 0
  private(set) var failures = 0
  private var retryAt: CFTimeInterval = 0
  private var signature: Int?
  private var settle = 0
  private var capturedAt: CFTimeInterval = 0
  private var pool: CVPixelBufferPool?
  private var poolSize: (Int, Int) = (0, 0)
  private var output: MTLTexture?
  private(set) var lastMs = 0.0
  private var samples: [LiquidGlassRules.CaptureSample] = []
  private var quiet = 0
  let page = GlassPageShot()

  private var warmed: Bool
  private weak var scrollWeb: WKWebView?

  init(warmed: Bool = false) {
    self.warmed = warmed
  }
  private var capturedScroll: CGPoint = .zero

  func follow(_ web: WKWebView?) {
    scrollWeb = web
    capturedScroll = web?.scrollView.contentOffset ?? .zero
  }

  var scrollShift: CGPoint {
    guard let web = scrollWeb else { return .zero }
    return CGPoint(x: web.scrollView.contentOffset.x - capturedScroll.x, y: web.scrollView.contentOffset.y - capturedScroll.y)
  }
  var wholeMethod: GlassLaunch.Capture = .layer

  var strikes = 1

  func overBudget(now: CFTimeInterval, frameMs: Double) -> Bool { LiquidGlassRules.overBudget(samples, now: now, frameMs: frameMs, strikes: strikes) }

  func noteMainThread(ms: Double, now: CFTimeInterval, captured: Bool) {
    samples = LiquidGlassRules.recentSamples(samples, now: now) + [LiquidGlassRules.CaptureSample(at: now, ms: ms, cold: captured && !warmed)]
    if captured { warmed = true }
  }

  var isChanging: Bool { settle > 0 }

  func showFill() {
    guard texture != nil else { return }
    texture = nil
    rect = .null
    generation += 1
  }

  private(set) var signatureValue = 0

  func survey(_ pieces: [GlassLayerPiece], rect wanted: CGRect, shiftable: Bool = true, shallow: Bool = false) {
    var hasher = Hasher()
    var budget = 1500
    let depth = shallow ? LiquidGlassRules.backdropWalkDepth : Int.max
    hasher.combine(wanted.minX.rounded())
    hasher.combine(wanted.minY.rounded())
    hasher.combine(wanted.width.rounded())
    hasher.combine(wanted.height.rounded())
    for piece in pieces {
      for value in [piece.transform.a, piece.transform.b, piece.transform.c, piece.transform.d, piece.transform.tx, piece.transform.ty, piece.alpha] { hasher.combine(value) }
      if let web = piece.page {
        if shiftable {
          hasher.combine(GlassFlowRules.scrollBucket(web.scrollView.contentOffset))
        } else {
          hasher.combine(web.scrollView.contentOffset.x)
          hasher.combine(web.scrollView.contentOffset.y)
        }
        hasher.combine(web.scrollView.zoomScale)
        hasher.combine(page.generation)
      } else if let view = piece.view {
        if let contents = view.layer.contents { hasher.combine(ObjectIdentifier(contents as AnyObject)) }
        for sublayer in view.layer.sublayers ?? [] { Self.walk(sublayer, into: &hasher, budget: &budget, depth: depth) }
      }
    }
    note(hasher.finalize())
  }

  private func note(_ value: Int) {
    signatureValue = value
    if value != signature {
      signature = value
      settle = LiquidGlassRules.settleFrames
      quiet = 0
    } else {
      quiet += 1
    }
  }

  func wants(_ wanted: CGRect, now: CFTimeInterval, gap: TimeInterval = 0) -> Bool {
    if now < retryAt { return false }
    if texture == nil || !rect.contains(wanted) || rect.width > wanted.width * 1.5 + 64 || rect.height > wanted.height * 1.5 + 64 { return true }
    if settle > 0 { return GlassFlowRules.recaptureNow(changed: true, quietFrames: quiet, sinceCapture: now - capturedAt, gap: gap) }
    return now - capturedAt > LiquidGlassRules.idleRefresh
  }

  func capture(rect wanted: CGRect, pixelsPerPoint: CGFloat, sigma: Double, blurs: inout [GlassBlurJob], now: CFTimeInterval, draw: (CGContext) -> Bool) -> Outcome {
    if now < retryAt { return .waiting }
    let started = CACurrentMediaTime()
    let width = max(Int((wanted.width * pixelsPerPoint / 16).rounded(.up)) * 16, 16)
    let height = max(Int((wanted.height * pixelsPerPoint / 16).rounded(.up)) * 16, 16)
    guard width <= 2048, height <= 2048 else { return fail(now) }
    let captured = CGRect(x: wanted.minX, y: wanted.minY, width: CGFloat(width) / pixelsPerPoint, height: CGFloat(height) / pixelsPerPoint)
    guard let pixels = makeBuffer(width: width, height: height) else { return fail(now) }
    CVPixelBufferLockBaseAddress(pixels, [])
    guard let base = CVPixelBufferGetBaseAddress(pixels), let context = CGContext(data: base, width: width, height: height, bitsPerComponent: 8, bytesPerRow: CVPixelBufferGetBytesPerRow(pixels), space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue) else {
      CVPixelBufferUnlockBaseAddress(pixels, [])
      return fail(now)
    }
    context.clear(CGRect(x: 0, y: 0, width: width, height: height))
    context.interpolationQuality = .low
    context.translateBy(x: 0, y: CGFloat(height))
    context.scaleBy(x: pixelsPerPoint, y: -pixelsPerPoint)
    context.translateBy(x: -captured.minX, y: -captured.minY)
    UIGraphicsPushContext(context)
    let drew = draw(context)
    UIGraphicsPopContext()
    let inked = drew && Self.hasInk(base, bytesPerRow: CVPixelBufferGetBytesPerRow(pixels), width: width, height: height)
    CVPixelBufferUnlockBaseAddress(pixels, [])
    guard inked, let (input, holder) = GlassMetal.shared.texture(of: pixels), let blurred = outputTexture(like: input), let blur = GlassMetal.shared.blur(sigma: sigma) else { return fail(now) }
    GlassMetal.shared.flushTextures()
    blurs.append(GlassBlurJob(kernel: blur, source: input, target: blurred, holder: holder))
    texture = blurred
    rect = captured
    generation += 1
    failures = 0
    retryAt = 0
    capturedAt = now
    settle = max(settle - 1, 0)
    lastMs = (CACurrentMediaTime() - started) * 1000
    return .captured
  }

  func release() {
    page.release()
    texture = nil
    output = nil
    rect = .null
    pool = nil
    poolSize = (0, 0)
    signature = nil
    generation += 1
  }

  private func fail(_ now: CFTimeInterval) -> Outcome {
    failures += 1
    retryAt = now + LiquidGlassRules.captureRetryDelay(failures: failures)
    texture = nil
    rect = .null
    generation += 1
    return .failed
  }

  static func draw(_ view: UIView, method: GlassLaunch.Capture, context: CGContext) -> Bool {
    switch method {
    case .hierarchy:
      return view.drawHierarchy(in: view.bounds, afterScreenUpdates: false)
    case .layer, .auto:
      view.layer.render(in: context)
      return true
    case .none:
      return false
    }
  }

  private static func hasInk(_ base: UnsafeMutableRawPointer, bytesPerRow: Int, width: Int, height: Int) -> Bool {
    for row in stride(from: 0, to: height, by: 2) {
      let line = base.advanced(by: row * bytesPerRow)
      for column in stride(from: 0, to: width, by: 2) where line.load(fromByteOffset: column * 4 + 3, as: UInt8.self) > 0 { return true }
    }
    return false
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
    guard CVPixelBufferPoolCreatePixelBuffer(nil, pool, &buffer) == kCVReturnSuccess else { return nil }
    return buffer
  }

  private func outputTexture(like input: MTLTexture) -> MTLTexture? {
    if let output, output.width == input.width, output.height == input.height { return output }
    output = nil
    let descriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm, width: input.width, height: input.height, mipmapped: false)
    descriptor.usage = [.shaderRead, .shaderWrite]
    descriptor.storageMode = .private
    output = GlassMetal.shared.device?.makeTexture(descriptor: descriptor)
    return output
  }

  private static func walk(_ layer: CALayer, into hasher: inout Hasher, budget: inout Int, depth: Int) {
    guard budget > 0, depth > 0 else { return }
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
    hasher.combine(shown.zPosition)
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
    for sublayer in layer.sublayers ?? [] { walk(sublayer, into: &hasher, budget: &budget, depth: depth - 1) }
  }
}
