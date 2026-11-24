import ArdiaDesign
import ObjectiveC
import UIKit
import WebKit

@MainActor
enum ScrollBounceGuard {
  private static var installed = false

  static func install() {
    guard !installed else { return }
    installed = true
    swap(#selector(UIScrollView.didMoveToWindow), #selector(UIScrollView.ardiaBounceDidMoveToWindow))
    swap(#selector(setter: UIScrollView.bounces), #selector(UIScrollView.ardiaSetBounces(_:)))
    swap(#selector(setter: UIScrollView.alwaysBounceVertical), #selector(UIScrollView.ardiaSetAlwaysBounceVertical(_:)))
    swap(#selector(setter: UIScrollView.alwaysBounceHorizontal), #selector(UIScrollView.ardiaSetAlwaysBounceHorizontal(_:)))
    swap(#selector(setter: UIScrollView.refreshControl), #selector(UIScrollView.ardiaSetRefreshControl(_:)))
  }

  private static func swap(_ original: Selector, _ replacement: Selector) {
    let type: AnyClass = UIScrollView.self
    guard let from = class_getInstanceMethod(type, original), let to = class_getInstanceMethod(type, replacement) else { return }
    if class_addMethod(type, original, method_getImplementation(to), method_getTypeEncoding(to)) {
      class_replaceMethod(type, replacement, method_getImplementation(from), method_getTypeEncoding(from))
    } else {
      method_exchangeImplementations(from, to)
    }
  }
}

extension UIScrollView {
  var keepsBounce: Bool {
    ScrollBounceRule.keepsBounce(className: NSStringFromClass(type(of: self)), refreshes: refreshControl != nil, insideWebPage: insideWebPage)
  }

  private var insideWebPage: Bool {
    var view = superview
    while let next = view {
      if next is WKWebView { return true }
      view = next.superview
    }
    return false
  }

  @objc func ardiaBounceDidMoveToWindow() {
    ardiaBounceDidMoveToWindow()
    guard window != nil, !keepsBounce else { return }
    if bounces { ardiaSetBounces(false) }
    if alwaysBounceVertical { ardiaSetAlwaysBounceVertical(false) }
    if alwaysBounceHorizontal { ardiaSetAlwaysBounceHorizontal(false) }
  }

  @objc func ardiaSetRefreshControl(_ control: UIRefreshControl?) {
    ardiaSetRefreshControl(control)
    guard control != nil else { return }
    ardiaSetBounces(true)
    ardiaSetAlwaysBounceVertical(true)
  }

  @objc func ardiaSetBounces(_ value: Bool) {
    ardiaSetBounces(ScrollBounceRule.bounces(wanted: value, keeps: window == nil || keepsBounce))
  }

  @objc func ardiaSetAlwaysBounceVertical(_ value: Bool) {
    ardiaSetAlwaysBounceVertical(ScrollBounceRule.bounces(wanted: value, keeps: window == nil || keepsBounce))
  }

  @objc func ardiaSetAlwaysBounceHorizontal(_ value: Bool) {
    ardiaSetAlwaysBounceHorizontal(ScrollBounceRule.bounces(wanted: value, keeps: window == nil || keepsBounce))
  }
}
