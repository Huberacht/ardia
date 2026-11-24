import ArdiaDesign
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
}
