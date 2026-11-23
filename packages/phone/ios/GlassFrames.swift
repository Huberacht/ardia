import ArdiaDesign
import Metal
import QuartzCore
import UIKit
import WebKit

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
  private var flight = GlassFlight()
  private var stillsWaiting = false
  private var framing = false
  private var framedStills: [LiquidGlassSurface] = []

  var inFlight: Int { flight.inFlight }

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

  func reserve() -> Bool { flight.reserve() }

  func submit(_ buffer: MTLCommandBuffer) {
    buffer.addCompletedHandler { _ in
      DispatchQueue.main.async { MainActor.assumeIsolated { GlassFrames.shared.finished() } }
    }
    buffer.commit()
  }

  func release() { finished() }

  func drawsInThisFrame(_ surface: LiquidGlassSurface) -> Bool {
    guard framing else { return false }
    if !framedStills.contains(where: { $0 === surface }) { framedStills.append(surface) }
    return true
  }

  private func finished() {
    flight.finish()
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
    let frameMs = max(link.targetTimestamp - link.timestamp, 1.0 / 120) * 1000
    if PhoneTestBuild.isOn, lastTimestamp > 0 {
      stats.note(interval: now - lastTimestamp, target: frameMs / 1000)
    }
    lastTimestamp = now
    let live = surfaces.allObjects.filter { $0.window != nil && $0.wantsFrames }
    guard !live.isEmpty else {
      schedule()
      return
    }
    guard flight.reserve() else {
      if PhoneTestBuild.isOn { stats.dropped += 1 }
      return
    }
    guard let buffer = GlassMetal.shared.queue?.makeCommandBuffer() else {
      flight.finish()
      return
    }
    framing = true
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
      collect(capture, entry.space, entry.members, owner: entry.owner, into: buffer, now: now, frameMs: frameMs)
      for surface in entry.members {
        surface.draw(with: LiquidGlassRules.acceptsCapture(surface.choice.path) ? capture : nil, space: entry.space, into: buffer)
      }
    }
    for surface in still { surface.draw(with: nil, space: nil, into: buffer) }
    framing = false
    let stills = framedStills
    framedStills.removeAll()
    for surface in stills where surface.window != nil { surface.draw(with: nil, space: nil, into: buffer) }
    submit(buffer)
    trimCaptures(keeping: groups.values.map(\.owner))
    if PhoneTestBuild.isOn {
      stats.noteTick(ms: (CACurrentMediaTime() - started) * 1000)
      if let line = stats.report(now: now, surfaces: live.count) { NSLog("%@", line) }
    }
    schedule()
  }

  private func collect(_ capture: GlassCapture, _ space: UIView, _ members: [LiquidGlassSurface], owner: AnyObject, into buffer: MTLCommandBuffer, now: CFTimeInterval, frameMs: Double) {
    let started = CACurrentMediaTime()
    var capturedNow = false
    defer {
      let spent = (CACurrentMediaTime() - started) * 1000
      capture.noteMainThread(ms: spent, now: now, captured: capturedNow)
      if PhoneTestBuild.isOn { stats.mainMs.append(spent) }
      if capture.overBudget(now: now, frameMs: frameMs), !overBudget.contains(owner) {
        overBudget.add(owner)
        PendingCounts.add(PendingCounts.glassCapturesOverBudget)
        NSLog("PAGELAB look glass capture over budget: %@ falls back to its fill until the app returns (last %.1f ms)", members.map(\.label).joined(separator: ","), spent)
        members.forEach { $0.needsPath() }
      }
    }
    var wanted = CGRect.null
    var sigma = 0.0
    var pixelsPerPoint: CGFloat = 1
    for surface in members {
      guard let region = surface.region(in: space) else { continue }
      wanted = wanted.union(region.insetBy(dx: -surface.marginPoints, dy: -surface.marginPoints))
      sigma = max(sigma, surface.blurSigma)
      pixelsPerPoint = surface.capturePixelsPerPoint
    }
    let strip = wanted.intersection(space.bounds)
    guard !strip.isNull, !strip.isEmpty else { return }
    let method = GlassLaunch.capture
    let sourceWhole = members[0].backdropMode == .source
    let pieces: [GlassLayerPiece]
    let web: WKWebView?
    if sourceWhole {
      web = method == .auto ? GlassSources.page(in: space) : nil
      if method == .auto, web == nil, GlassSources.holdsPage(in: space) || members.contains(where: \.waitsForPage) {
        capture.showFill()
        return
      }
      wanted = web == nil ? space.bounds : strip
      pieces = GlassBackdrop.pieces(of: space, covering: wanted, web: web)
    } else if let root = members[0].backdropRoot {
      wanted = strip
      let found = method == .auto ? GlassSources.page(in: root) : nil
      web = found.flatMap { candidate in members.contains { $0.isDescendant(of: candidate) } ? nil : candidate }
      pieces = GlassBackdrop.pieces(under: members[0], root: root, covering: wanted, web: web)
    } else {
      return
    }
    let page = pieces.first { $0.page != nil }
    if let web, page != nil, capture.page.observe(web) { capture.showFill() }
    capture.survey(pieces, rect: wanted)
    if let web, page != nil { capture.page.request(web, pixelsPerPoint: pixelsPerPoint, changed: capture.isChanging, now: now) }
    guard capture.wants(wanted, now: now, gap: sourceWhole && web == nil ? LiquidGlassRules.backdropRefresh : 0) else { return }
    if let web, let page, !capture.page.covers(wanted.applying(page.transform.inverted()), of: web) {
      capture.showFill()
      return
    }
    let pieceMethod: GlassLaunch.Capture = method == .auto ? (sourceWhole && web == nil ? capture.wholeMethod : .layer) : method
    let outcome = capture.capture(rect: wanted, pixelsPerPoint: pixelsPerPoint, sigma: sigma, into: buffer, now: now) { context in
      guard method != .none, !pieces.isEmpty else { return false }
      var drew = true
      for piece in pieces where !GlassBackdrop.draw(piece, method: pieceMethod, page: capture.page, in: context) { drew = false }
      return drew
    }
    switch outcome {
    case .captured:
      capturedNow = true
      if PhoneTestBuild.isOn {
        stats.noteCapture(ms: capture.lastMs, pieces: pieces.count)
        stats.snapshotMs += capture.page.takeLatencies()
        let counts = capture.page.takeCounts()
        stats.rejected += counts.rejected
        stats.uncovered += counts.uncovered
      }
    case .failed:
      capturedNow = true
      if method == .auto, sourceWhole, web == nil, capture.wholeMethod == .layer {
        capture.wholeMethod = .hierarchy
        if PhoneTestBuild.isOn { NSLog("PAGELAB look glass %@ backdrop is blank to the layer tree; drawing its view hierarchy instead", members.map(\.label).joined(separator: ",")) }
      }
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
    var rejected = 0
    var uncovered = 0
    var mainMs: [Double] = []
    var worstInterval = 0.0
    var captures = 0
    var pieces = 0
    var captureMs: [Double] = []
    var snapshotMs: [Double] = []
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
      func fixed(_ value: Double) -> String { String(format: "%.2f", value) }
      let line = "PAGELAB glass frames method=\(GlassLaunch.capture.rawValue) surfaces=\(surfaces) frames=\(frames) late=\(late) dropped=\(dropped) worst_frame_ms=\(fixed(worstInterval * 1000)) captures=\(captures) failed=\(failed) rejected=\(rejected) uncovered=\(uncovered) main_ms_p50=\(fixed(LiquidGlassRules.median(mainMs))) main_ms_max=\(fixed(mainMs.max() ?? 0)) snapshots=\(snapshotMs.count) snapshot_ms_p50=\(fixed(LiquidGlassRules.median(snapshotMs))) pieces_avg=\(fixed(captures > 0 ? Double(pieces) / Double(captures) : 0)) capture_ms_p50=\(fixed(LiquidGlassRules.median(captureMs))) capture_ms_max=\(fixed(captureMs.max() ?? 0)) tick_ms_p50=\(fixed(LiquidGlassRules.median(tickMs))) tick_ms_max=\(fixed(tickMs.max() ?? 0))"
      self = FrameStats()
      since = now
      return line
    }
  }
}
