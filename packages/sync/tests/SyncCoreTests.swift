import Foundation
import XCTest
@testable import ArdiaSyncCore

final class RecoveryPhraseTests: XCTestCase {
  func testReferenceVectors() throws {
    let vectors: [(UInt8, String)] = [
      (0x00, Array(repeating: "abandon", count: 23).joined(separator: " ") + " art"),
      (0x7f, "legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth useful legal winner thank year wave sausage worth title"),
      (0x80, "letter advice cage absurd amount doctor acoustic avoid letter advice cage absurd amount doctor acoustic avoid letter advice cage absurd amount doctor acoustic bless"),
      (0xff, Array(repeating: "zoo", count: 23).joined(separator: " ") + " vote"),
    ]
    for (byte, phrase) in vectors {
      let entropy = Data(repeating: byte, count: 32)
      XCTAssertEqual(RecoveryPhrase.words(for: entropy).joined(separator: " "), phrase)
      XCTAssertEqual(try RecoveryPhrase.entropy(from: phrase), entropy)
    }
  }

  func testProblemsNameWhatTheUserTyped() {
    let words = RecoveryPhrase.words(for: Data(repeating: 0x7f, count: 32))
    func problem(_ text: String) -> RecoveryPhrase.Problem? {
      do {
        _ = try RecoveryPhrase.entropy(from: text)
        return nil
      } catch {
        return error as? RecoveryPhrase.Problem
      }
    }
    var typo = words
    typo[5] = "Sausagr"
    XCTAssertEqual(problem("  " + typo.joined(separator: ",  ") + "\n"), .unknownWord("sausagr"))
    var first = words
    first[0] = "zzzz"
    first[9] = "qqqq"
    XCTAssertEqual(problem(first.joined(separator: " ")), .unknownWord("zzzz"))
    XCTAssertEqual(problem(words.dropLast().joined(separator: " ")), .wordCount(23))
    XCTAssertEqual(problem(""), .wordCount(0))
    XCTAssertEqual(problem(Array(repeating: "zoo", count: 24).joined(separator: " ")), .checksum)
    XCTAssertEqual(problem(String(repeating: "abandon ", count: 600)), .wordCount(600))
    XCTAssertEqual(problem(words.map { String($0.prefix(4)) }.joined(separator: " ")), nil)
  }
}

final class SyncCryptoTests: XCTestCase {
  let keys = SyncKeys(entropy: RecoveryPhrase.generateEntropy())

  func testTamperingIsDetected() throws {
    let sealed = try keys.seal(Data("bookmark".utf8), scopeTag: "s", fileId: "f")
    for index in [4, 10, 16, 40, sealed.count - 1] {
      var bad = sealed
      bad[index] ^= 0x01
      XCTAssertThrowsError(try keys.open(bad, scopeTag: "s", fileId: "f")) { XCTAssertEqual($0 as? SyncKeys.Failure, .authentication) }
    }
    XCTAssertThrowsError(try keys.open(sealed.prefix(sealed.count / 2), scopeTag: "s", fileId: "f"))
    XCTAssertThrowsError(try keys.open(sealed.prefix(10), scopeTag: "s", fileId: "f")) { XCTAssertEqual($0 as? SyncKeys.Failure, .format) }
    XCTAssertThrowsError(try keys.open(Data(), scopeTag: "s", fileId: "f")) { XCTAssertEqual($0 as? SyncKeys.Failure, .format) }
    XCTAssertThrowsError(try keys.open(sealed, scopeTag: "s", fileId: "g")) { XCTAssertEqual($0 as? SyncKeys.Failure, .authentication) }
    XCTAssertThrowsError(try keys.open(sealed, scopeTag: "t", fileId: "f")) { XCTAssertEqual($0 as? SyncKeys.Failure, .authentication) }
  }

  func testWrongPhraseCantOpen() throws {
    let sealed = try keys.seal(Data("bookmark".utf8), scopeTag: "s", fileId: "f")
    let other = SyncKeys(entropy: RecoveryPhrase.generateEntropy())
    XCTAssertThrowsError(try other.open(sealed, scopeTag: "s", fileId: "f")) { XCTAssertEqual($0 as? SyncKeys.Failure, .authentication) }
    XCTAssertNotEqual(other.chainTag, keys.chainTag)
  }

  func testOpenFailuresAreCountedByCode() throws {
    _ = SyncKeys.takeOpenFailures()
    let sealed = try keys.seal(Data("bookmark".utf8), scopeTag: "s", fileId: "f")
    _ = try? keys.open(sealed, scopeTag: "s", fileId: "g")
    _ = try? keys.open(sealed, scopeTag: "t", fileId: "f")
    _ = try? keys.open(Data(), scopeTag: "s", fileId: "f")
    XCTAssertEqual(try keys.open(sealed, scopeTag: "s", fileId: "f"), Data("bookmark".utf8))
    XCTAssertEqual(SyncKeys.takeOpenFailures(), ["authentication": 2, "format": 1])
    XCTAssertEqual(SyncKeys.takeOpenFailures(), [:])
  }
}

final class SyncVaultTests: XCTestCase {
  var folder: URL!
  let entropy = RecoveryPhrase.generateEntropy()
  var vault: SyncVault!

  override func setUpWithError() throws {
    folder = FileManager.default.temporaryDirectory.appendingPathComponent("ac-sync-tests-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    vault = SyncVault(folder: folder, keys: SyncKeys(entropy: entropy))
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(at: folder)
  }

  func testFolderHoldsNoPlaintext() throws {
    let keys = SyncKeys(entropy: Data(repeating: 0, count: 30) + Data([4, 84]))
    XCTAssertEqual(keys.chainTag, "6happ6iw6rqt67wxcfun6lltsi")
    vault = SyncVault(folder: folder, keys: keys)
    try vault.createChain()
    let secrets = ["https://secret-bank.example/login", "Quarterly Plans", "hunter2-password", "alice@example.com"]
    let payload = try JSONSerialization.data(withJSONObject: ["secrets": secrets])
    var expectedPaths: Set<String> = [keys.chainTag]
    for scope in ["p:default", "app"] {
      let id = try vault.write(scope: scope, payload: payload)
      let scopePath = "\(keys.chainTag)/\(keys.scopeTag(scope))"
      expectedPaths.insert(scopePath)
      expectedPaths.insert("\(scopePath)/\(id).nns")
    }
    let files = FileManager.default.enumerator(at: folder, includingPropertiesForKeys: nil)!.compactMap { $0 as? URL }
    let folderPath = folder.resolvingSymlinksInPath().path + "/"
    let relativePaths = Set(files.map { String($0.resolvingSymlinksInPath().path.dropFirst(folderPath.count)) })
    XCTAssertEqual(relativePaths, expectedPaths)
    for url in files {
      let name = url.deletingPathExtension().lastPathComponent
      XCTAssertTrue(Base32.isTag(name), name)
      for secret in secrets {
        XCTAssertFalse(url.path.dropFirst(folder.path.count).contains(secret))
      }
      guard let data = try? Data(contentsOf: url) else { continue }
      for secret in secrets { XCTAssertNil(data.range(of: Data(secret.utf8)), "\(secret) in \(url.lastPathComponent)") }
    }
  }

  func testDeleteChainLeavesOtherPhrases() throws {
    try vault.createChain()
    try vault.write(scope: "app", payload: Data("mine".utf8))
    let other = SyncVault(folder: folder, keys: SyncKeys(entropy: RecoveryPhrase.generateEntropy()))
    try other.createChain()
    try other.write(scope: "app", payload: Data("theirs".utf8))
    try vault.deleteChain()
    XCTAssertFalse(vault.chainExists())
    XCTAssertEqual(try other.read(scope: "app", skipping: []).files.count, 1)
  }

  func testMissingScopeReadsEmptyButUnreadableScopeThrows() throws {
    try vault.createChain()
    XCTAssertTrue(try vault.read(scope: "app", skipping: []).present.isEmpty)
    try vault.write(scope: "app", payload: Data("mine".utf8))
    let scope = vault.scopeURL("app")
    try FileManager.default.setAttributes([.posixPermissions: 0o000], ofItemAtPath: scope.path)
    defer { try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: scope.path) }
    XCTAssertThrowsError(try vault.read(scope: "app", skipping: []))
  }

  func testRemoveSkipsFilesAlreadyGoneAndReportsFailures() throws {
    try vault.createChain()
    let id = try vault.write(scope: "app", payload: Data("mine".utf8))
    XCTAssertNoThrow(try vault.remove(scope: "app", ids: ["AAAAAAAAAAAAAAAAAAAAAAAAAA", id]))
    XCTAssertTrue(try vault.read(scope: "app", skipping: []).present.isEmpty)
    let kept = try vault.write(scope: "app", payload: Data("kept".utf8))
    let scope = vault.scopeURL("app")
    try FileManager.default.setAttributes([.posixPermissions: 0o555], ofItemAtPath: scope.path)
    defer { try? FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: scope.path) }
    XCTAssertThrowsError(try vault.remove(scope: "app", ids: [kept])) { error in
      XCTAssertEqual((error as? SyncVault.RemoveFailed)?.ids, [kept])
    }
  }
}
