import ArdiaDesign
import Testing

struct ScrollBounceRuleTests {
  @Test func `the app's own lists, sheets, menus and Settings forms never bounce`() {
    for name in ["RCTEnhancedScrollView", "UICollectionView", "UITableView", "UIScrollView", "_UICollectionViewListLayoutSectionScrollView", "UITextView"] {
      #expect(!ScrollBounceRule.keepsBounce(className: name, refreshes: false, insideWebPage: false), "\(name)")
      #expect(!ScrollBounceRule.bounces(wanted: true, keeps: false))
    }
  }

  @Test func `the web page keeps its bounce, and so do its own scrolling boxes`() {
    #expect(ScrollBounceRule.keepsBounce(className: "WKScrollView", refreshes: false, insideWebPage: true))
    #expect(ScrollBounceRule.keepsBounce(className: "WKChildScrollView", refreshes: false, insideWebPage: false))
    #expect(ScrollBounceRule.keepsBounce(className: "UIScrollView", refreshes: false, insideWebPage: true))
  }

  @Test func `pull to refresh and the system's wheels and keyboard keep theirs`() {
    #expect(ScrollBounceRule.keepsBounce(className: "RCTEnhancedScrollView", refreshes: true, insideWebPage: false))
    #expect(ScrollBounceRule.keepsBounce(className: "UIPickerTableView", refreshes: false, insideWebPage: false))
    #expect(ScrollBounceRule.keepsBounce(className: "_UIDatePickerCalendarMonthView", refreshes: false, insideWebPage: false))
    #expect(ScrollBounceRule.bounces(wanted: true, keeps: true))
    #expect(!ScrollBounceRule.bounces(wanted: false, keeps: true))
  }
}
