import AppKit
import ExpoModulesCore

public final class InlineCompletionModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ArdiaInlineCompletion")

    AsyncFunction("complete") { (tag: Int, typed: String, completion: String) -> Int in
      guard let host = self.appContext?.findView(withTag: tag, ofType: NSView.self),
            let field = textField(in: host),
            let editor = field.currentEditor() as? NSTextView,
            !editor.hasMarkedText()
      else { return 0 }
      let text = editor.string as NSString
      let typedLength = (typed as NSString).length
      let selection = editor.selectedRange()
      guard text.length >= typedLength, text.substring(to: typedLength) == typed,
            selection.location == typedLength, NSMaxRange(selection) == text.length
      else { return 0 }
      let tail = NSRange(location: typedLength, length: text.length - typedLength)
      var result = 1
      if text.substring(with: tail) != completion {
        guard editor.shouldChangeText(in: tail, replacementString: completion) else { return 0 }
        editor.replaceCharacters(in: tail, with: completion)
        editor.didChangeText()
        result = 2
      }
      editor.setSelectedRange(NSRange(location: typedLength, length: (completion as NSString).length))
      editor.scrollRangeToVisible(NSRange(location: 0, length: 0))
      editor.scrollRangeToVisible(NSRange(location: typedLength, length: 0))
      InlineKeep.arm(editor, tag: tag, typedLength: typedLength, keeps: InlineKeep.fields.contains(tag) && !completion.isEmpty)
      return result
    }.runOnQueue(.main)

    AsyncFunction("keepWhileTyping") { (tag: Int, on: Bool) in
      InlineKeep.install()
      if on { InlineKeep.fields.insert(tag) } else { InlineKeep.release(tag: tag) }
    }.runOnQueue(.main)

    Function("takeKept") { (tag: Int, start: Int, end: Int) -> [String] in
      InlineKeep.take(tag: tag, start: start, end: end)
    }

    AsyncFunction("copyFieldAs") { (shown: String?, url: String?) in
      FieldCopy.target = shown.flatMap { shown in url.map { (shown, $0) } }
    }.runOnQueue(.main)
  }
}

enum FieldCopy {
  static var target: (shown: String, url: String)?

  static func url(for responder: NSResponder?) -> String? {
    guard let target, let editor = responder as? NSTextView, !editor.hasMarkedText(), editor.string == target.shown,
          editor.selectedRange() == NSRange(location: 0, length: (editor.string as NSString).length)
    else { return nil }
    return target.url
  }
}

private func textField(in view: NSView) -> NSTextField? {
  if let field = view as? NSTextField { return field }
  for sub in view.subviews {
    if let field = textField(in: sub) { return field }
  }
  return nil
}

enum InlineKeep {
  static var fields = Set<Int>()
  private static weak var editor: NSTextView?
  private static var tag = 0
  private static var typedLength = 0
  private static var text = ""
  private static let lock = NSLock()
  private static var kept: [(tag: Int, typed: String, completion: String)] = []
  private static var installed = false

  static func take(tag: Int, start: Int, end: Int) -> [String] {
    lock.lock()
    defer { lock.unlock() }
    let length = { (text: String) in (text as NSString).length }
    guard let at = kept.firstIndex(where: { $0.tag == tag && length($0.typed) == start && length($0.typed) + length($0.completion) == end }) else { return [] }
    let found = kept[at]
    kept = kept.enumerated().filter { $0.offset > at || $0.element.tag != tag }.map(\.element)
    return [found.typed, found.completion]
  }

  private static func noteKept(_ value: (tag: Int, typed: String, completion: String)) {
    lock.lock()
    kept.append(value)
    lock.unlock()
  }

  private static func forget(tag fieldTag: Int) {
    lock.lock()
    kept.removeAll { $0.tag == fieldTag }
    lock.unlock()
  }

  static func release(tag fieldTag: Int) {
    fields.remove(fieldTag)
    forget(tag: fieldTag)
    if fieldTag == tag { editor = nil }
  }

  static func arm(_ field: NSTextView, tag fieldTag: Int, typedLength length: Int, keeps: Bool) {
    forget(tag: fieldTag)
    editor = keeps ? field : nil
    tag = fieldTag
    typedLength = length
    text = field.string
  }

  static func keeps(_ field: NSTextView, inserting value: Any, at replacement: NSRange) -> Bool {
    guard field === editor, replacement.location == NSNotFound, !field.hasMarkedText(), field.string == text else { return false }
    guard let typed = (value as? String) ?? (value as? NSAttributedString)?.string, !typed.isEmpty,
          typed.rangeOfCharacter(from: .whitespacesAndNewlines) == nil
    else { return false }
    let whole = field.string as NSString
    let selection = field.selectedRange()
    let typedCount = (typed as NSString).length
    guard selection.location == typedLength, NSMaxRange(selection) == whole.length, selection.length > typedCount,
          whole.substring(with: NSRange(location: typedLength, length: typedCount)) == typed
    else { return false }
    typedLength += typedCount
    noteKept((tag, whole.substring(to: typedLength), whole.substring(from: typedLength)))
    field.setSelectedRange(NSRange(location: typedLength, length: whole.length - typedLength))
    return true
  }

  static func install() {
    guard !installed, let editorClass = NSClassFromString("RCTUIPlainPasteFieldEditor") else { return }
    installed = true
    let insert = #selector(NSTextView.insertText(_:replacementRange:))
    guard let method = class_getInstanceMethod(editorClass, insert) else { return }
    typealias Insert = @convention(c) (NSTextView, Selector, AnyObject, NSRange) -> Void
    let original = unsafeBitCast(method_getImplementation(method), to: Insert.self)
    let kept: @convention(block) (NSTextView, AnyObject, NSRange) -> Void = { field, value, replacement in
      if keeps(field, inserting: value, at: replacement) { return }
      original(field, insert, value, replacement)
    }
    class_replaceMethod(editorClass, insert, imp_implementationWithBlock(kept), method_getTypeEncoding(method))
  }
}
