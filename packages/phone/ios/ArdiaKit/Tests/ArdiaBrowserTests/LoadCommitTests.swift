import Foundation
import Testing
@testable import ArdiaBrowser

@Suite struct LoadCommitTests {
  @Test func `a load that starts has not committed until WebKit commits it`() {
    #expect(!PageLoadCommit.after(loading: true, wasLoading: false, committed: true))
    #expect(!PageLoadCommit.after(loading: true, wasLoading: true, committed: false))
    #expect(PageLoadCommit.after(loading: true, wasLoading: true, committed: true), "the commit came during the load")
  }

  @Test func `a load that stops or fails before it commits leaves the page it was showing committed`() {
    #expect(PageLoadCommit.after(loading: false, wasLoading: true, committed: false))
    #expect(PageLoadCommit.after(loading: false, wasLoading: false, committed: true))
  }
}
