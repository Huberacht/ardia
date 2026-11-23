import ArdiaDesign
import CoreGraphics
import Foundation
import QuartzCore
import Testing

@MainActor
struct GlassLayerCopyTests {
  private static func scene() -> CALayer {
    let root = CALayer()
    root.bounds = CGRect(x: 0, y: 0, width: 40, height: 40)
    root.backgroundColor = CGColor(red: 0, green: 0, blue: 1, alpha: 1)
    let card = CALayer()
    card.frame = CGRect(x: 4, y: 4, width: 20, height: 20)
    card.backgroundColor = CGColor(red: 1, green: 0, blue: 0, alpha: 1)
    card.cornerRadius = 6
    card.masksToBounds = true
    let inner = CALayer()
    inner.frame = CGRect(x: 10, y: 10, width: 20, height: 20)
    inner.backgroundColor = CGColor(red: 0, green: 1, blue: 0, alpha: 1)
    card.addSublayer(inner)
    let shape = CAShapeLayer()
    shape.path = CGPath(ellipseIn: CGRect(x: 24, y: 24, width: 12, height: 12), transform: nil)
    shape.fillColor = CGColor(red: 1, green: 1, blue: 0, alpha: 1)
    shape.opacity = 0.5
    let masked = CALayer()
    masked.frame = CGRect(x: 26, y: 2, width: 12, height: 12)
    masked.backgroundColor = CGColor(red: 1, green: 0, blue: 1, alpha: 1)
    let mask = CALayer()
    mask.frame = CGRect(x: 0, y: 0, width: 6, height: 12)
    mask.backgroundColor = CGColor(red: 0, green: 0, blue: 0, alpha: 1)
    masked.mask = mask
    root.addSublayer(card)
    root.addSublayer(shape)
    root.addSublayer(masked)
    return root
  }

  nonisolated private static func pixels(_ draw: (CGContext) -> Void) -> [UInt8] {
    let context = CGContext(data: nil, width: 40, height: 40, bitsPerComponent: 8, bytesPerRow: 160, space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)!
    draw(context)
    return Array(UnsafeBufferPointer(start: context.data!.assumingMemoryBound(to: UInt8.self), count: 160 * 40))
  }

  @Test func `the copy leaves the original tree alone and shares no layer with it`() throws {
    let root = Self.scene()
    let before = root.sublayers?.count
    let tree = try GlassLayerCopy.tree(of: root).get()
    #expect(root.sublayers?.count == before)
    #expect(root.sublayers?[0].sublayers?.count == 1)
    #expect(root.sublayers?[2].mask != nil)
    #expect(tree.layers == 6)
    let originals = Set((root.sublayers ?? []).map(ObjectIdentifier.init))
    #expect((tree.root.sublayers ?? []).allSatisfy { !originals.contains(ObjectIdentifier($0)) })
    #expect(tree.root.sublayers?.first?.delegate == nil)
  }

  @Test func `the copy renders on another thread exactly as the original renders on main`() async throws {
    let root = Self.scene()
    let expected = Self.pixels { root.render(in: $0) }
    let tree = try GlassLayerCopy.tree(of: root).get()
    let rendered = await Task.detached { Self.pixels { tree.render(in: $0) } }.value
    let differing = (0..<1600).filter { index in (0..<4).contains { rendered[index * 4 + $0] != expected[index * 4 + $0] } }
    #expect(differing.isEmpty, "\(differing.count) pixels differ, first at \(differing.first.map { ($0 % 40, $0 / 40) } as Any): \(differing.first.map { Array(rendered[$0 * 4..<$0 * 4 + 4]) } as Any) vs \(differing.first.map { Array(expected[$0 * 4..<$0 * 4 + 4]) } as Any) samples \(differing.prefix(12).map { ($0 % 40, $0 / 40) })")
  }

  @Test func `Metal layers and hidden layers are left out`() throws {
    let root = CALayer()
    root.bounds = CGRect(x: 0, y: 0, width: 10, height: 10)
    let hidden = CALayer()
    hidden.isHidden = true
    root.addSublayer(hidden)
    root.addSublayer(CAMetalLayer())
    root.addSublayer(CALayer())
    let tree = try GlassLayerCopy.tree(of: root).get()
    #expect(tree.root.sublayers?.count == 1)
  }
}
