import ArdiaDesign
import Metal
import QuartzCore
import UIKit

@MainActor
final class GlassFrames: NSObject {
  static let shared = GlassFrames()

  private let surfaces = NSHashTable<LiquidGlassSurface>.weakObjects()
  private var link: CADisplayLink?
  private var slowTimer: Timer?
  private var captures: [ObjectIdentifier: GlassCapture] = [:]
  private var overBudget: Set<ObjectIdentifier> = []
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

  func isOverBudget(_ key: ObjectIdentifier?) -> Bool {
    key.map(overBudget.contains) ?? false
  }

  func retryBudget() {
    guard !overBudget.isEmpty else { return }
    overBudget.removeAll()
    captures.removeAll()
    for surface in surfaces.allObjects { surface.needsPath() }
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
      let timer = Timer(timeInterval: LiquidGlassRules.pageCheckInterval, repeats: true) { _ in
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
    for surface in surfaces.allObjects where surface.window != nil && surface.wantsPathChecks { surface.needsPath() }
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
    var groups: [ObjectIdentifier: (UIView, [LiquidGlassSurface])] = [:]
    var still: [LiquidGlassSurface] = []
    for surface in live {
      surface.followPresentation()
      if surface.choice.path == .live, let key = surface.captureKey, let space = GlassBackdrop.space(for: surface) {
        groups[key, default: (space, [])].1.append(surface)
      } else {
        still.append(surface)
      }
    }
    for (key, entry) in groups {
      let (space, members) = entry
      let capture = captures[key] ?? GlassCapture()
      captures[key] = capture
      var wanted = CGRect.null
      var sigma = 0.0
      var pixelsPerPoint: CGFloat = 1
      for surface in members {
        guard let region = surface.region(in: space) else { continue }
        wanted = wanted.union(region.insetBy(dx: -surface.marginPoints, dy: -surface.marginPoints))
        sigma = max(sigma, surface.blurSigma)
        pixelsPerPoint = surface.capturePixelsPerPoint
      }
      wanted = wanted.intersection(space.bounds)
      if !wanted.isNull, !wanted.isEmpty {
        let pieces: [GlassLayerPiece]
        if case .beneath(let root) = members[0].backdrop {
          pieces = GlassBackdrop.pieces(under: members[0], root: root, covering: wanted)
        } else {
          pieces = [GlassLayerPiece(view: space, rect: space.bounds, fill: nil)]
        }
        capture.survey(pieces.compactMap { $0.view?.layer }, rect: wanted)
        if capture.wants(wanted, now: now) {
          let method = GlassLaunch.capture
          let made = capture.capture(rect: wanted, pixelsPerPoint: pixelsPerPoint, sigma: sigma, method: method, into: buffer, now: now) { context in
            for piece in pieces {
              if let view = piece.view {
                GlassCapture.draw(view, in: piece.rect, method: method, context: context)
              } else if let fill = piece.fill {
                context.setFillColor(fill)
                context.fill(piece.rect)
              }
            }
          }
          if made {
            stats.noteCapture(ms: capture.lastMs, pieces: pieces.count)
            if capture.overBudget, !overBudget.contains(key) {
              overBudget.insert(key)
              PendingCounts.add(PendingCounts.glassCapturesOverBudget)
              NSLog("PAGELAB look glass capture over budget: %@ falls back to its fill until the app returns", members.map(\.label).joined(separator: ","))
              members.forEach { $0.needsPath() }
            }
          }
        }
      }
      for surface in members { surface.draw(with: capture, space: space, into: buffer) }
    }
    for surface in still { surface.draw(with: nil, space: nil, into: buffer) }
    buffer.commit()
    let known = Set(surfaces.allObjects.compactMap(\.captureKey))
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
    var pieces = 0
    var captureMs: [Double] = []
    var tickMs = 0.0
    var worstTickMs = 0.0
    var since: CFTimeInterval = 0

    mutating func note(interval: CFTimeInterval, target: CFTimeInterval) {
      frames += 1
      if interval > target * 1.5 { late += 1 }
      worstInterval = max(worstInterval, interval)
    }

    mutating func noteCapture(ms: Double, pieces: Int) {
      captures += 1
      self.pieces += pieces
      captureMs.append(ms)
    }

    mutating func noteTick(ms: Double) {
      tickMs += ms
      worstTickMs = max(worstTickMs, ms)
    }

    mutating func report(now: CFTimeInterval, surfaces: Int) -> String? {
      if since == 0 { since = now }
      guard now - since >= 1, frames > 0 else { return nil }
      let sorted = captureMs.sorted()
      let median = sorted.isEmpty ? 0 : sorted[sorted.count / 2]
      let line = String(format: "PAGELAB glass frames method=%@ surfaces=%d frames=%d late=%d worst_frame_ms=%.1f captures=%d pieces_avg=%.1f capture_ms_p50=%.2f capture_ms_max=%.2f tick_ms_avg=%.2f tick_ms_max=%.2f", GlassLaunch.capture.rawValue, surfaces, frames, late, worstInterval * 1000, captures, captures > 0 ? Double(pieces) / Double(captures) : 0, median, sorted.last ?? 0, tickMs / Double(frames), worstTickMs)
      self = FrameStats()
      since = now
      return line
    }
  }
}
