import ArdiaDesign
import Foundation
import Metal
import Testing

struct LiquidGlassTests {
  private static let repo = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../../../../..").standardizedFileURL

  private static func android(_ path: String) throws -> String {
    try String(contentsOf: repo.appendingPathComponent(path), encoding: .utf8)
  }

  private static func number(_ name: String, in text: String) -> Double? {
    guard let range = text.range(of: "\(name) = ") else { return nil }
    let rest = text[range.upperBound...]
    let digits = rest.prefix { "-0123456789.".contains($0) }
    return Double(digits)
  }

  private static func block(_ start: String, in text: String) -> String {
    guard let range = text.range(of: start) else { return "" }
    let lines = text[range.upperBound...].components(separatedBy: "\n")
    return lines.prefix { $0.trimmingCharacters(in: .whitespaces) != ")" }.joined(separator: "\n")
  }

  @Test func `the parameters are Android's, read from its source`() throws {
    let kotlin = try Self.android("packages/phone/android/src/main/java/com/ardia/phone/LiquidGlass.kt")
    let defaults = Self.block("val defaults = Params(", in: kotlin)
    let params = LiquidGlassParams.defaults
    let pairs: [(String, Double)] = [
      ("ior", params.ior), ("dispersion", params.dispersion), ("bezelDp", params.bezel), ("depthDp", params.depth),
      ("maxSlope", params.maxSlope), ("specularWidthDp", params.specularWidth), ("specularStrength", params.specularStrength),
      ("oppositeStrength", params.oppositeStrength), ("specularFalloff", params.specularFalloff),
      ("specularSharpness", params.specularSharpness), ("specularOpacity", params.specularOpacity),
    ]
    for (name, value) in pairs {
      let theirs = try #require(Self.number(name, in: defaults), "\(name) is missing from LiquidGlass.kt")
      #expect(abs(theirs - value) < 1e-9, "\(name): Android \(theirs), iPhone \(value)")
    }
    #expect(defaults.contains("lightAngle = (-Math.PI / 4).toFloat()"))
    #expect(params.lightAngle == -Double.pi / 4)
    #expect(Self.number("const val DARK_RIM_SHARE", in: kotlin) == LiquidGlassRules.darkRimShare)
    #expect(Self.number("const val BEZEL_SHARE_OF_SHORT_SIDE", in: kotlin) == LiquidGlassRules.bezelShareOfShortSide)
    #expect(Self.number("const val EDGE_FEATHER_PX", in: kotlin) == LiquidGlassRules.edgeFeatherPixels)
    #expect(Self.number("const val CIRCULAR_CORNER_EXPONENT", in: kotlin) == LiquidGlassRules.circularCornerExponent)
  }

  @Test func `the frost under the glass is Android's glass frost`() throws {
    let kotlin = try Self.android("apps/phone/android/ardia-design/src/main/java/com/ardia/design/FrostedStyle.kt")
    let glass = Self.block("val glass = FrostedStyle(", in: kotlin)
    let style = GlassFrostStyle.glass
    #expect(glass.contains("blurRadius = \(Int(style.blur)).dp"))
    #expect(Self.number("saturation", in: glass) == style.saturation)
    #expect(glass.contains("tint = adaptive(ardiaColor(0xFFFFFF, 0.45f), ardiaColor(0xFFFFFF, 0.1f))"))
    #expect(glass.contains("fallback = adaptive(ardiaColor(0xFFFFFF, 0.82f), ardiaColor(0x3A3A3C, 0.82f))"))
    #expect(glass.contains("edge = adaptive(Color.Black.copy(alpha = 0.06f), Color.White.copy(alpha = 0.1f))"))
    #expect(style.tint(dark: false) == GlassInk(hex: 0xFFFFFF, alpha: 0.45))
    #expect(style.fallback(dark: true) == GlassInk(hex: 0x3A3A3C, alpha: 0.82))
    #expect(style.edgeWidth == 0.5)
  }

  @Test func `the profile rises from the edge to flat`() {
    #expect(abs(LiquidGlassRules.profile(0) - 0.01) < 1e-9)
    #expect(LiquidGlassRules.profile(1) == 1)
    #expect(LiquidGlassRules.profile(0.5) > LiquidGlassRules.profile(0.25))
    #expect(LiquidGlassRules.profile(-1) == LiquidGlassRules.profile(0))
    #expect(LiquidGlassRules.slope(1, maxSlope: 5.67) == 0)
    #expect(LiquidGlassRules.slope(0, maxSlope: 5.67) == 5.67)
    #expect(LiquidGlassRules.slope(0.5, maxSlope: 5.67) < LiquidGlassRules.slope(0.1, maxSlope: 5.67))
  }

  @Test func `the bezel is 14 points, at most 30 percent of the shorter side`() {
    #expect(LiquidGlassRules.bezel(width: 300, height: 52) == 14)
    #expect(abs(LiquidGlassRules.bezel(width: 300, height: 40) - 12) < 1e-9)
    #expect(LiquidGlassRules.bezel(width: 0, height: 40) == 0)
    #expect(LiquidGlassRules.bezel(width: -5, height: 40) == 0)
  }

  @Test func `the largest shift is about 11 points for a 14 point bezel, and none for a flat glass`() {
    let shift = LiquidGlassRules.maxShift(bezel: 14)
    #expect(abs(shift - 11.448) < 0.01)
    #expect(LiquidGlassRules.shiftRatio(slope: 0, ior: 1.5) == 0)
    #expect(LiquidGlassRules.shiftRatio(slope: 1, ior: 1.5) > 0)
    #expect(LiquidGlassRules.shiftRatio(slope: 1, ior: 1.54) > LiquidGlassRules.shiftRatio(slope: 1, ior: 1.46))
    var bound = LiquidGlassBound()
    bound.measure(width: 300, height: 52)
    bound.measure(width: 300, height: 52)
    #expect(bound.computed == 1)
    #expect(abs(bound.shift - shift) < 1e-9)
    bound.measure(width: 48, height: 48)
    #expect(bound.computed == 2)
  }

  @Test func `the capture holds the blur and the shift, at a sixth of the pixels for the glass frost`() {
    #expect(LiquidGlassRules.marginPixels(blurPixels: 36, shiftPixels: 24) == 72)
    #expect(LiquidGlassRules.marginPixels(blurPixels: 2, shiftPixels: 24.2) == 26)
    #expect(LiquidGlassRules.frostScale(blurPixels: 36) == 6)
    #expect(LiquidGlassRules.frostScale(blurPixels: 3) == 1)
    #expect(LiquidGlassRules.frostScale(blurPixels: 200) == 8)
    #expect(LiquidGlassRules.blurSigma(radius: 0) == 0)
    #expect(abs(LiquidGlassRules.blurSigma(radius: 6) - 3.9641) < 1e-3)
  }

  @Test func `the light comes from the top left and the rim is dimmer in dark`() {
    let light = LiquidGlassRules.light(LiquidGlassParams.defaults.lightAngle)
    #expect(light.x < 0 && light.y < 0)
    let topLeft = LiquidGlassRules.rimAlpha(normalAngle: 1.25 * Double.pi, dark: false)
    let bottomRight = LiquidGlassRules.rimAlpha(normalAngle: 0.25 * Double.pi, dark: false)
    let side = LiquidGlassRules.rimAlpha(normalAngle: 0.75 * Double.pi, dark: false)
    #expect(abs(topLeft - 0.5) < 1e-9)
    #expect(abs(bottomRight - 0.35) < 1e-9)
    #expect(side < 1e-9)
    #expect(abs(LiquidGlassRules.rimAlpha(normalAngle: 1.25 * Double.pi, dark: true) - 0.35) < 1e-9)
    #expect(LiquidGlassRules.rimStops(dark: false).count == 25)
  }

  @Test func `every glass refracts what is under it, falling back only for classic, Metal, budget or the lab`() {
    func path(classic: Bool = false, metal: Bool = true, flat: Bool = false, lensFailed: Bool = false, holdsPage: Bool = false, solidPageAsked: Bool = false, overBudget: Bool = false, onScreen: Bool = true) -> LiquidGlassRules.Choice {
      LiquidGlassRules.choose(classic: classic, metal: metal, flat: flat, lensFailed: lensFailed, rimFailed: false, holdsPage: holdsPage, solidPageAsked: solidPageAsked, overBudget: overBudget, onScreen: onScreen)
    }
    #expect(path().path == .live)
    #expect(path().lens && path().rim)
    #expect(path(holdsPage: true).path == .live)
    #expect(path(holdsPage: true).lens)
    #expect(path(classic: true).path == .classic)
    #expect(!path(classic: true).rim)
    #expect(path(metal: false).path == .fallback)
    #expect(!path(metal: false).rim)
    #expect(path(onScreen: false).path == .fallback)
    #expect(path(overBudget: true).path == .fallback)
    #expect(path(holdsPage: true, overBudget: true).path == .solid)
    #expect(path(overBudget: true).rim)
    #expect(path(holdsPage: true, solidPageAsked: true).path == .solid)
    #expect(path(solidPageAsked: true).path == .live)
    #expect(path(flat: true).path == .live)
    #expect(!path(flat: true).lens && !path(flat: true).rim)
    #expect(!path(lensFailed: true).lens && path(lensFailed: true).rim)
  }

  @Test func `glass outside its source draws the source, and glass inside it or without one draws what is beneath it`() {
    #expect(LiquidGlassRules.backdrop(hasSource: true, insideSource: false) == .source)
    #expect(LiquidGlassRules.backdrop(hasSource: true, insideSource: true) == .beneath)
    #expect(LiquidGlassRules.backdrop(hasSource: false, insideSource: false) == .beneath)
  }

  @Test func `a capture is over budget only when it keeps the main thread busy for two seconds`() {
    func samples(every gap: Double, ms: Double, for seconds: Double) -> [LiquidGlassRules.CaptureSample] {
      stride(from: 0.0, through: seconds, by: gap).map { LiquidGlassRules.CaptureSample(at: $0, ms: ms) }
    }
    #expect(LiquidGlassRules.overBudget(samples(every: 1.0 / 60, ms: 12, for: 2), now: 2))
    #expect(!LiquidGlassRules.overBudget(samples(every: 3, ms: 30, for: 9), now: 9))
    #expect(!LiquidGlassRules.overBudget(samples(every: 1.0 / 60, ms: 12, for: 1), now: 1), "a one second burst is not enough")
    #expect(!LiquidGlassRules.overBudget(samples(every: 1.0 / 60, ms: 1.5, for: 2), now: 2))
    #expect(LiquidGlassRules.recentSamples(samples(every: 1, ms: 5, for: 10), now: 10).count == 3)
  }

  @Test func `the render reported at launch is the best the phone can draw`() {
    #expect(LiquidGlassRules.render(classic: false, flat: false, metal: true, lensFailed: false) == .lens)
    #expect(LiquidGlassRules.render(classic: false, flat: true, metal: true, lensFailed: false) == .frost)
    #expect(LiquidGlassRules.render(classic: false, flat: false, metal: true, lensFailed: true) == .frost)
    #expect(LiquidGlassRules.render(classic: false, flat: false, metal: false, lensFailed: false) == .solid)
    #expect(LiquidGlassRules.render(classic: true, flat: false, metal: true, lensFailed: false) == .classic)
  }

  @Test func `a capsule's radius is half its height and a rounded one is capped there`() {
    #expect(LiquidGlassRules.radius(capsule: true, cornerRadius: 0, width: 300, height: 52) == 26)
    #expect(LiquidGlassRules.radius(capsule: false, cornerRadius: 12, width: 300, height: 52) == 12)
    #expect(LiquidGlassRules.radius(capsule: false, cornerRadius: 40, width: 300, height: 52) == 26)
    #expect(LiquidGlassRules.radius(capsule: false, cornerRadius: -3, width: 300, height: 52) == 0)
  }

  @Test func `the uniforms line up with the shader's struct`() {
    let frame = LiquidGlassShader.Frame(width: 300, height: 52, scale: 3, radius: 26, live: true, lens: true, rim: true, dark: true, fill: GlassInk(hex: 0x1E1B1D), tint: GlassInk(hex: 0xFF0000, alpha: 0.5))
    let values = frame.uniforms
    #expect(values.count == LiquidGlassShader.Uniform.allCases.count)
    #expect(values[LiquidGlassShader.Uniform.width.rawValue] == 300)
    #expect(values[LiquidGlassShader.Uniform.bezel.rawValue] == 14)
    #expect(abs(values[LiquidGlassShader.Uniform.rimOpacity.rawValue] - 0.35) < 1e-6)
    #expect(values[LiquidGlassShader.Uniform.tintRed.rawValue] == 0.5)
    #expect(values[LiquidGlassShader.Uniform.tintAlpha.rawValue] == 0.5)
    #expect(abs(values[LiquidGlassShader.Uniform.frostAlpha.rawValue] - 0.1) < 1e-6)
    let names = LiquidGlassShader.Uniform.allCases.map { "float \($0)" }
    let declared = LiquidGlassShader.source.components(separatedBy: "struct GlassUniforms {")[1].components(separatedBy: "};")[0]
    let order = declared.components(separatedBy: ";").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
    #expect(order == names)
  }

  @Test func `the shader compiles wherever there is Metal`() throws {
    guard let device = MTLCreateSystemDefaultDevice() else { return }
    let library = try device.makeLibrary(source: LiquidGlassShader.source, options: nil)
    #expect(library.makeFunction(name: LiquidGlassShader.vertexName) != nil)
    #expect(library.makeFunction(name: LiquidGlassShader.fragmentName) != nil)
  }

  @Test func `the median of an even count averages the two middle samples`() {
    #expect(LiquidGlassRules.median([]) == 0)
    #expect(LiquidGlassRules.median([3]) == 3)
    #expect(LiquidGlassRules.median([1, 9, 2]) == 2)
    #expect(LiquidGlassRules.median([1, 2, 6, 9]) == 4)
  }

  @Test func `a glass takes captures only while it refracts, and a failed one backs off`() {
    func path(overBudget: Bool = false, classic: Bool = false, metal: Bool = true) -> LiquidGlassRules.Path {
      LiquidGlassRules.choose(classic: classic, metal: metal, flat: false, lensFailed: false, rimFailed: false, holdsPage: true, overBudget: overBudget).path
    }
    let steps = [path(), path(overBudget: true), path()]
    #expect(steps == [.live, .solid, .live])
    #expect(steps.map(LiquidGlassRules.acceptsCapture) == [true, false, true])
    #expect(!LiquidGlassRules.acceptsCapture(path(classic: true)))
    #expect(!LiquidGlassRules.acceptsCapture(path(metal: false)))
    #expect(LiquidGlassRules.captureRetryDelay(failures: 0) == 0)
    #expect(LiquidGlassRules.captureRetryDelay(failures: 1) == 0.05)
    #expect(LiquidGlassRules.captureRetryDelay(failures: 3) == 0.2)
    #expect(LiquidGlassRules.captureRetryDelay(failures: 40) == 1)
  }

  @Test func `only siblings drawn under the glass are captured, by zPosition then index`() {
    let siblings = [GlassStacking.Sibling(index: 0, zPosition: 0), GlassStacking.Sibling(index: 1, zPosition: 5), GlassStacking.Sibling(index: 2, zPosition: 0), GlassStacking.Sibling(index: 3, zPosition: -1), GlassStacking.Sibling(index: 4, zPosition: 0)]
    #expect(GlassStacking.below(siblings[2], among: siblings) == [3, 0])
    #expect(GlassStacking.below(siblings[1], among: siblings) == [3, 0, 2, 4])
    #expect(GlassStacking.below(siblings[3], among: siblings) == [])
    #expect(GlassStacking.drawOrder(siblings).map(\.index) == [3, 0, 2, 4, 1])
  }

  @Test func `the capture starts at the topmost opaque piece that truly covers the strip`() {
    let strip = CGRect(x: 20, y: 700, width: 360, height: 60)
    let screen = CGRect(x: 0, y: 0, width: 402, height: 874)
    let pieces = [
      GlassStacking.Coverage(rect: screen, opaque: true),
      GlassStacking.Coverage(rect: screen, opaque: true, clips: [CGRect(x: 0, y: 0, width: 402, height: 600)]),
      GlassStacking.Coverage(rect: screen, radius: 30, opaque: true),
      GlassStacking.Coverage(rect: screen, axisAligned: false, opaque: true),
      GlassStacking.Coverage(rect: screen, opaque: false),
    ]
    #expect(GlassStacking.opaqueFloor(pieces, covering: strip) == 2)
    #expect(!pieces[2].covers(CGRect(x: 0, y: 850, width: 402, height: 24)))
    #expect(!pieces[1].covers(strip))
    #expect(!pieces[3].covers(strip))
    #expect(GlassStacking.opaqueFloor([GlassStacking.Coverage(rect: screen, opaque: false)], covering: strip) == nil)
  }

  @Test func `a snapshot is kept only for the page and navigation it was asked for`() {
    var gate = GlassSnapshotGate()
    let first = GlassPageKey(page: 1, navigation: 4)
    let firstSeen = gate.observe(first)
    let seenAgain = gate.observe(first)
    #expect(firstSeen)
    #expect(!seenAgain)
    let asked = gate.begin(now: 0)
    #expect(gate.accepts(token: asked, key: first))
    let otherTab = gate.observe(GlassPageKey(page: 2, navigation: 4))
    #expect(otherTab, "another tab")
    #expect(!gate.accepts(token: asked, key: first), "a late completion from the old tab is refused")
    #expect(!gate.accepts(token: asked, key: GlassPageKey(page: 2, navigation: 4)))
    let newDocument = gate.observe(GlassPageKey(page: 2, navigation: 5))
    #expect(newDocument, "a new document in the same tab")
    let again = gate.begin(now: 1)
    let newer = gate.begin(now: 1.1)
    #expect(!gate.accepts(token: again, key: GlassPageKey(page: 2, navigation: 5)), "only the newest request counts")
    #expect(gate.accepts(token: newer, key: GlassPageKey(page: 2, navigation: 5)))
  }

  @Test func `snapshot requests are throttled while scrolling and back off after failures`() {
    var gate = GlassSnapshotGate()
    gate.observe(GlassPageKey(page: 1, navigation: 1))
    #expect(gate.mayRequest(now: 0, changed: true, pending: false))
    _ = gate.begin(now: 0)
    #expect(!gate.mayRequest(now: 0.01, changed: true, pending: false), "at most twenty a second while scrolling")
    #expect(gate.mayRequest(now: 0.06, changed: true, pending: false))
    #expect(!gate.mayRequest(now: 0.06, changed: true, pending: true))
    #expect(!gate.mayRequest(now: 0.3, changed: false, pending: false), "a still page refreshes twice a second")
    #expect(gate.mayRequest(now: 0.6, changed: false, pending: false))
    gate.failed(now: 1)
    gate.failed(now: 1)
    #expect(!gate.mayRequest(now: 1.05, changed: true, pending: false))
    #expect(gate.mayRequest(now: 1.11, changed: true, pending: false))
    gate.succeeded()
    #expect(gate.failures == 0)
  }

  @Test func `a shifted snapshot must cover the strip, so a fast fling shows the fill`() {
    let viewport = CGRect(x: 0, y: 0, width: 402, height: 874)
    let image = viewport.insetBy(dx: 0, dy: -320)
    let bar = CGRect(x: 0, y: 760 - 24, width: 402, height: 48 + 48)
    #expect(GlassFlowRules.snapshotCovers(image: image, shift: .zero, needed: bar))
    #expect(GlassFlowRules.snapshotCovers(image: image, shift: CGPoint(x: 0, y: 300), needed: bar))
    #expect(!GlassFlowRules.snapshotCovers(image: image, shift: CGPoint(x: 0, y: 520), needed: bar), "the image ends at 674 points and the bar is at 760")
    #expect(!GlassFlowRules.snapshotCovers(image: .null, shift: .zero, needed: bar))
  }

  @Test func `at most two frames are in flight and a drawable is taken only when one is free`() {
    var flight = GlassFlight(limit: 2)
    let one = flight.reserve()
    let two = flight.reserve()
    let three = flight.reserve()
    #expect(one && two)
    #expect(!three, "the third waits")
    flight.finish()
    let again = flight.reserve()
    #expect(again)
    #expect(flight.inFlight == 2)
    flight.finish()
    flight.finish()
    flight.finish()
    #expect(flight.inFlight == 0)
    #expect(GlassFlowRules.canAcquireDrawable(outstanding: 0, maximum: 3))
    #expect(!GlassFlowRules.canAcquireDrawable(outstanding: 1, maximum: 3), "one shown and one queued by the compositor, one still on the GPU")
    #expect(GlassFlowRules.canAcquireDrawable(outstanding: 1, maximum: 4))
  }

  @Test func `one capture longer than a frame is over budget`() {
    let frameMs = 1000.0 / 60
    #expect(LiquidGlassRules.overBudget([LiquidGlassRules.CaptureSample(at: 1, ms: 35)], now: 1.2, frameMs: frameMs))
    #expect(!LiquidGlassRules.overBudget([LiquidGlassRules.CaptureSample(at: 1, ms: 12)], now: 1.2, frameMs: frameMs))
    #expect(!LiquidGlassRules.overBudget([LiquidGlassRules.CaptureSample(at: 1, ms: 35)], now: 4, frameMs: frameMs), "it ages out of the window")
    let cold = [LiquidGlassRules.CaptureSample(at: 1, ms: 45), LiquidGlassRules.CaptureSample(at: 1.02, ms: 3)]
    #expect(!LiquidGlassRules.overBudget(cold, now: 1.1, frameMs: frameMs, warm: false), "a glass's first, cold capture warms up outside the limit")
    #expect(LiquidGlassRules.overBudget(cold + [LiquidGlassRules.CaptureSample(at: 1.04, ms: 30)], now: 1.1, frameMs: frameMs, warm: false), "a slow one after it still counts")
  }

  @Test func `a changing backdrop is recaptured when its change ends, not a second later`() {
    #expect(!GlassFlowRules.recaptureNow(changed: false, quietFrames: 9, sinceCapture: 9, gap: 1))
    #expect(!GlassFlowRules.recaptureNow(changed: true, quietFrames: 0, sinceCapture: 0.2, gap: 1), "mid crossfade it waits")
    #expect(GlassFlowRules.recaptureNow(changed: true, quietFrames: 2, sinceCapture: 0.2, gap: 1), "the crossfade ended")
    #expect(GlassFlowRules.recaptureNow(changed: true, quietFrames: 0, sinceCapture: 1.1, gap: 1))
  }

  @Test func `the rim is its own pass of white light, so compositing it with plus lighter is Android's PLUS`() throws {
    guard let device = MTLCreateSystemDefaultDevice(), let queue = device.makeCommandQueue() else { return }
    let library = try device.makeLibrary(source: LiquidGlassShader.source, options: nil)
    let descriptor = MTLRenderPipelineDescriptor()
    descriptor.vertexFunction = library.makeFunction(name: LiquidGlassShader.vertexName)
    descriptor.fragmentFunction = library.makeFunction(name: LiquidGlassShader.fragmentName)
    descriptor.colorAttachments[0].pixelFormat = .bgra8Unorm
    let pipeline = try device.makeRenderPipelineState(descriptor: descriptor)
    func render(rim: Bool, rimOnly: Bool) -> [Float] {
      var frame = LiquidGlassShader.Frame(width: 48, height: 48, scale: 1, radius: 24, live: false, lens: false, rim: rim, dark: false, fill: GlassFrostStyle.glass.fallback(dark: false))
      frame.rimOnly = rimOnly
      let target = device.makeTexture(descriptor: { let made = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm, width: 48, height: 48, mipmapped: false); made.usage = [.renderTarget, .shaderRead]; made.storageMode = .shared; return made }())!
      let blank = device.makeTexture(descriptor: MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .bgra8Unorm, width: 1, height: 1, mipmapped: false))!
      let buffer = queue.makeCommandBuffer()!
      let pass = MTLRenderPassDescriptor()
      pass.colorAttachments[0].texture = target
      pass.colorAttachments[0].loadAction = .clear
      pass.colorAttachments[0].storeAction = .store
      let encoder = buffer.makeRenderCommandEncoder(descriptor: pass)!
      encoder.setRenderPipelineState(pipeline)
      let uniforms = frame.uniforms
      uniforms.withUnsafeBytes { encoder.setFragmentBytes($0.baseAddress!, length: $0.count, index: 0) }
      encoder.setFragmentTexture(blank, index: 0)
      encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
      encoder.endEncoding()
      buffer.commit()
      buffer.waitUntilCompleted()
      var pixel = [UInt8](repeating: 0, count: 4)
      target.getBytes(&pixel, bytesPerRow: 4 * 48, from: MTLRegionMake2D(0, 24, 1, 1), mipmapLevel: 0)
      return pixel.map { Float($0) / 255 }
    }
    let glass = render(rim: true, rimOnly: false)
    #expect(glass == render(rim: false, rimOnly: false), "the glass pass carries no rim")
    let light = render(rim: true, rimOnly: true)
    #expect(light[3] > 0.05)
    #expect(light.allSatisfy { abs($0 - light[3]) < 0.01 }, "premultiplied white: the same value in all four channels")
    #expect(render(rim: false, rimOnly: true).allSatisfy { $0 == 0 })
    for backdrop: [Float] in [[0.2, 0.3, 0.4, 1], [0.2, 0.3, 0.4, 0.5]] {
      let under = (0..<4).map { glass[$0] + backdrop[$0] * (1 - glass[3]) }
      let android = (0..<4).map { min(under[$0] + light[3], 1) }
      let ours = (0..<4).map { min(under[$0] + light[$0], 1) }
      for channel in 0..<4 { #expect(abs(android[channel] - ours[channel]) < 0.01) }
      #expect(ours[3] >= under[3], "PLUS adds to alpha too")
    }
  }
}
