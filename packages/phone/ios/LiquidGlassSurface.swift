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
  private let lens = GlassTarget(adds: false)
  private let rim = GlassTarget(adds: true)
  private var lensLayer: CAMetalLayer { lens.layer }
  private let bound = LiquidGlassSurfaceBound()
  private(set) var choice = LiquidGlassRules.choose(classic: false, metal: false, flat: false, lensFailed: false, rimFailed: false, holdsPage: false)
  private(set) var backdropMode: LiquidGlassRules.Backdrop?
  private(set) weak var backdropSource: FrostSourceView?
  private(set) weak var backdropRoot: UIView?
  var stillPending = false
  private var drawnUniforms: [Float]? {
    get { lens.drawn }
    set {
      lens.drawn = newValue
      rim.drawn = newValue
    }
  }
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
    layer.addSublayer(fillLayer)
    layer.addSublayer(lens.layer)
    layer.addSublayer(rim.layer)
    lens.onDrawn = { [weak self] in self?.updateVisibility() }
    rim.onDrawn = { [weak self] in self?.updateVisibility() }
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
      backdropMode = nil
      backdropSource = nil
      backdropRoot = nil
      stillPending = false
      drawnUniforms = nil
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

  var waitsForPage: Bool { source == GlassSources.pageSource }

  var wantsPathChecks: Bool { window != nil && !classic && !wantsFrames }

  var captureOwner: AnyObject? {
    switch backdropMode {
    case .source: backdropSource
    case .beneath: backdropRoot == nil ? nil : self
    case nil: nil
    }
  }

  var isShownOnScreen: Bool {
    guard let window, var shown = region(in: window) else { return false }
    shown = shown.intersection(window.bounds)
    var view: UIView? = self
    while let current = view {
      if current.isHidden || current.alpha <= 0.01 { return false }
      if current !== self, current.clipsToBounds || current.layer.masksToBounds {
        shown = shown.intersection(current.convert(current.bounds, to: window))
      }
      if shown.isNull || shown.isEmpty { return false }
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
    let mode = LiquidGlassRules.backdrop(hasSource: found != nil, insideSource: inside)
    backdropMode = window == nil ? nil : mode
    backdropSource = mode == .source ? found : nil
    backdropRoot = mode == .beneath ? window : nil
    let next = LiquidGlassRules.choose(
      classic: classic,
      metal: metal.hasMetal,
      flat: GlassLaunch.flat,
      lensFailed: metal.failures > 0,
      rimFailed: metal.failures > 0,
      holdsPage: found.map(GlassSources.holdsPage) ?? false,
      solidPageAsked: GlassLaunch.solidPage,
      overBudget: GlassFrames.shared.isOverBudget(captureOwner),
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

  var rimDisabled = false

  var needsRetry: Bool { lens.needsRetry || rim.needsRetry }

  func plan(with capture: GlassCapture?, space: UIView?) -> [GlassDrawJob] {
    guard GlassMetal.shared.pipeline != nil else { return [] }
    let size = lensLayer.bounds.size
    guard size.width > 0, size.height > 0 else { return [] }
    var uv = (left: 0.0, top: 0.0, width: 1.0, height: 1.0)
    var live = false
    var texture: MTLTexture?
    if LiquidGlassRules.acceptsCapture(choice.path), let capture, let space, let captured = capture.texture, let shown = region(in: space), !capture.rect.isNull {
      let shift = capture.scrollShift
      let region = shown.offsetBy(dx: shift.x, dy: shift.y)
      let rect = capture.rect
      if rect.insetBy(dx: -0.5, dy: -0.5).contains(GlassFlowRules.footprint(of: region, margin: marginPoints)) {
        uv = (Double((region.minX - rect.minX) / rect.width), Double((region.minY - rect.minY) / rect.height), Double(region.width / rect.width), Double(region.height / rect.height))
        live = true
        texture = captured
      }
    }
    let generation = live ? (capture?.generation ?? -1) : -1
    var jobs: [GlassDrawJob] = []
    if let job = lens.plan(makeFrame(size: size, live: live, uv: uv, rimOnly: false).uniforms, generation: generation, size: size, texture: texture) { jobs.append(job) }
    if choice.rim, !rimDisabled, let job = rim.plan(makeFrame(size: size, live: false, uv: (0, 0, 1, 1), rimOnly: true).uniforms, generation: 0, size: size, texture: nil) { jobs.append(job) }
    updateVisibility()
    return jobs
  }

  func updateVisibility() {
    let rimShown = choice.rim && !rimDisabled && rim.hasDrawn && GlassMetal.shared.isReady && !classic
    let lensShown = lens.hasDrawn && GlassMetal.shared.isReady && !classic
    guard lensLayer.isHidden == lensShown || rim.layer.isHidden == rimShown || fillLayer.isHidden != lensShown else { return }
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    lensLayer.isHidden = !lensShown
    fillLayer.isHidden = lensShown
    rim.layer.isHidden = !rimShown
    CATransaction.commit()
  }

  private func drawStill() {
    guard window != nil, GlassMetal.shared.isReady, !classic else { return }
    if GlassFrames.shared.drawsInThisFrame(self) { return }
    GlassFrames.shared.submitStill(self)
  }

  func drawPendingStill() {
    guard (stillPending || needsRetry), !wantsFrames else { return }
    drawStill()
  }

  private func makeFrame(size: CGSize, live: Bool, uv: (left: Double, top: Double, width: Double, height: Double), rimOnly: Bool) -> LiquidGlassShader.Frame {
    let dark = isDark
    let fill = choice.path == .solid ? (solidFill.map { GlassInk($0.resolvedColor(with: traits(dark))) } ?? GlassFrostStyle.glass.fallback(dark: dark)) : GlassFrostStyle.glass.fallback(dark: dark)
    var frame = LiquidGlassShader.Frame(
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
      tint: tint.map { GlassInk($0.resolvedColor(with: traits(dark))) } ?? .clear,
      bound: bound.measure(size)
    )
    frame.rimOnly = rimOnly
    return frame
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
    for target in [lens, rim] { target.lay(out: frame, scale: scale) }
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
      rim.layer.isHidden = true
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

@MainActor
final class GlassTarget {
  let layer = CAMetalLayer()
  var drawn: [Float]?
  private var drawnGeneration = -1
  private var drawnSize: CGSize = .zero
  private(set) var pending = 0
  private(set) var needsRetry = false
  private(set) var hasDrawn = false
  var onDrawn: (() -> Void)?

  init(adds: Bool) {
    layer.pixelFormat = .bgra8Unorm
    layer.framebufferOnly = true
    layer.isOpaque = false
    layer.allowsNextDrawableTimeout = true
    layer.maximumDrawableCount = 3
    layer.colorspace = CGColorSpace(name: CGColorSpace.sRGB)
    layer.isHidden = true
    if adds { layer.compositingFilter = "plusL" }
  }

  func lay(out frame: CGRect, scale: CGFloat) {
    layer.frame = frame
    layer.contentsScale = scale
    layer.drawableSize = CGSize(width: (frame.width * scale).rounded(), height: (frame.height * scale).rounded())
    layer.device = GlassMetal.shared.device
  }

  func plan(_ uniforms: [Float], generation: Int, size: CGSize, texture: MTLTexture?) -> GlassDrawJob? {
    if !needsRetry, uniforms == drawn, generation == drawnGeneration, size == drawnSize { return nil }
    guard pending == 0, let source = texture ?? GlassBlank.texture else {
      needsRetry = true
      return nil
    }
    pending += 1
    needsRetry = false
    return GlassDrawJob(layer: layer, uniforms: uniforms, texture: source) { [weak self] drew in
      guard let self else { return }
      self.pending = max(self.pending - 1, 0)
      if drew {
        self.drawn = uniforms
        self.drawnGeneration = generation
        self.drawnSize = size
        self.hasDrawn = true
      } else {
        self.needsRetry = true
      }
      self.onDrawn?()
    }
  }
}
