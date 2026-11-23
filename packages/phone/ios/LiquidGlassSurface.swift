import ArdiaDesign
import Metal
import QuartzCore
import UIKit

final class LiquidGlassSurface: UIView {
  var source: String? { didSet { if source != oldValue { needsPath() } } }
  var capsule = true { didSet { if capsule != oldValue { setNeedsLayout() } } }
  var cornerRadius: CGFloat = 0 { didSet { if cornerRadius != oldValue { setNeedsLayout() } } }
  var dark: Bool? { didSet { if dark != oldValue { invalidate() } } }
  var tint: UIColor? { didSet { if !Self.same(tint, oldValue) { invalidate() } } }
  var solidFill: UIColor? { didSet { if !Self.same(solidFill, oldValue) { invalidate() } } }
  var classic = false { didSet { if classic != oldValue { needsPath() } } }
  var presentedRadius: (() -> CGFloat?)?
  var followsPresentation = false
  var label: String = "-"

  private let fillLayer = CALayer()
  private let lensLayer = CAMetalLayer()
  private let bound = LiquidGlassSurfaceBound()
  enum Backdrop {
    case source(FrostSourceView)
    case beneath(UIView)
  }

  private(set) var choice = LiquidGlassRules.choose(classic: false, metal: false, flat: false, lensFailed: false, rimFailed: false, holdsPage: false)
  private(set) var backdrop: Backdrop?
  private var drawnUniforms: [Float]?
  private var drawnGeneration = -1
  private var drawnSize: CGSize = .zero
  private var reportedPath: String?
  private var batching = 0
  private var batchedPath = false
  private var batchedInvalidate = false
  private var laidOut: (size: CGSize, scale: CGFloat)?

  override init(frame: CGRect) {
    super.init(frame: frame)
    isUserInteractionEnabled = false
    isAccessibilityElement = false
    backgroundColor = .clear
    fillLayer.cornerCurve = .circular
    lensLayer.pixelFormat = .bgra8Unorm
    lensLayer.framebufferOnly = true
    lensLayer.isOpaque = false
    lensLayer.allowsNextDrawableTimeout = true
    lensLayer.colorspace = CGColorSpace(name: CGColorSpace.sRGB)
    layer.addSublayer(fillLayer)
    layer.addSublayer(lensLayer)
    registerForTraitChanges([UITraitUserInterfaceStyle.self]) { (view: LiquidGlassSurface, _: UITraitCollection) in view.invalidate() }
  }

  required init?(coder: NSCoder) { nil }

  override func didMoveToWindow() {
    super.didMoveToWindow()
    if window != nil {
      GlassFrames.shared.attach(self)
      laidOut = nil
      layoutLayers(size: bounds.size)
      needsPath()
    } else {
      GlassFrames.shared.detach(self)
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    layoutLayers(size: bounds.size)
  }

  func batch(_ changes: () -> Void) {
    batching += 1
    changes()
    batching -= 1
    guard batching == 0 else { return }
    if batchedPath {
      batchedPath = false
      batchedInvalidate = false
      needsPath(force: true)
    } else if batchedInvalidate {
      batchedInvalidate = false
      invalidate()
    }
  }

  var wantsFrames: Bool {
    guard window != nil, !classic, GlassMetal.shared.isReady else { return false }
    if choice.path == .live { return isShownOnScreen }
    return followsPresentation && (hasRunningAnimations || lensLayer.bounds.size != bounds.size)
  }

  var wantsPathChecks: Bool { window != nil && !classic && !wantsFrames }

  var captureKey: ObjectIdentifier? {
    switch backdrop {
    case .source(let source): ObjectIdentifier(source)
    case .beneath: ObjectIdentifier(self)
    case nil: nil
    }
  }

  var isShownOnScreen: Bool {
    guard window != nil else { return false }
    var view: UIView? = self
    while let current = view {
      if current.isHidden || current.alpha <= 0.01 { return false }
      view = current.superview
    }
    return true
  }

  private var hasRunningAnimations: Bool {
    var view: UIView? = self
    var depth = 0
    while let current = view, depth < 3 {
      if !(current.layer.animationKeys() ?? []).isEmpty { return true }
      view = current.superview
      depth += 1
    }
    return false
  }

  private var isDark: Bool { dark ?? (traitCollection.userInterfaceStyle == .dark) }

  private var scale: CGFloat { window?.screen.scale ?? traitCollection.displayScale }

  private var blurPixels: Double { GlassFrostStyle.glass.blur * Double(max(scale, 1)) }

  var capturePixelsPerPoint: CGFloat { scale / CGFloat(LiquidGlassRules.frostScale(blurPixels: blurPixels)) }

  var blurSigma: Double { LiquidGlassRules.blurSigma(radius: blurPixels / LiquidGlassRules.frostScale(blurPixels: blurPixels)) }

  var marginPoints: CGFloat {
    let shift = bound.measure(lensLayer.bounds.size).shift
    return CGFloat(LiquidGlassRules.marginPixels(blurPixels: blurPixels, shiftPixels: shift * Double(scale))) / max(scale, 1)
  }

  func needsPath(force: Bool = false) {
    if batching > 0 {
      batchedPath = true
      return
    }
    let metal = GlassMetal.shared
    let found = GlassSources.find(source)
    let inside = found.map { isDescendant(of: $0) } ?? false
    switch LiquidGlassRules.backdrop(hasSource: found != nil, insideSource: inside) {
    case .source: backdrop = found.map(Backdrop.source)
    case .beneath: backdrop = window.map(Backdrop.beneath)
    }
    let next = LiquidGlassRules.choose(
      classic: classic,
      metal: metal.hasMetal,
      flat: GlassLaunch.flat,
      lensFailed: metal.failures > 0,
      rimFailed: metal.failures > 0,
      holdsPage: found.map(GlassSources.holdsPage) ?? false,
      solidPageAsked: GlassLaunch.solidPage,
      overBudget: GlassFrames.shared.isOverBudget(captureKey),
      onScreen: window != nil
    )
    let changed = next != choice
    if changed {
      choice = next
      drawnUniforms = nil
    }
    report()
    GlassFrames.shared.schedule()
    if changed || force { invalidate() }
  }

  func metalChanged() {
    drawnUniforms = nil
    needsPath(force: true)
  }

  func invalidate() {
    if batching > 0 {
      batchedInvalidate = true
      return
    }
    drawnUniforms = nil
    applyFallback()
    if !wantsFrames { drawStill() }
  }

  func followPresentation() {
    guard followsPresentation else { return }
    let shown = hasRunningAnimations ? (layer.presentation() ?? layer).bounds.size : bounds.size
    if shown != lensLayer.bounds.size { layoutLayers(size: shown) }
  }

  func region(in space: UIView) -> CGRect? {
    let shown = CGRect(origin: .zero, size: lensLayer.bounds.size)
    let region: CGRect
    if let mine = layer.presentation(), let theirs = space.layer.presentation() {
      region = mine.convert(shown, to: theirs)
    } else {
      region = layer.convert(shown, to: space.layer)
    }
    return region.isNull || region.isEmpty ? nil : region
  }

  func draw(with capture: GlassCapture?, space: UIView?, into buffer: MTLCommandBuffer) {
    guard let pipeline = GlassMetal.shared.pipeline else { return }
    let size = lensLayer.bounds.size
    guard size.width > 0, size.height > 0 else { return }
    var uv = (left: 0.0, top: 0.0, width: 1.0, height: 1.0)
    var live = false
    var texture: MTLTexture?
    if let capture, let space, let captured = capture.texture, isShownOnScreen, let region = region(in: space), !capture.rect.isNull {
      let rect = capture.rect
      uv = (Double((region.minX - rect.minX) / rect.width), Double((region.minY - rect.minY) / rect.height), Double(region.width / rect.width), Double(region.height / rect.height))
      live = true
      texture = captured
    }
    let frame = makeFrame(size: size, live: live, uv: uv)
    let uniforms = frame.uniforms
    let generation = capture?.generation ?? -1
    if uniforms == drawnUniforms, generation == drawnGeneration, size == drawnSize { return }
    guard let drawable = lensLayer.nextDrawable() else { return }
    let pass = MTLRenderPassDescriptor()
    pass.colorAttachments[0].texture = drawable.texture
    pass.colorAttachments[0].loadAction = .clear
    pass.colorAttachments[0].clearColor = MTLClearColor(red: 0, green: 0, blue: 0, alpha: 0)
    pass.colorAttachments[0].storeAction = .store
    guard let encoder = buffer.makeRenderCommandEncoder(descriptor: pass) else { return }
    encoder.setRenderPipelineState(pipeline)
    uniforms.withUnsafeBytes { encoder.setFragmentBytes($0.baseAddress!, length: $0.count, index: 0) }
    if let texture { encoder.setFragmentTexture(texture, index: 0) } else { encoder.setFragmentTexture(GlassBlank.texture, index: 0) }
    encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
    encoder.endEncoding()
    buffer.present(drawable)
    drawnUniforms = uniforms
    drawnGeneration = generation
    drawnSize = size
    if lensLayer.isHidden || !fillLayer.isHidden {
      CATransaction.begin()
      CATransaction.setDisableActions(true)
      lensLayer.isHidden = false
      fillLayer.isHidden = true
      CATransaction.commit()
    }
  }

  private func drawStill() {
    guard GlassMetal.shared.isReady, !classic, let buffer = GlassMetal.shared.queue?.makeCommandBuffer() else { return }
    draw(with: nil, space: nil, into: buffer)
    buffer.commit()
  }

  private func makeFrame(size: CGSize, live: Bool, uv: (left: Double, top: Double, width: Double, height: Double)) -> LiquidGlassShader.Frame {
    let dark = isDark
    let fill = choice.path == .solid ? (solidFill.map { GlassInk($0.resolvedColor(with: traits(dark))) } ?? GlassFrostStyle.glass.fallback(dark: dark)) : GlassFrostStyle.glass.fallback(dark: dark)
    return LiquidGlassShader.Frame(
      width: Double(size.width),
      height: Double(size.height),
      scale: Double(lensLayer.contentsScale),
      radius: Double(radius(for: size)),
      live: live,
      lens: live && choice.lens,
      rim: choice.rim,
      dark: dark,
      uv: uv,
      fill: fill,
      tint: tint.map { GlassInk($0.resolvedColor(with: traits(dark))) } ?? .clear
    )
  }

  private func traits(_ dark: Bool) -> UITraitCollection { UITraitCollection(userInterfaceStyle: dark ? .dark : .light) }

  private func radius(for size: CGSize) -> CGFloat {
    if let presented = presentedRadius?() { return min(presented, min(size.width, size.height) / 2) }
    return CGFloat(LiquidGlassRules.radius(capsule: capsule, cornerRadius: Double(cornerRadius), width: Double(size.width), height: Double(size.height)))
  }

  private func layoutLayers(size: CGSize) {
    let scale = self.scale
    if let laidOut, laidOut.size == size, laidOut.scale == scale { return }
    laidOut = (size, scale)
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    let frame = CGRect(origin: .zero, size: size)
    fillLayer.frame = frame
    lensLayer.frame = frame
    lensLayer.contentsScale = scale
    lensLayer.drawableSize = CGSize(width: (size.width * scale).rounded(), height: (size.height * scale).rounded())
    lensLayer.device = GlassMetal.shared.device
    CATransaction.commit()
    invalidate()
  }

  private func applyFallback() {
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    let dark = isDark
    let size = bounds.size
    let base = choice.path == .solid ? (solidFill.map { GlassInk($0.resolvedColor(with: traits(dark))) } ?? GlassFrostStyle.glass.fallback(dark: dark)) : GlassFrostStyle.glass.fallback(dark: dark)
    let tinted = tint.map { GlassInk($0.resolvedColor(with: traits(dark))) }.map { $0.over(base) } ?? base
    fillLayer.backgroundColor = UIColor(red: tinted.red, green: tinted.green, blue: tinted.blue, alpha: tinted.alpha).cgColor
    fillLayer.cornerRadius = radius(for: size)
    let edge = GlassFrostStyle.glass.edge(dark: dark)
    fillLayer.borderWidth = GlassFrostStyle.glass.edgeWidth
    fillLayer.borderColor = UIColor(red: edge.red, green: edge.green, blue: edge.blue, alpha: edge.alpha).cgColor
    let metal = GlassMetal.shared.isReady && !classic
    if !metal {
      fillLayer.isHidden = false
      lensLayer.isHidden = true
    }
    CATransaction.commit()
  }

  private func report() {
    let line = "path=\(choice.path.rawValue) (\(choice.reason)) lens=\(choice.lens ? "yes" : "no") rim=\(choice.rim ? "yes" : "no") source=\(source ?? "none")"
    guard PhoneTestBuild.isOn, line != reportedPath else { return }
    reportedPath = line
    NSLog("PAGELAB look glass %@ %@ %@", label, NSCoder.string(for: bounds.size), line)
  }

  private static func same(_ one: UIColor?, _ other: UIColor?) -> Bool {
    switch (one, other) {
    case (nil, nil): true
    case let (one?, other?): one.isEqual(other)
    default: false
    }
  }
}

@MainActor
final class LiquidGlassSurfaceBound {
  private var bound = LiquidGlassBound()

  func measure(_ size: CGSize) -> LiquidGlassBound {
    bound.measure(width: Double(size.width), height: Double(size.height))
    return bound
  }
}

@MainActor
enum GlassBlank {
  static let texture: MTLTexture? = {
    guard let device = GlassMetal.shared.device else { return nil }
    let descriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm, width: 1, height: 1, mipmapped: false)
    descriptor.usage = .shaderRead
    let texture = device.makeTexture(descriptor: descriptor)
    var clear: UInt32 = 0
    texture?.replace(region: MTLRegionMake2D(0, 0, 1, 1), mipmapLevel: 0, withBytes: &clear, bytesPerRow: 4)
    return texture
  }()
}

extension GlassInk {
  init(_ color: UIColor) {
    var red: CGFloat = 0
    var green: CGFloat = 0
    var blue: CGFloat = 0
    var alpha: CGFloat = 0
    color.getRed(&red, green: &green, blue: &blue, alpha: &alpha)
    self.init(red: Double(min(max(red, 0), 1)), green: Double(min(max(green, 0), 1)), blue: Double(min(max(blue, 0), 1)), alpha: Double(min(max(alpha, 0), 1)))
  }

  func over(_ under: GlassInk) -> GlassInk {
    let alpha = self.alpha + under.alpha * (1 - self.alpha)
    guard alpha > 0 else { return .clear }
    func mix(_ top: Double, _ bottom: Double) -> Double { (top * self.alpha + bottom * under.alpha * (1 - self.alpha)) / alpha }
    return GlassInk(red: mix(red, under.red), green: mix(green, under.green), blue: mix(blue, under.blue), alpha: alpha)
  }
}
