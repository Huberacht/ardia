import ArdiaDesign
import Metal
import QuartzCore
import UIKit

@MainActor
final class GlassFrames: NSObject {
  static let shared = GlassFrames()

  private let surfaces = NSHashTable<LiquidGlassSurface>.weakObjects()
  private let captures = NSMapTable<AnyObject, GlassCapture>.weakToStrongObjects()
  private let overBudget = NSHashTable<AnyObject>.weakObjects()
  private var link: CADisplayLink?
  private var slowTimer: Timer?
  private var stats = FrameStats()
  private var lastTimestamp: CFTimeInterval = 0
  private(set) var inFlight = 0
  private var stillsWaiting = false

  override init() {
    super.init()
    let center = NotificationCenter.default
    center.addObserver(self, selector: #selector(releaseCaptures), name: UIApplication.didEnterBackgroundNotification, object: nil)
    center.addObserver(self, selector: #selector(releaseCaptures), name: UIApplication.didReceiveMemoryWarningNotification, object: nil)
  }

  func attach(_ surface: LiquidGlassSurface) {
    surfaces.add(surface)
    GlassMetal.shared.prepare()
    schedule()
  }

  func detach(_ surface: LiquidGlassSurface) {
    surfaces.remove(surface)
    captures.removeObject(forKey: surface)
    overBudget.remove(surface)
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

  func isOverBudget(_ owner: AnyObject?) -> Bool {
    owner.map(overBudget.contains) ?? false
  }

  func retryBudget() {
    guard overBudget.count > 0 else { return }
    overBudget.removeAllObjects()
    for surface in surfaces.allObjects { surface.needsPath() }
  }

  var canSubmit: Bool { inFlight < LiquidGlassRules.framesInFlight }

  func submit(_ buffer: MTLCommandBuffer) {
    inFlight += 1
    buffer.addCompletedHandler { _ in
      DispatchQueue.main.async { MainActor.assumeIsolated { GlassFrames.shared.finished() } }
    }
    buffer.commit()
  }

  private func finished() {
    inFlight = max(inFlight - 1, 0)
    if stillsWaiting {
      stillsWaiting = false
      for surface in surfaces.allObjects where surface.window != nil && surface.stillPending { surface.drawPendingStill() }
    }
  }

  func waitForRoom() {
    stillsWaiting = true
  }

  @objc func releaseCaptures() {
    let enumerator = captures.objectEnumerator()
    while let capture = enumerator?.nextObject() as? GlassCapture { capture.release() }
    captures.removeAllObjects()
    GlassMetal.shared.flushTextures()
    for surface in surfaces.allObjects { surface.invalidate() }
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
      trimCaptures(keeping: [])
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

  private func trimCaptures(keeping owners: [AnyObject]) {
    let keys = captures.keyEnumerator().allObjects as [AnyObject]
    for key in keys where !owners.contains(where: { $0 === key }) {
      captures.object(forKey: key)?.release()
      captures.removeObject(forKey: key)
    }
    if owners.isEmpty { GlassMetal.shared.flushTextures() }
  }

  private func checkPaths() {
    for surface in surfaces.allObjects where surface.window != nil && surface.wantsPathChecks { surface.needsPath() }
    schedule()
  }

  @objc private func frame(_ link: CADisplayLink) {
    let started = CACurrentMediaTime()
    let now = link.timestamp
    if PhoneTestBuild.isOn, lastTimestamp > 0 {
      stats.note(interval: now - lastTimestamp, target: max(link.targetTimestamp - link.timestamp, 1.0 / 120))
    }
    lastTimestamp = now
    let live = surfaces.allObjects.filter { $0.window != nil && $0.wantsFrames }
    guard !live.isEmpty else {
      schedule()
      return
    }
    guard canSubmit, let buffer = GlassMetal.shared.queue?.makeCommandBuffer() else {
      if PhoneTestBuild.isOn { stats.dropped += 1 }
      return
    }
    var groups: [ObjectIdentifier: (owner: AnyObject, space: UIView, members: [LiquidGlassSurface])] = [:]
    var still: [LiquidGlassSurface] = []
    for surface in live {
      surface.followPresentation()
      if LiquidGlassRules.acceptsCapture(surface.choice.path), let owner = surface.captureOwner, let space = GlassBackdrop.space(for: surface) {
        groups[ObjectIdentifier(owner), default: (owner, space, [])].members.append(surface)
      } else {
        still.append(surface)
      }
    }
    for entry in groups.values {
      let capture = captures.object(forKey: entry.owner) ?? GlassCapture()
      captures.setObject(capture, forKey: entry.owner)
      collect(capture, entry.space, entry.members, owner: entry.owner, into: buffer, now: now)
      for surface in entry.members {
        if LiquidGlassRules.acceptsCapture(surface.choice.path) {
          surface.draw(with: capture, space: entry.space, into: buffer)
        } else {
          surface.draw(with: nil, space: nil, into: buffer)
        }
      }
    }
    for surface in still { surface.draw(with: nil, space: nil, into: buffer) }
    submit(buffer)
    trimCaptures(keeping: groups.values.map(\.owner))
    if PhoneTestBuild.isOn {
      stats.noteTick(ms: (CACurrentMediaTime() - started) * 1000)
      if let line = stats.report(now: now, surfaces: live.count) { NSLog("%@", line) }
    }
    schedule()
  }

  private func collect(_ capture: GlassCapture, _ space: UIView, _ members: [LiquidGlassSurface], owner: AnyObject, into buffer: MTLCommandBuffer, now: CFTimeInterval) {
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
    guard !wanted.isNull, !wanted.isEmpty else { return }
    let pieces: [GlassLayerPiece]
    if members[0].backdropMode == .beneath, let root = members[0].backdropRoot {
      pieces = GlassBackdrop.pieces(under: members[0], root: root, covering: wanted)
    } else {
      pieces = [GlassLayerPiece(view: space, transform: .identity, bounds: space.bounds, radius: 0, fill: nil, alpha: 1, clips: [])]
    }
    capture.survey(pieces, rect: wanted)
    guard capture.wants(wanted, now: now) else { return }
    let method = GlassLaunch.capture
    let outcome = capture.capture(rect: wanted, pixelsPerPoint: pixelsPerPoint, sigma: sigma, into: buffer, now: now) { context in
      guard method != .none, !pieces.isEmpty else { return false }
      var drew = true
      for piece in pieces where !GlassBackdrop.draw(piece, method: method, in: context) { drew = false }
      return drew
    }
    switch outcome {
    case .captured:
      if PhoneTestBuild.isOn { stats.noteCapture(ms: capture.lastMs, pieces: pieces.count) }
      if capture.overBudget, !overBudget.contains(owner) {
        overBudget.add(owner)
        PendingCounts.add(PendingCounts.glassCapturesOverBudget)
        NSLog("PAGELAB look glass capture over budget: %@ falls back to its fill until the app returns", members.map(\.label).joined(separator: ","))
        members.forEach { $0.needsPath() }
      }
    case .failed:
      if PhoneTestBuild.isOn {
        stats.failed += 1
        if capture.failures == 1 { NSLog("PAGELAB look glass capture failed: %@ shows its fill and tries again", members.map(\.label).joined(separator: ",")) }
      }
    case .waiting:
      break
    }
  }

  struct FrameStats {
    var frames = 0
    var late = 0
    var dropped = 0
    var failed = 0
    var worstInterval = 0.0
    var captures = 0
    var pieces = 0
    var captureMs: [Double] = []
    var tickMs: [Double] = []
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
      tickMs.append(ms)
    }

    mutating func report(now: CFTimeInterval, surfaces: Int) -> String? {
      if since == 0 { since = now }
      guard now - since >= 1, frames > 0 else { return nil }
      let line = String(format: "PAGELAB glass frames method=%@ surfaces=%d frames=%d late=%d dropped=%d worst_frame_ms=%.1f captures=%d failed=%d pieces_avg=%.1f capture_ms_p50=%.2f capture_ms_max=%.2f tick_ms_p50=%.2f tick_ms_max=%.2f", GlassLaunch.capture.rawValue, surfaces, frames, late, dropped, worstInterval * 1000, captures, failed, captures > 0 ? Double(pieces) / Double(captures) : 0, LiquidGlassRules.median(captureMs), captureMs.max() ?? 0, LiquidGlassRules.median(tickMs), tickMs.max() ?? 0)
      self = FrameStats()
      since = now
      return line
    }
  }
}
