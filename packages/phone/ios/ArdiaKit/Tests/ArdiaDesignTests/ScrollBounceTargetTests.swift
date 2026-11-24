import ArdiaDesign
import CoreGraphics
import Testing

struct ScrollBounceTargetTests {
  let form = CGRect(x: 0, y: 62, width: 402, height: 812)

  @Test func `only the form's own scroll view, the one exactly behind it, is turned off`() {
    #expect(ScrollBounceTarget.matches(className: "UICollectionView", frame: form, mine: form))
    #expect(ScrollBounceTarget.matches(className: "UICollectionView", frame: form.offsetBy(dx: 0, dy: 1.5), mine: form))
    #expect(!ScrollBounceTarget.matches(className: "UICollectionView", frame: CGRect(x: 0, y: 0, width: 402, height: 874), mine: form), "a larger list around it")
    #expect(!ScrollBounceTarget.matches(className: "UITextView", frame: CGRect(x: 16, y: 300, width: 370, height: 120), mine: form), "a text view inside it")
  }

  @Test func `a web page, an empty form or an empty scroll view is never the target`() {
    #expect(!ScrollBounceTarget.matches(className: "WKScrollView", frame: form, mine: form))
    #expect(!ScrollBounceTarget.matches(className: "UICollectionView", frame: .zero, mine: form))
    #expect(!ScrollBounceTarget.matches(className: "UICollectionView", frame: form, mine: .zero))
  }
}
