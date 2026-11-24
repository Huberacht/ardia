import ArdiaDesign
import CoreGraphics
import Testing

struct GlassChangeTests {
  @Test func `a zoom change throws away the page picture and the capture made from it`() {
    var watch = GlassZoomWatch()
    let seen = [1, 1, 2.5, 2.5, 2.4].map { watch.observe($0) }
    #expect(seen == [false, false, true, false, true], "the first look is not a change; every step of a pinch is")
  }

  @Test func `a same-document route is a new page for the glass, so the old route's picture is never used`() {
    var gate = GlassSnapshotGate()
    gate.observe(GlassPageKey(page: 1, committed: 3, route: 0))
    let asked = gate.begin(now: 0)
    let routed = gate.observe(GlassPageKey(page: 1, committed: 3, route: 1))
    #expect(routed, "pushState or a hash route, with no commit")
    #expect(!gate.accepts(token: asked, key: GlassPageKey(page: 1, committed: 3, route: 0)), "a picture asked for on the old route is refused")
    let again = gate.observe(GlassPageKey(page: 1, committed: 3, route: 1))
    #expect(!again)
  }

  @Test func `a masked view is never an opaque floor, however solid its fill`() {
    #expect(GlassStacking.coversOpaquely(isPage: false, alpha: 1, fillAlpha: 1, masked: false))
    #expect(!GlassStacking.coversOpaquely(isPage: false, alpha: 1, fillAlpha: 1, masked: true), "a mask can show only part of it")
    #expect(!GlassStacking.coversOpaquely(isPage: true, alpha: 1, fillAlpha: 1, masked: false))
    #expect(!GlassStacking.coversOpaquely(isPage: false, alpha: 0.9, fillAlpha: 1, masked: false))
  }

  @Test func `a container that doesn't clip reaches as far as its children`() {
    let container = CGRect(x: 0, y: 0, width: 400, height: 100)
    let page = CGRect(x: 0, y: 100, width: 400, height: 200)
    #expect(GlassStacking.reach(bounds: container, clips: false, children: [page]) == CGRect(x: 0, y: 0, width: 400, height: 300))
    #expect(GlassStacking.reach(bounds: container, clips: true, children: [page]) == container, "a clipping container ends at its bounds")
    #expect(GlassStacking.reach(bounds: .zero, clips: false, children: [page]) == page, "a zero-size container still holds its children")
    #expect(GlassStacking.reach(bounds: .zero, clips: false, children: []).isNull)
  }
}
