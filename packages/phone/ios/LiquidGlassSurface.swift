import ArdiaDesign
import CoreVideo
import Metal
import MetalPerformanceShaders
import QuartzCore
import UIKit
import WebKit

enum GlassLaunch {
  enum Capture: String {
    case hierarchy
    case layer
    case none
  }

  static let flat = PhoneTestBuild.flag("ArdiaFlatGlass")
  static let overPage = PhoneTestBuild.flag("ArdiaGlassOverPage")
  static let capture: Capture = PhoneTestBuild.isOn ? (UserDefaults.standard.string(forKey: "ArdiaGlassCapture").flatMap(Capture.init(rawValue:)) ?? .hierarchy) : .hierarchy
}

enum GlassReport {
  private static let lock = NSLock()
  nonisolated(unsafe) private static var failed = false
  static let hasDevice = MTLCreateSystemDefaultDevice() != nil

  static var shaderFailed: Bool {
    get { lock.withLock { failed } }
    set { lock.withLock { failed = newValue } }
  }

  static func render(classic: Bool) -> LiquidGlassRules.Render {
    LiquidGlassRules.render(classic: classic, flat: GlassLaunch.flat, metal: hasDevice, lensFailed: shaderFailed)
  }
}

@MainActor
final class GlassMetal {
  static let shared = GlassMetal()

  let device = MTLCreateSystemDefaultDevice()
  private(set) lazy var queue = device?.makeCommandQueue()
  private(set) var pipeline: MTLRenderPipelineState?
  private(set) var failures = 0
  private var compiling = false
  private var textureCache: CVMetalTextureCache?
  private var blurs: [Double: MPSImageGaussianBlur] = [:]
  var onFailed: (() -> Void)?

  var failed: Bool { failures > 0 && pipeline == nil && !compiling }
  var hasMetal: Bool { device != nil && !failed }
  var isReady: Bool { pipeline != nil }

  func prepare() {
    guard pipeline == nil, !compiling, failures == 0, let device else { return }
    compiling = true
    let source = LiquidGlassShader.source
    Task.detached(priority: .userInitiated) {
      let made: Result<MTLRenderPipelineState, Error> = Result {
        let library = try device.makeLibrary(source: source, options: nil)
        let descriptor = MTLRenderPipelineDescriptor()
        descriptor.vertexFunction = library.makeFunction(name: LiquidGlassShader.vertexName)
        descriptor.fragmentFunction = library.makeFunction(name: LiquidGlassShader.fragmentName)
        descriptor.colorAttachments[0].pixelFormat = .bgra8Unorm
        return try device.makeRenderPipelineState(descriptor: descriptor)
      }
      await MainActor.run { GlassMetal.shared.finish(made) }
    }
  }

  private func finish(_ made: Result<MTLRenderPipelineState, Error>) {
    compiling = false
    switch made {
    case .success(let state):
      pipeline = state
      GlassReport.shaderFailed = false
    case .failure(let error):
      failures += 1
      GlassReport.shaderFailed = true
      onFailed?()
      NSLog("PAGELAB look glass shader failed and is skipped until the app returns: %@", String(describing: error))
    }
    GlassFrames.shared.metalChanged()
  }

  func retryFailed() {
    guard failures > 0, pipeline == nil, !compiling else { return }
    failures = 0
    prepare()
  }

  func texture(of buffer: CVPixelBuffer) -> (MTLTexture, CVMetalTexture)? {
    guard let device else { return nil }
    if textureCache == nil { CVMetalTextureCacheCreate(nil, nil, device, nil, &textureCache) }
    guard let textureCache else { return nil }
    var made: CVMetalTexture?
    let width = CVPixelBufferGetWidth(buffer)
    let height = CVPixelBufferGetHeight(buffer)
    guard CVMetalTextureCacheCreateTextureFromImage(nil, textureCache, buffer, nil, .bgra8Unorm, width, height, 0, &made) == kCVReturnSuccess, let made, let texture = CVMetalTextureGetTexture(made) else { return nil }
    return (texture, made)
  }

  func flushTextures() {
    if let textureCache { CVMetalTextureCacheFlush(textureCache, 0) }
  }

  func blur(sigma: Double) -> MPSImageGaussianBlur? {
    guard let device, sigma > 0 else { return nil }
    let key = (sigma * 100).rounded() / 100
    if let known = blurs[key] { return known }
    let made = MPSImageGaussianBlur(device: device, sigma: Float(key))
    made.edgeMode = .clamp
    blurs[key] = made
    return made
  }
}

@MainActor
enum GlassSources {
  private static let sources = NSMapTable<NSString, FrostSourceView>.strongToWeakObjects()

  static func register(_ name: String, _ view: FrostSourceView) {
    sources.setObject(view, forKey: name as NSString)
    GlassFrames.shared.sourcesChanged()
  }

  static func unregister(_ name: String, _ view: FrostSourceView) {
    if sources.object(forKey: name as NSString) === view { sources.removeObject(forKey: name as NSString) }
    GlassFrames.shared.sourcesChanged()
  }

  static func find(_ name: String?) -> FrostSourceView? {
    name.flatMap { sources.object(forKey: $0 as NSString) }
  }
}

@MainActor
final class GlassCapture {
  private(set) var texture: MTLTexture?
  private(set) var rect: CGRect = .null
  private(set) var generation = 0
  private(set) var holdsPage = false
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
    var page = false
    Self.walk(source.layer, into: &hasher, budget: &budget, page: &page)
    holdsPage = page
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

  private static func walk(_ layer: CALayer, into hasher: inout Hasher, budget: inout Int, page: inout Bool) {
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
      if web.bounds.width > 0, web.bounds.height > 0 {
        page = true
        hasher.combine(web.scrollView.contentOffset.x)
        hasher.combine(web.scrollView.contentOffset.y)
      }
      return
    }
    for sublayer in layer.sublayers ?? [] { walk(sublayer, into: &hasher, budget: &budget, page: &page) }
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
      let timer = Timer(timeInterval: LiquidGlassRules.idleRefresh, repeats: true) { _ in
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
    for surface in surfaces.allObjects where surface.window != nil { surface.needsPath() }
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
      let (source, members) = entry
      let capture = captures[key] ?? GlassCapture()
      captures[key] = capture
      capture.survey(source)
      var wanted = CGRect.null
      var sigma = 0.0
      var pixelsPerPoint: CGFloat = 1
      for surface in members where surface.isShownOnScreen {
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
      for surface in members {
        if capture.holdsPage != surface.sourceHoldsPage { surface.sourceHoldsPage = capture.holdsPage }
        surface.draw(with: capture, source: source, into: buffer)
      }
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

final class LiquidGlassSurface: UIView {
  var source: String? { didSet { if source != oldValue { needsPath() } } }
  var capsule = true { didSet { if capsule != oldValue { setNeedsLayout() } } }
  var cornerRadius: CGFloat = 0 { didSet { if cornerRadius != oldValue { setNeedsLayout() } } }
  var dark: Bool? { didSet { if dark != oldValue { invalidate() } } }
  var tint: UIColor? { didSet { if tint != oldValue { invalidate() } } }
  var solidFill: UIColor? { didSet { if solidFill != oldValue { invalidate() } } }
  var classic = false { didSet { if classic != oldValue { needsPath() } } }
  var presentedRadius: (() -> CGFloat?)?
  var followsPresentation = false
  var label: String = "-"

  private let fillLayer = CALayer()
  private let lensLayer = CAMetalLayer()
  private let bound = LiquidGlassSurfaceBound()
  private(set) var choice = LiquidGlassRules.choose(classic: false, metal: false, flat: false, lensFailed: false, rimFailed: false, hasSource: false, insideSource: false, holdsPage: false, pageLive: false)
  private var drawnUniforms: [Float]?
  private var drawnGeneration = -1
  private var drawnSize: CGSize = .zero
  private var reportedPath: String?
  private(set) weak var foundSource: FrostSourceView?
  var sourceHoldsPage = false { didSet { if sourceHoldsPage != oldValue { needsPath() } } }

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
      needsPath()
    } else {
      GlassFrames.shared.detach(self)
    }
  }

  override func layoutSubviews() {
    super.layoutSubviews()
    layoutLayers(size: bounds.size)
  }

  var wantsFrames: Bool {
    guard window != nil, !classic, GlassMetal.shared.isReady else { return false }
    return choice.path == .live || (followsPresentation && (hasRunningAnimations || lensLayer.bounds.size != bounds.size))
  }

  var wantsPathChecks: Bool { window != nil && !classic && source != nil && choice.path != .live }

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

  func needsPath() {
    let metal = GlassMetal.shared
    let found = GlassSources.find(source)
    foundSource = found
    let inside = found.map { isDescendant(of: $0) } ?? false
    let next = LiquidGlassRules.choose(
      classic: classic,
      metal: metal.hasMetal,
      flat: GlassLaunch.flat,
      lensFailed: metal.failures > 0,
      rimFailed: metal.failures > 0,
      hasSource: found != nil,
      insideSource: inside,
      holdsPage: sourceHoldsPage || (found.map(Self.holdsPage) ?? false),
      pageLive: LiquidGlassRules.pageLive(classic: classic, overPageAsked: GlassLaunch.overPage),
      onScreen: window != nil
    )
    if next != choice {
      choice = next
      drawnUniforms = nil
    }
    report()
    GlassFrames.shared.schedule()
    invalidate()
  }

  func metalChanged() {
    drawnUniforms = nil
    needsPath()
  }

  func invalidate() {
    drawnUniforms = nil
    applyFallback()
    if !wantsFrames { drawStill() }
  }

  func followPresentation() {
    guard followsPresentation else { return }
    let shown = hasRunningAnimations ? (layer.presentation() ?? layer).bounds.size : bounds.size
    if shown != lensLayer.bounds.size { layoutLayers(size: shown) }
  }

  func regionInSource(_ source: UIView) -> CGRect? {
    let mine = layer.presentation() ?? layer
    let theirs = source.layer.presentation() ?? source.layer
    let region = mine.convert(CGRect(origin: .zero, size: lensLayer.bounds.size), to: theirs)
    return region.isNull || region.isEmpty ? nil : region
  }

  func draw(with capture: GlassCapture?, source: UIView?, into buffer: MTLCommandBuffer) {
    guard let pipeline = GlassMetal.shared.pipeline else { return }
    let size = lensLayer.bounds.size
    guard size.width > 0, size.height > 0 else { return }
    var uv = (left: 0.0, top: 0.0, width: 1.0, height: 1.0)
    var live = false
    var texture: MTLTexture?
    if let capture, let source, let captured = capture.texture, isShownOnScreen, let region = regionInSource(source), !capture.rect.isNull {
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
    lensLayer.isHidden = false
    fillLayer.isHidden = true
  }

  private func drawStill() {
    guard GlassMetal.shared.isReady, !classic, let buffer = GlassMetal.shared.queue?.makeCommandBuffer() else { return }
    draw(with: nil, source: nil, into: buffer)
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
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    let frame = CGRect(origin: .zero, size: size)
    fillLayer.frame = frame
    lensLayer.frame = frame
    let scale = self.scale
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

  private static func holdsPage(_ view: UIView) -> Bool {
    if view.isHidden || view.alpha <= 0 { return false }
    if view is WKWebView { return view.bounds.width > 0 && view.bounds.height > 0 }
    return view.subviews.contains(where: holdsPage)
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
