import ArdiaBrowser
import CryptoKit
import ExpoModulesCore
import Foundation
import Observation
import os
import SwiftData
import UIKit
import WebKit

enum PageSnapshots {
  static var saved: URL { URL.applicationSupportDirectory.appending(path: "PageSnapshots", directoryHint: .isDirectory) }
  static var privateFolder: URL { URL.cachesDirectory.appending(path: "PrivatePageSnapshots", directoryHint: .isDirectory) }

  struct HeldImage: @unchecked Sendable {
    let image: UIImage
  }

  struct Written: Sendable {
    let path: String
    let uri: String
    let width: Int
    let height: Int
    let bytes: Int
    let ticket: Int

    var payload: [String: Any] {
      ["path": path, "uri": uri, "width": width, "height": height, "route": "draw", "bytes": bytes, "generation": ticket]
    }
  }

  private static let tickets = OSAllocatedUnfairLock<Int>(initialState: 0)

  static func nextTicket() -> Int {
    tickets.withLock { last in
      last += 1
      return last
    }
  }

  static func write(_ pageID: String, image: UIImage, isPrivate: Bool, quality: Int, ticket: Int, priority: TaskPriority = .userInitiated) async -> [String: Any]? {
    let width = Int((image.size.width * image.scale).rounded())
    let height = Int((image.size.height * image.scale).rounded())
    let compression = CGFloat(min(max(quality, 1), 100)) / 100
    let held = HeldImage(image: image)
    let encoded = await Task.detached(priority: priority) { held.image.jpegData(compressionQuality: compression) }.value
    guard let encoded else { return nil }
    let written = await SnapshotFiles.shared.publish(pageID, data: encoded, isPrivate: isPrivate, width: width, height: height, ticket: ticket)
    return written?.payload
  }

  static func delete(_ pageID: String) {
    let ticket = nextTicket()
    Task { await SnapshotFiles.shared.delete(pageID, ticket: ticket) }
  }

  static func endPrivateBrowsing() {
    let ticket = nextTicket()
    Task { await SnapshotFiles.shared.endPrivateBrowsing(ticket: ticket) }
  }

  static func stamp(of file: URL, stem: String) -> Int {
    let name = file.deletingPathExtension().lastPathComponent
    return Int(name.dropFirst(stem.count + 1)) ?? 0
  }

  static func filesOf(_ pageID: String, in folder: URL) -> [URL] {
    older(in: folder, stem: fileStem(pageID))
  }

  static func older(in folder: URL, stem: String) -> [URL] {
    let files = (try? FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? []
    return files.filter { $0.lastPathComponent.hasPrefix("\(stem)-") && $0.pathExtension == "jpg" }
  }

  @MainActor
  static func isOnScreen(_ view: UIView) -> Bool {
    guard let window = view.window, !window.isHidden else { return false }
    var current: UIView? = view
    while let shown = current {
      if shown.isHidden || shown.alpha < 0.01 { return false }
      current = shown.superview
    }
    return view.convert(view.bounds, to: window).intersects(window.bounds)
  }

  static let screenCopyScale: CGFloat = 2

  @MainActor
  static func screenCopy(of view: UIView, width: CGFloat) -> UIImage? {
    guard view.bounds.width > 0, width > 0 else { return nil }
    let format = UIGraphicsImageRendererFormat()
    format.scale = screenCopyScale * width / view.bounds.width
    format.opaque = true
    var drawn = false
    let image = UIGraphicsImageRenderer(bounds: view.bounds, format: format).image { _ in
      drawn = view.drawHierarchy(in: view.bounds, afterScreenUpdates: false)
    }
    return drawn ? image : nil
  }

  static let flatSample = 16
  static let flatSpread = 3

  static func isFlatAwayFromMain(_ image: UIImage) async -> Bool {
    let held = HeldImage(image: image)
    return await Task.detached(priority: .utility) { PageSnapshots.isFlat(held.image) }.value
  }

  static func isFlat(_ image: UIImage) -> Bool {
    guard let cgImage = image.cgImage else { return false }
    let side = flatSample
    var pixels = [UInt8](repeating: 0, count: side * side * 4)
    let drawn = pixels.withUnsafeMutableBytes { buffer -> Bool in
      guard let context = CGContext(data: buffer.baseAddress, width: side, height: side, bitsPerComponent: 8, bytesPerRow: side * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return false }
      context.interpolationQuality = .medium
      context.draw(cgImage, in: CGRect(x: 0, y: 0, width: side, height: side))
      return true
    }
    guard drawn else { return false }
    for channel in 0..<3 {
      var low = UInt8.max
      var high = UInt8.min
      for at in stride(from: channel, to: pixels.count, by: 4) {
        low = min(low, pixels[at])
        high = max(high, pixels[at])
      }
      if Int(high) - Int(low) > flatSpread { return false }
    }
    return true
  }

  static func fileStem(_ pageID: String) -> String {
    if pageID.count <= 64, pageID.allSatisfy({ $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "_") }) { return pageID }
    return SHA256.hash(data: Data(pageID.utf8)).prefix(16).map { String(format: "%02x", $0) }.joined()
  }
}

actor SnapshotFiles {
  static let shared = SnapshotFiles()

  private var newestTicket: [String: Int] = [:]
  private var privateEndedAt = 0
  private var lastStamp = 0

  func publish(_ pageID: String, data: Data, isPrivate: Bool, width: Int, height: Int, ticket: Int) -> PageSnapshots.Written? {
    guard ticket > (newestTicket[pageID] ?? 0) else { return nil }
    guard !isPrivate || ticket > privateEndedAt else { return nil }
    let folder = isPrivate ? PageSnapshots.privateFolder : PageSnapshots.saved
    let stem = PageSnapshots.fileStem(pageID)
    let manager = FileManager.default
    guard (try? manager.createDirectory(at: folder, withIntermediateDirectories: true)) != nil else { return nil }
    let stamp = max(Int(Date.now.timeIntervalSince1970 * 1000), lastStamp + 1)
    lastStamp = stamp
    let target = folder.appending(path: "\(stem)-\(stamp).jpg")
    guard (try? data.write(to: target, options: .atomic)) != nil else { return nil }
    newestTicket[pageID] = ticket
    let others = PageSnapshots.older(in: folder, stem: stem).filter { $0 != target }
    let previous = others.max { PageSnapshots.stamp(of: $0, stem: stem) < PageSnapshots.stamp(of: $1, stem: stem) }
    for old in others where old != previous { try? manager.removeItem(at: old) }
    return PageSnapshots.Written(path: target.path(percentEncoded: false), uri: target.absoluteString, width: width, height: height, bytes: data.count, ticket: ticket)
  }

  func delete(_ pageID: String, ticket: Int) {
    newestTicket[pageID] = max(newestTicket[pageID] ?? 0, ticket)
    for folder in [PageSnapshots.saved, PageSnapshots.privateFolder] {
      for file in PageSnapshots.filesOf(pageID, in: folder) { try? FileManager.default.removeItem(at: file) }
    }
  }

  func endPrivateBrowsing(ticket: Int) {
    privateEndedAt = max(privateEndedAt, ticket)
    try? FileManager.default.removeItem(at: PageSnapshots.privateFolder)
  }
}

@MainActor
enum OffscreenCapture {
  static let loadTimeout: Duration = .seconds(10)
  static let settleDelay: Duration = .milliseconds(700)

  static func capture(url: String, pageID: String, blocker: ContentBlocker) async -> [String: Any?]? {
    guard let target = URL(string: url), BrowserURL.isSyncable(url) else { return nil }
    await blocker.prepare()
    guard let window = keyWindow() else { return nil }
    let configuration = WKWebViewConfiguration()
    configuration.websiteDataStore = .nonPersistent()
    blocker.install(on: configuration.userContentController, counter: BlockedResourceCounter())
    let size = window.bounds.size
    let webView = WKWebView(frame: CGRect(x: -size.width * 2, y: 0, width: size.width, height: size.height), configuration: configuration)
    webView.isUserInteractionEnabled = false
    window.insertSubview(webView, at: 0)
    defer { webView.removeFromSuperview() }
    webView.load(URLRequest(url: target))
    let start = ContinuousClock.now
    try? await Task.sleep(for: .milliseconds(500))
    while webView.isLoading, ContinuousClock.now - start < loadTimeout {
      try? await Task.sleep(for: .milliseconds(200))
    }
    try? await Task.sleep(for: settleDelay)
    let snapshot = WKSnapshotConfiguration()
    snapshot.snapshotWidth = NSNumber(value: Double(min(size.width, TabSnapshotStore.pointWidth)))
    guard let image = try? await webView.takeSnapshot(configuration: snapshot) else { return nil }
    let theme = webView.themeColor.flatMap(hex)
    let title = webView.title
    guard let written = await PageSnapshots.write(pageID, image: image, isPrivate: false, quality: 82, ticket: PageSnapshots.nextTicket()) else { return nil }
    return ["fileName": written["uri"] ?? nil, "path": written["path"] ?? nil, "title": (title?.isEmpty == false) ? title : nil, "themeColorHex": theme]
  }

  private static func keyWindow() -> UIWindow? {
    let windows = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
    return windows.first { $0.isKeyWindow } ?? windows.first
  }

  private static func hex(_ color: UIColor) -> String? {
    var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
    guard color.getRed(&red, green: &green, blue: &blue, alpha: &alpha), alpha > 0.5 else { return nil }
    func byte(_ value: CGFloat) -> Int { Int((min(max(value, 0), 1) * 255).rounded()) }
    return String(format: "#%02X%02X%02X", byte(red), byte(green), byte(blue))
  }
}
