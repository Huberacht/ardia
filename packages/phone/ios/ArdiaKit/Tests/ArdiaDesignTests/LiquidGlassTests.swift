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

  @Test func `the path follows Android's choice`() {
    func path(classic: Bool = false, metal: Bool = true, flat: Bool = false, lensFailed: Bool = false, hasSource: Bool = true, insideSource: Bool = false, holdsPage: Bool = false, pageLive: Bool = false, onScreen: Bool = true) -> LiquidGlassRules.Choice {
      LiquidGlassRules.choose(classic: classic, metal: metal, flat: flat, lensFailed: lensFailed, rimFailed: false, hasSource: hasSource, insideSource: insideSource, holdsPage: holdsPage, pageLive: pageLive, onScreen: onScreen)
    }
    #expect(path().path == .live)
    #expect(path().lens && path().rim)
    #expect(path(classic: true).path == .classic)
    #expect(!path(classic: true).rim)
    #expect(path(metal: false).path == .fallback)
    #expect(!path(metal: false).rim)
    #expect(path(hasSource: false).path == .fallback)
    #expect(path(hasSource: false).rim)
    #expect(path(insideSource: true).path == .fallback)
    #expect(path(holdsPage: true).path == .solid)
    #expect(path(holdsPage: true, pageLive: true).path == .live)
    #expect(path(onScreen: false).path == .fallback)
    #expect(path(flat: true).path == .live)
    #expect(!path(flat: true).lens && !path(flat: true).rim)
    #expect(!path(lensFailed: true).lens && path(lensFailed: true).rim)
    #expect(LiquidGlassRules.pageLive(classic: false, overPageAsked: true))
    #expect(!LiquidGlassRules.pageLive(classic: true, overPageAsked: true))
    #expect(!LiquidGlassRules.pageLive(classic: false, overPageAsked: false))
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
}
