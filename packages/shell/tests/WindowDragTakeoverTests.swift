import XCTest
@testable import ArdiaUpdaterCore

final class WindowDragTakeoverTests: XCTestCase {
  func testARefusedDragStillHeldIsTakenOver() {
    XCTAssertTrue(WindowDragTakeover.takesOver(pressedAt: 100, lastDownAt: 100, held: true))
  }

  func testADragEndedAtTheReleaseStaysWithMacOS() {
    XCTAssertFalse(WindowDragTakeover.takesOver(pressedAt: 100, lastDownAt: 100, held: false))
  }

  func testALateCompletionNeverTakesTheNextPress() {
    let firstPress: TimeInterval = 100, secondPress: TimeInterval = 100.4
    XCTAssertFalse(WindowDragTakeover.takesOver(pressedAt: firstPress, lastDownAt: secondPress, held: true))
    XCTAssertTrue(WindowDragTakeover.takesOver(pressedAt: secondPress, lastDownAt: secondPress, held: true))
  }

  func testTheSamePressReadByTheHardwareClockAFewMillisecondsLaterStillCounts() {
    XCTAssertTrue(WindowDragTakeover.takesOver(pressedAt: 100, lastDownAt: 100.004, held: true))
    XCTAssertFalse(WindowDragTakeover.takesOver(pressedAt: 100, lastDownAt: 100 + WindowDragTakeover.samePress + 0.001, held: true))
  }

  func testAPressPostedByTheAppItselfIsNewerThanTheLastHardwarePress() {
    XCTAssertTrue(WindowDragTakeover.takesOver(pressedAt: 200, lastDownAt: 150, held: true))
    XCTAssertTrue(WindowDragTakeover.takesOver(pressedAt: 200, lastDownAt: nil, held: true))
  }

  func testANewPressDuringTheHopToTheLoopEndsTheTakeover() {
    XCTAssertTrue(WindowDragTakeover.pressIsLatest(pressedAt: 100, lastDownAt: 100))
    XCTAssertFalse(WindowDragTakeover.pressIsLatest(pressedAt: 100, lastDownAt: 100.2))
  }
}
