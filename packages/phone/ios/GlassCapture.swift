import ArdiaDesign
import CoreVideo
import Metal
import MetalPerformanceShaders
import QuartzCore
import UIKit
import WebKit

struct GlassClip {
  let transform: CGAffineTransform
  let bounds: CGRect
  let radius: CGFloat

  var path: CGPath {
    var transform = transform
    let radius = min(self.radius, min(bounds.width, bounds.height) / 2)
    return CGPath(roundedRect: bounds, cornerWidth: radius, cornerHeight: radius, transform: &transform)
  }

  var solidRect: CGRect {
    let scaled = radius * max(abs(transform.a), abs(transform.d))
    return bounds.applying(transform).insetBy(dx: scaled, dy: scaled)
  }
}

struct GlassLayerPiece {
  let view: UIView?
  let transform: CGAffineTransform
  let bounds: CGRect
  let radius: CGFloat
  let fill: CGColor?
  let alpha: CGFloat
  let clips: [GlassClip]

  var axisAligned: Bool { transform.b == 0 && transform.c == 0 }

  var coverage: GlassStacking.Coverage {
    let opaque = alpha >= 1 && (fill?.alpha ?? 0) >= 1
    return GlassStacking.Coverage(rect: bounds.applying(transform), radius: radius * max(abs(transform.a), abs(transform.d)), axisAligned: axisAligned, opaque: opaque, clips: clips.map(\.solidRect))
  }
}

@MainActor
enum GlassBackdrop {
  static func space(for surface: LiquidGlassSurface) -> UIView? {
    switch surface.backdropMode {
    case .source: surface.backdropSource
    case .beneath: surface.backdropRoot
    case nil: nil
    }
  }

  static func pieces(under glass: UIView, root: UIView, covering wanted: CGRect) -> [GlassLayerPiece] {
    var chain: [UIView] = []
    var current: UIView? = glass
    while let view = current {
      chain.append(view)
      if view === root { break }
      current = view.superview
    }
    guard chain.last === root, chain.count > 1 else { return [] }
    let usesPresentation = chain.allSatisfy { $0.layer.presentation() != nil }
    func shown(_ view: UIView) -> CALayer? { usesPresentation ? view.layer.presentation() : view.layer }
    guard let rootLayer = shown(root) else { return [] }
    var pieces: [GlassLayerPiece] = []
    var clips: [GlassClip] = []
    var alpha: CGFloat = 1
    for level in stride(from: chain.count - 1, to: 0, by: -1) {
      let parent = chain[level]
      let child = chain[level - 1]
      guard let parentLayer = shown(parent), !parentLayer.isHidden else { return [] }
      alpha *= CGFloat(parentLayer.opacity)
      let parentTransform = transform(of: parentLayer, to: rootLayer)
      if let fill = parentLayer.backgroundColor, fill.alpha > 0 {
        pieces.append(GlassLayerPiece(view: nil, transform: parentTransform, bounds: parentLayer.bounds, radius: parentLayer.cornerRadius, fill: fill, alpha: alpha, clips: clips))
      }
      if parentLayer.masksToBounds {
        clips.append(GlassClip(transform: parentTransform, bounds: parentLayer.bounds, radius: parentLayer.cornerRadius))
      }
      let subviews = parent.subviews
      guard let childIndex = subviews.firstIndex(where: { $0 === child }) else { return [] }
      let siblings = subviews.enumerated().map { GlassStacking.Sibling(index: $0.offset, zPosition: Double((shown($0.element) ?? $0.element.layer).zPosition)) }
      let visible = clips.reduce(rootLayer.bounds) { $0.intersection($1.bounds.applying($1.transform)) }
      for index in GlassStacking.below(siblings[childIndex], among: siblings) {
        let sibling = subviews[index]
        guard !sibling.isHidden, let layer = usesPresentation ? sibling.layer.presentation() : sibling.layer else { continue }
        guard !layer.isHidden, layer.opacity > 0.01, layer.bounds.width > 0, layer.bounds.height > 0 else { continue }
        let siblingTransform = transform(of: layer, to: rootLayer)
        let area = layer.bounds.applying(siblingTransform).intersection(visible)
        guard !area.isNull, area.intersects(wanted) else { continue }
        pieces.append(GlassLayerPiece(view: sibling, transform: siblingTransform, bounds: layer.bounds, radius: layer.cornerRadius, fill: layer.backgroundColor, alpha: alpha * CGFloat(layer.opacity), clips: clips))
      }
    }
    if let floor = GlassStacking.opaqueFloor(pieces.map(\.coverage), covering: wanted) { pieces.removeFirst(floor) }
    return pieces
  }

  static func transform(of layer: CALayer, to root: CALayer) -> CGAffineTransform {
    let origin = layer.convert(CGPoint.zero, to: root)
    let across = layer.convert(CGPoint(x: 1, y: 0), to: root)
    let down = layer.convert(CGPoint(x: 0, y: 1), to: root)
    return CGAffineTransform(a: across.x - origin.x, b: across.y - origin.y, c: down.x - origin.x, d: down.y - origin.y, tx: origin.x, ty: origin.y)
  }

  static func draw(_ piece: GlassLayerPiece, method: GlassLaunch.Capture, in context: CGContext) -> Bool {
    context.saveGState()
    defer { context.restoreGState() }
    for clip in piece.clips {
      context.addPath(clip.path)
      context.clip()
    }
    context.concatenate(piece.transform)
    guard let view = piece.view else {
      guard let fill = piece.fill else { return true }
      let radius = min(piece.radius, min(piece.bounds.width, piece.bounds.height) / 2)
      context.setAlpha(piece.alpha)
      context.setFillColor(fill)
      context.addPath(CGPath(roundedRect: piece.bounds, cornerWidth: radius, cornerHeight: radius, transform: nil))
      context.fillPath()
      return true
    }
    let alpha = piece.alpha / (GlassProbe.appliesOwnAlpha(method) ? max(CGFloat(view.layer.opacity), 0.01) : 1)
    let layered = alpha < 1
    if layered {
      context.setAlpha(alpha)
      context.beginTransparencyLayer(auxiliaryInfo: nil)
    }
    defer { if layered { context.endTransparencyLayer() } }
    return GlassCapture.draw(view, method: method, context: context)
  }
}

@MainActor
enum GlassProbe {
  private static var ownAlpha: [GlassLaunch.Capture: Bool] = [.hierarchy: true, .layer: true, .auto: true]

  static func appliesOwnAlpha(_ method: GlassLaunch.Capture) -> Bool { ownAlpha[method] ?? false }

  static func run(in window: UIWindow) {
    let probe = UIView(frame: CGRect(x: 0, y: 0, width: 8, height: 8))
    probe.backgroundColor = .red
    probe.alpha = 0.5
    probe.isUserInteractionEnabled = false
    window.addSubview(probe)
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
      MainActor.assumeIsolated {
        var line = "PAGELAB glass probe"
        for method in [GlassLaunch.Capture.hierarchy, .layer] {
          let context = CGContext(data: nil, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)!
          context.translateBy(x: 0, y: 1)
          context.scaleBy(x: 1 / 8, y: -1 / 8)
          UIGraphicsPushContext(context)
          let drew = GlassCapture.draw(probe, method: method, context: context)
          UIGraphicsPopContext()
          let alpha = context.data.map { Double($0.load(fromByteOffset: 3, as: UInt8.self)) / 255 } ?? -1
          line += String(format: " %@: drew=%@ own_alpha_pixel=%.2f", method.rawValue, drew ? "yes" : "no", alpha)
        }
        probe.removeFromSuperview()
        NSLog("%@", line)
      }
    }
  }
}

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
  let page = GlassPageShot()

  func overBudget(now: CFTimeInterval) -> Bool { LiquidGlassRules.overBudget(samples, now: now) }

  private(set) var signatureValue = 0

  func survey(_ pieces: [GlassLayerPiece], rect wanted: CGRect) {
    var hasher = Hasher()
    var budget = 4000
    hasher.combine(wanted.minX.rounded())
    hasher.combine(wanted.minY.rounded())
    hasher.combine(wanted.width.rounded())
    hasher.combine(wanted.height.rounded())
    for piece in pieces {
      for value in [piece.transform.a, piece.transform.b, piece.transform.c, piece.transform.d, piece.transform.tx, piece.transform.ty, piece.alpha] { hasher.combine(value) }
      if let view = piece.view {
        if let contents = view.layer.contents { hasher.combine(ObjectIdentifier(contents as AnyObject)) }
        for sublayer in view.layer.sublayers ?? [] { Self.walk(sublayer, into: &hasher, budget: &budget) }
      }
    }
    let value = hasher.finalize()
    signatureValue = value
    if value != signature {
      signature = value
      settle = LiquidGlassRules.settleFrames
    }
  }

  var isIdle: Bool { settle == 0 }

  func wants(_ wanted: CGRect, now: CFTimeInterval, gap: TimeInterval = 0) -> Bool {
    if now < retryAt { return false }
    if texture == nil || !rect.contains(wanted) || rect.width > wanted.width * 1.5 + 64 || rect.height > wanted.height * 1.5 + 64 { return true }
    if settle > 0 { return now - capturedAt >= gap }
    return now - capturedAt > LiquidGlassRules.idleRefresh
  }

  func capture(rect wanted: CGRect, pixelsPerPoint: CGFloat, sigma: Double, into buffer: MTLCommandBuffer, now: CFTimeInterval, draw: (CGContext) -> Bool) -> Outcome {
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
    blur.encode(commandBuffer: buffer, sourceTexture: input, destinationTexture: blurred)
    let held = holder
    buffer.addCompletedHandler { _ in _ = held }
    texture = blurred
    rect = captured
    generation += 1
    failures = 0
    retryAt = 0
    capturedAt = now
    settle = max(settle - 1, 0)
    lastMs = (CACurrentMediaTime() - started) * 1000
    samples = LiquidGlassRules.recentSamples(samples, now: now) + [LiquidGlassRules.CaptureSample(at: now, ms: lastMs)]
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
    for sublayer in layer.sublayers ?? [] { walk(sublayer, into: &hasher, budget: &budget) }
  }
}

@MainActor
final class GlassPageShot {
  static let reach: CGFloat = 320

  private(set) var image: CGImage?
  private var rect: CGRect = .null
  private var offset: CGPoint = .zero
  private var zoom: CGFloat = 1
  private var pending = false
  private var requestedSignature: Int?
  private var requestedAt: CFTimeInterval = 0
  private(set) var latencies: [Double] = []

  func request(_ web: WKWebView, pixelsPerPoint: CGFloat, signature: Int, now: CFTimeInterval) {
    guard !pending else { return }
    guard image == nil || signature != requestedSignature || now - requestedAt > LiquidGlassRules.idleRefresh else { return }
    pending = true
    requestedSignature = signature
    requestedAt = now
    let rect = web.bounds.insetBy(dx: 0, dy: -Self.reach)
    let configuration = WKSnapshotConfiguration()
    configuration.rect = rect
    configuration.afterScreenUpdates = false
    configuration.snapshotWidth = NSNumber(value: Double(rect.width * pixelsPerPoint / max(web.traitCollection.displayScale, 1)))
    let offset = web.scrollView.contentOffset
    let zoom = web.scrollView.zoomScale
    let started = CACurrentMediaTime()
    web.takeSnapshot(with: configuration) { [weak self] image, _ in
      MainActor.assumeIsolated {
        guard let self else { return }
        self.pending = false
        guard let picture = image?.cgImage else { return }
        self.image = picture
        self.rect = rect
        self.offset = offset
        self.zoom = zoom
        if PhoneTestBuild.isOn { self.latencies.append((CACurrentMediaTime() - started) * 1000) }
      }
    }
  }

  func takeLatencies() -> [Double] {
    defer { latencies.removeAll() }
    return latencies
  }

  func draw(_ web: WKWebView, transform: CGAffineTransform, in context: CGContext) -> Bool {
    guard let image, web.scrollView.zoomScale == zoom else { return false }
    let shift = CGPoint(x: web.scrollView.contentOffset.x - offset.x, y: web.scrollView.contentOffset.y - offset.y)
    context.saveGState()
    defer { context.restoreGState() }
    context.concatenate(transform)
    context.setFillColor((web.underPageBackgroundColor ?? .white).resolvedColor(with: web.traitCollection).cgColor)
    context.fill(web.bounds)
    UIImage(cgImage: image).draw(in: rect.offsetBy(dx: -shift.x, dy: -shift.y))
    return true
  }

  func release() {
    image = nil
    rect = .null
    requestedSignature = nil
  }
}

