import Foundation

public struct LiquidGlassParams: Equatable, Sendable {
  public var ior: Double
  public var dispersion: Double
  public var bezel: Double
  public var depth: Double
  public var maxSlope: Double
  public var lightAngle: Double
  public var specularWidth: Double
  public var specularStrength: Double
  public var oppositeStrength: Double
  public var specularFalloff: Double
  public var specularSharpness: Double
  public var specularOpacity: Double

  public static let defaults = LiquidGlassParams(
    ior: 1.5,
    dispersion: 0.04,
    bezel: 14,
    depth: 9,
    maxSlope: 5.67,
    lightAngle: -Double.pi / 4,
    specularWidth: 1.25,
    specularStrength: 1,
    oppositeStrength: 0.7,
    specularFalloff: 0.6,
    specularSharpness: 2,
    specularOpacity: 0.5
  )
}

public struct GlassInk: Equatable, Sendable {
  public var red: Double
  public var green: Double
  public var blue: Double
  public var alpha: Double

  public init(hex: UInt32, alpha: Double = 1) {
    red = Double((hex >> 16) & 0xFF) / 255
    green = Double((hex >> 8) & 0xFF) / 255
    blue = Double(hex & 0xFF) / 255
    self.alpha = alpha
  }

  public init(red: Double, green: Double, blue: Double, alpha: Double) {
    self.red = red
    self.green = green
    self.blue = blue
    self.alpha = alpha
  }

  public var premultiplied: [Float] { [Float(red * alpha), Float(green * alpha), Float(blue * alpha), Float(alpha)] }

  public static let clear = GlassInk(red: 0, green: 0, blue: 0, alpha: 0)
}

public struct GlassFrostStyle: Equatable, Sendable {
  public var blur: Double
  public var saturation: Double
  public var tint: (light: GlassInk, dark: GlassInk)
  public var fallback: (light: GlassInk, dark: GlassInk)
  public var edge: (light: GlassInk, dark: GlassInk)
  public var edgeWidth: Double

  public func tint(dark: Bool) -> GlassInk { dark ? tint.dark : tint.light }
  public func fallback(dark: Bool) -> GlassInk { dark ? fallback.dark : fallback.light }
  public func edge(dark: Bool) -> GlassInk { dark ? edge.dark : edge.light }

  public static let glass = GlassFrostStyle(
    blur: 12,
    saturation: 1.5,
    tint: (GlassInk(hex: 0xFFFFFF, alpha: 0.45), GlassInk(hex: 0xFFFFFF, alpha: 0.1)),
    fallback: (GlassInk(hex: 0xFFFFFF, alpha: 0.82), GlassInk(hex: 0x3A3A3C, alpha: 0.82)),
    edge: (GlassInk(hex: 0x000000, alpha: 0.06), GlassInk(hex: 0xFFFFFF, alpha: 0.1)),
    edgeWidth: 0.5
  )

  public static func == (lhs: GlassFrostStyle, rhs: GlassFrostStyle) -> Bool {
    lhs.blur == rhs.blur && lhs.saturation == rhs.saturation && lhs.tint == rhs.tint && lhs.fallback == rhs.fallback && lhs.edge == rhs.edge && lhs.edgeWidth == rhs.edgeWidth
  }
}

public enum LiquidGlassRules {
  public static let circularCornerExponent = 2.0
  public static let edgeFeatherPixels = 1.0
  public static let bezelShareOfShortSide = 0.3
  public static let darkRimShare = 0.7
  public static let minLowResBlur = 6.0
  public static let maxFrostScale = 8.0
  public static let idleRefresh: TimeInterval = 3
  public static let pageCheckInterval: TimeInterval = 0.25
  public static let backdropRefresh: TimeInterval = 0.25
  public static let settleFrames = 2
  public static let pressedLight = 0.08

  public enum Render: String, Sendable {
    case lens
    case frost
    case solid
    case classic
  }

  public enum Path: String, Sendable {
    case live
    case solid
    case fallback
    case classic
  }

  public struct Choice: Equatable, Sendable {
    public var path: Path
    public var reason: String
    public var lens: Bool
    public var rim: Bool
  }

  public static func render(classic: Bool, flat: Bool, metal: Bool, lensFailed: Bool) -> Render {
    if classic { return .classic }
    if !metal { return .solid }
    if flat || lensFailed { return .frost }
    return .lens
  }

  public enum Backdrop: String, Sendable {
    case source
    case beneath
  }

  public static func backdrop(hasSource: Bool, insideSource: Bool) -> Backdrop {
    hasSource && !insideSource ? .source : .beneath
  }

  public static func choose(
    classic: Bool,
    metal: Bool,
    flat: Bool,
    lensFailed: Bool,
    rimFailed: Bool,
    holdsPage: Bool,
    solidPageAsked: Bool = false,
    overBudget: Bool = false,
    onScreen: Bool = true
  ) -> Choice {
    let rim = metal && !classic && !flat && !rimFailed
    func pick(_ path: Path, _ reason: String) -> Choice {
      Choice(path: path, reason: reason, lens: path == .live && metal && !flat && !lensFailed, rim: path == .classic ? false : rim)
    }
    if classic { return pick(.classic, "classic or reduce transparency") }
    if !metal { return pick(.fallback, "no Metal") }
    if !onScreen { return pick(.fallback, "off screen: nothing to refract until it is seen") }
    if overBudget { return pick(holdsPage ? .solid : .fallback, "capture over budget") }
    if holdsPage, solidPageAsked { return pick(.solid, "page under the glass, solid page asked in the lab") }
    if holdsPage { return pick(.live, "page under the glass, captured as it changes") }
    return pick(.live, "no page under the glass")
  }

  public static let budgetWindow: TimeInterval = 2
  public static let captureBudgetShare = 0.12

  public static func median(_ samples: [Double]) -> Double {
    guard !samples.isEmpty else { return 0 }
    let sorted = samples.sorted()
    let middle = sorted.count / 2
    return sorted.count % 2 == 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle]
  }

  public struct CaptureSample: Equatable, Sendable {
    public var at: TimeInterval
    public var ms: Double

    public init(at: TimeInterval, ms: Double) {
      self.at = at
      self.ms = ms
    }
  }

  public static func recentSamples(_ samples: [CaptureSample], now: TimeInterval) -> [CaptureSample] {
    samples.filter { now - $0.at <= budgetWindow }
  }

  public static func overBudget(_ samples: [CaptureSample], now: TimeInterval) -> Bool {
    let recent = recentSamples(samples, now: now)
    guard let first = recent.first, now - first.at >= budgetWindow * 0.75 else { return false }
    let spent = recent.reduce(0) { $0 + $1.ms }
    return spent > budgetWindow * 1000 * captureBudgetShare
  }

  public static func acceptsCapture(_ path: Path) -> Bool { path == .live }

  public static let captureRetryBase: TimeInterval = 0.05
  public static let captureRetryLongest: TimeInterval = 1

  public static func captureRetryDelay(failures: Int) -> TimeInterval {
    guard failures > 0 else { return 0 }
    return min(captureRetryBase * pow(2, Double(min(failures - 1, 16))), captureRetryLongest)
  }

  public static let framesInFlight = 2

  public static func bezel(_ params: LiquidGlassParams = .defaults, width: Double, height: Double) -> Double {
    min(params.bezel, max(min(width, height), 0) * bezelShareOfShortSide)
  }

  public static func profile(_ progress: Double) -> Double {
    let u = 1 - min(max(progress, 0), 1)
    return (max(1 - pow(u, 4), 0.0001)).squareRoot()
  }

  public static func slope(_ progress: Double, maxSlope: Double) -> Double {
    let u = 1 - min(max(progress, 0), 1)
    let inside = max(1 - pow(u, 4), 0.0001)
    return min(2 * pow(u, 3) / inside.squareRoot(), maxSlope)
  }

  public static func shiftRatio(slope: Double, ior: Double) -> Double {
    let length = (slope * slope + 1).squareRoot()
    let eta = 1 / max(ior, 1.0001)
    let cosine = 1 / length
    let k = 1 - eta * eta * (1 - cosine * cosine)
    if k < 0 { return 0 }
    let along = eta * cosine - k.squareRoot()
    let sideways = -along * slope / length
    let down = eta - along / length
    return sideways / max(down, 0.0001)
  }

  public static func maxShift(_ params: LiquidGlassParams = .defaults, bezel: Double) -> Double {
    var most = 0.0
    let steps = 64
    for step in 0...steps {
      let progress = Double(step) / Double(steps)
      let height = params.depth + profile(progress) * bezel
      let slope = slope(progress, maxSlope: params.maxSlope)
      most = max(most, shiftRatio(slope: slope, ior: params.ior + params.dispersion) * height)
      most = max(most, shiftRatio(slope: slope, ior: params.ior) * height)
      most = max(most, shiftRatio(slope: slope, ior: max(params.ior - params.dispersion, 1.0001)) * height)
    }
    return most
  }

  public static func marginPixels(blurPixels: Double, shiftPixels: Double) -> Double {
    (max(blurPixels * 2, shiftPixels + edgeFeatherPixels)).rounded(.up)
  }

  public static func frostScale(blurPixels: Double) -> Double {
    min(max((blurPixels / minLowResBlur).rounded(.towardZero), 1), maxFrostScale)
  }

  public static func blurSigma(radius: Double) -> Double {
    radius > 0 ? radius * 0.57735 + 0.5 : 0
  }

  public static func light(_ angle: Double) -> (x: Double, y: Double) { (sin(angle), -cos(angle)) }

  public static func radius(capsule: Bool, cornerRadius: Double, width: Double, height: Double) -> Double {
    let half = max(min(width, height), 0) / 2
    return capsule ? half : min(max(cornerRadius, 0), half)
  }

  public static func rimOpacity(_ params: LiquidGlassParams = .defaults, dark: Bool) -> Double {
    params.specularOpacity * (dark ? darkRimShare : 1)
  }

  public static func rimAlpha(normalAngle: Double, _ params: LiquidGlassParams = .defaults, dark: Bool, progress: Double = 0) -> Double {
    let light = light(params.lightAngle)
    let normal = (x: cos(normalAngle), y: sin(normalAngle))
    let fade = params.specularFalloff * progress * progress
    let facing = normal.x * light.x + normal.y * light.y
    let lit = min(max(pow(max(facing, 0), params.specularSharpness) * (params.specularStrength - fade), 0), 1)
    let back = min(max(pow(max(-facing, 0), params.specularSharpness) * (params.oppositeStrength - fade), 0), 1)
    return min(max(lit + back, 0), 1) * rimOpacity(params, dark: dark)
  }

  public static func rimStops(_ params: LiquidGlassParams = .defaults, dark: Bool, count: Int = 24) -> [(location: Double, alpha: Double)] {
    (0...count).map { index in
      let location = Double(index) / Double(count)
      return (location, rimAlpha(normalAngle: location * 2 * Double.pi, params, dark: dark))
    }
  }
}

public struct LiquidGlassBound: Equatable, Sendable {
  public private(set) var bezel = 0.0
  public private(set) var shift = 0.0
  public private(set) var computed = 0
  private var width = -1.0
  private var height = -1.0
  private let params: LiquidGlassParams

  public init(params: LiquidGlassParams = .defaults) {
    self.params = params
  }

  public mutating func measure(width: Double, height: Double) {
    if width == self.width, height == self.height { return }
    self.width = width
    self.height = height
    bezel = LiquidGlassRules.bezel(params, width: width, height: height)
    shift = LiquidGlassRules.maxShift(params, bezel: bezel)
    computed += 1
  }
}
