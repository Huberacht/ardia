import ArdiaDesign
import CoreGraphics
import Testing

struct GlassMotionHoldTests {
  let screen = CGRect(x: 0, y: 0, width: 402, height: 874)

  @Test func `a card growing or a page sliding under the glass holds every capture until it has been still a moment`() {
    var hold = GlassMotionHold()
    let moved1 = hold.observe([screen], in: screen, now: 0)
    #expect(!moved1, "the first look is no motion")
    #expect(!hold.holds(now: 0))
    let card = CGRect(x: 40, y: 120, width: 320, height: 600)
    let moved2 = hold.observe([card], in: screen, now: 1)
    #expect(moved2)
    #expect(hold.holds(now: 1 + GlassMotionHold.quiet - 0.01))
    let moved3 = hold.observe([card.insetBy(dx: -20, dy: -20)], in: screen, now: 1.1)
    #expect(moved3, "still growing")
    #expect(hold.holds(now: 1.2))
    let moved4 = hold.observe([card.insetBy(dx: -20, dy: -20)], in: screen, now: 1.15)
    #expect(!moved4)
    #expect(!hold.holds(now: 1.1 + GlassMotionHold.quiet), "idle once it stops")
  }

  @Test func `a thin loading line or a toast moving under the glass is no transition`() {
    var hold = GlassMotionHold()
    hold.observe([screen, CGRect(x: 0, y: 800, width: 100, height: 3)], in: screen, now: 0)
    let moved5 = hold.observe([screen, CGRect(x: 0, y: 800, width: 300, height: 3)], in: screen, now: 0.1)
    #expect(!moved5)
    let moved6 = hold.observe([screen, CGRect(x: 20, y: 760, width: 360, height: 44)], in: screen, now: 0.2)
    #expect(!moved6)
    let moved7 = hold.observe([screen.offsetBy(dx: 0.3, dy: 0)], in: screen, now: 0.3)
    #expect(!moved7, "subpixel settling")
  }

  @Test func `an arriving tab holds for the arrival, and later commits or routes on it never shorten that`() {
    var hold = GlassMotionHold()
    hold.observe([screen], in: screen, now: 0)
    hold.arrive(now: 10)
    #expect(hold.holds(now: 10 + GlassMotionHold.arrival - 0.01))
    hold.arrive(now: 10.05)
    hold.observe([screen], in: screen, now: 10.1)
    #expect(hold.holds(now: 10.3), "a commit or route change in between keeps the hold")
    #expect(!hold.holds(now: 10.05 + GlassMotionHold.arrival))
  }

  @Test func `the arrival hold covers the card and pager springs`() {
    #expect(GlassMotionHold.arrival >= 0.3 && GlassMotionHold.arrival <= 0.5)
    #expect(GlassMotionHold.quiet >= 0.08 && GlassMotionHold.quiet <= 0.2)
  }
}
