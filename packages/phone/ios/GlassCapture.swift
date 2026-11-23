import ArdiaDesign
import CoreVideo
import Metal
import MetalPerformanceShaders
import QuartzCore
import UIKit
import WebKit

struct GlassLayerPiece {
  let view: UIView?
  let rect: CGRect
  let fill: CGColor?
}

@MainActor
enum GlassBackdrop {
  static func space(for surface: LiquidGlassSurface) -> UIView? {
    switch surface.backdrop {
    case .source(let source): source
    case .beneath(let root): root
    case nil: nil
    }
  }

  static func pieces(under glass: UIView, root: UIView, covering wanted: CGRect) -> [GlassLayerPiece] {
    var chain: [(parent: UIView, child: UIView)] = []
    var child = glass
    while let parent = child.superview {
      chain.append((parent, child))
      if parent === root { break }
      child = parent
    }
    guard chain.last?.parent === root else { return [] }
    var pieces: [GlassLayerPiece] = []
    for (parent, child) in chain.reversed() {
      if let fill = shownFill(of: parent), let rect = rect(of: parent, in: root) { pieces.append(GlassLayerPiece(view: nil, rect: rect, fill: fill)) }
      for sibling in parent.subviews {
        if sibling === child { break }
        guard isShown(sibling), let rect = rect(of: sibling, in: root), rect.intersects(wanted) else { continue }
        pieces.append(GlassLayerPiece(view: sibling, rect: rect, fill: nil))
      }
    }
    if let floor = pieces.lastIndex(where: { covers($0, wanted) }) { pieces.removeFirst(floor) }
    return pieces
  }

  private static func covers(_ piece: GlassLayerPiece, _ wanted: CGRect) -> Bool {
    guard piece.rect.contains(wanted) else { return false }
    if let fill = piece.fill { return fill.alpha >= 1 }
    guard let view = piece.view, let fill = shownFill(of: view), fill.alpha >= 1 else { return false }
    let shown = view.layer.presentation() ?? view.layer
    return shown.opacity >= 1 && shown.cornerRadius == 0 && CATransform3DIsIdentity(shown.transform)
  }

  private static func shownFill(of view: UIView) -> CGColor? {
    guard let color = (view.layer.presentation() ?? view.layer).backgroundColor, color.alpha > 0 else { return nil }
    return color
  }

  private static func isShown(_ view: UIView) -> Bool {
    let shown = view.layer.presentation() ?? view.layer
    return !view.isHidden && !shown.isHidden && shown.opacity > 0.01 && view.bounds.width > 0 && view.bounds.height > 0
  }

  static func rect(of view: UIView, in root: UIView) -> CGRect? {
    let region: CGRect
    if let mine = view.layer.presentation(), let theirs = root.layer.presentation() {
      region = mine.convert(mine.bounds, to: theirs)
    } else {
      region = view.convert(view.bounds, to: root)
    }
    return region.isNull || region.isEmpty ? nil : region
  }
}

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
  private var recentMs: [Double] = []

  var overBudget: Bool {
    recentMs.count >= LiquidGlassRules.budgetSamples && LiquidGlassRules.overBudget(captureMs: recentMs)
  }

  func survey(_ layers: [CALayer], rect wanted: CGRect) {
    var hasher = Hasher()
    var budget = 4000
    hasher.combine(wanted.minX.rounded())
    hasher.combine(wanted.minY.rounded())
    for layer in layers { Self.walk(layer, into: &hasher, budget: &budget) }
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

  func capture(rect wanted: CGRect, pixelsPerPoint: CGFloat, sigma: Double, method: GlassLaunch.Capture, into buffer: MTLCommandBuffer, now: CFTimeInterval, draw: (CGContext) -> Void) -> Bool {
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
    UIGraphicsPushContext(context)
    draw(context)
    UIGraphicsPopContext()
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
    recentMs.append(lastMs)
    if recentMs.count > LiquidGlassRules.budgetSamples { recentMs.removeFirst(recentMs.count - LiquidGlassRules.budgetSamples) }
    return true
  }

  static func draw(_ view: UIView, in rect: CGRect, method: GlassLaunch.Capture, context: CGContext) {
    switch method {
    case .hierarchy:
      view.drawHierarchy(in: rect, afterScreenUpdates: false)
    case .layer:
      context.saveGState()
      context.translateBy(x: rect.minX, y: rect.minY)
      context.scaleBy(x: rect.width / max(view.bounds.width, 1), y: rect.height / max(view.bounds.height, 1))
      context.translateBy(x: -view.bounds.minX, y: -view.bounds.minY)
      view.layer.render(in: context)
      context.restoreGState()
    case .none:
      break
    }
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
