import CoreGraphics
import Foundation
import QuartzCore

public final class GlassLayerTree: @unchecked Sendable {
  public let root: CALayer
  public let layers: Int

  init(root: CALayer, layers: Int) {
    self.root = root
    self.layers = layers
  }

  public func render(in context: CGContext) {
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    root.render(in: context)
    CATransaction.commit()
  }
}

public enum GlassLayerCopy {
  public static let layerBudget = 2000

  public enum Refusal: Error, Equatable {
    case tooMany
    case unsafe
  }

  @MainActor
  public static func tree(of layer: CALayer) -> Result<GlassLayerTree, Refusal> {
    var budget = layerBudget
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    defer { CATransaction.commit() }
    do {
      let root = try copy(shown(layer), budget: &budget) ?? CALayer()
      return .success(GlassLayerTree(root: root, layers: layerBudget - budget))
    } catch {
      return .failure(error)
    }
  }

  static func shown(_ layer: CALayer) -> CALayer { layer.presentation() ?? layer }

  public static func renders(_ layer: CALayer) -> Bool {
    !(layer is CAMetalLayer) && !NSStringFromClass(type(of: layer)).contains("Backdrop") && !(layer is CAEmitterLayer) && !(layer is CAReplicatorLayer) && !(layer is CATransformLayer)
  }

  @MainActor
  private static func copy(_ layer: CALayer, budget: inout Int) throws(Refusal) -> CALayer? {
    guard budget > 0 else { throw Refusal.tooMany }
    budget -= 1
    guard renders(layer), !layer.isHidden, layer.opacity > 0 else { return nil }
    let made: CALayer
    switch layer {
    case let shape as CAShapeLayer: made = shapeCopy(shape)
    case let gradient as CAGradientLayer: made = gradientCopy(gradient)
    case let text as CATextLayer: made = textCopy(text)
    default: made = CALayer()
    }
    copyBase(layer, into: made)
    if let mask = layer.mask {
      guard let copied = try copy(mask, budget: &budget) else { return nil }
      made.mask = copied
    }
    for sublayer in layer.sublayers ?? [] {
      if let copied = try copy(sublayer, budget: &budget) { made.addSublayer(copied) }
    }
    return made
  }

  private static func copyBase(_ layer: CALayer, into made: CALayer) {
    made.bounds = layer.bounds
    made.position = layer.position
    made.anchorPoint = layer.anchorPoint
    made.anchorPointZ = layer.anchorPointZ
    made.zPosition = layer.zPosition
    made.transform = layer.transform
    made.sublayerTransform = layer.sublayerTransform
    made.isGeometryFlipped = layer.isGeometryFlipped
    made.isDoubleSided = layer.isDoubleSided
    made.contents = layer.contents
    made.contentsRect = layer.contentsRect
    made.contentsCenter = layer.contentsCenter
    made.contentsGravity = layer.contentsGravity
    made.contentsScale = layer.contentsScale
    made.minificationFilter = layer.minificationFilter
    made.magnificationFilter = layer.magnificationFilter
    made.masksToBounds = layer.masksToBounds
    made.cornerRadius = layer.cornerRadius
    made.maskedCorners = layer.maskedCorners
    made.cornerCurve = layer.cornerCurve
    made.borderWidth = layer.borderWidth
    made.borderColor = layer.borderColor
    made.backgroundColor = layer.backgroundColor
    made.opacity = layer.opacity
    made.isOpaque = layer.isOpaque
    made.allowsEdgeAntialiasing = layer.allowsEdgeAntialiasing
    made.edgeAntialiasingMask = layer.edgeAntialiasingMask
    made.shadowColor = layer.shadowColor
    made.shadowOpacity = layer.shadowOpacity
    made.shadowOffset = layer.shadowOffset
    made.shadowRadius = layer.shadowRadius
    made.shadowPath = layer.shadowPath
  }

  private static func shapeCopy(_ shape: CAShapeLayer) -> CAShapeLayer {
    let made = CAShapeLayer()
    made.path = shape.path
    made.fillColor = shape.fillColor
    made.fillRule = shape.fillRule
    made.strokeColor = shape.strokeColor
    made.strokeStart = shape.strokeStart
    made.strokeEnd = shape.strokeEnd
    made.lineWidth = shape.lineWidth
    made.miterLimit = shape.miterLimit
    made.lineCap = shape.lineCap
    made.lineJoin = shape.lineJoin
    made.lineDashPhase = shape.lineDashPhase
    made.lineDashPattern = shape.lineDashPattern
    return made
  }

  private static func gradientCopy(_ gradient: CAGradientLayer) -> CAGradientLayer {
    let made = CAGradientLayer()
    made.colors = gradient.colors
    made.locations = gradient.locations
    made.startPoint = gradient.startPoint
    made.endPoint = gradient.endPoint
    made.type = gradient.type
    return made
  }

  private static func textCopy(_ text: CATextLayer) -> CATextLayer {
    let made = CATextLayer()
    made.string = text.string
    made.font = text.font
    made.fontSize = text.fontSize
    made.foregroundColor = text.foregroundColor
    made.isWrapped = text.isWrapped
    made.truncationMode = text.truncationMode
    made.alignmentMode = text.alignmentMode
    return made
  }
}
