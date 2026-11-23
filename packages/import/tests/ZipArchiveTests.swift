import Compression
import Foundation
import XCTest
@testable import ArdiaImportCore

final class ZipArchiveTests: XCTestCase {
  struct Member {
    var name: String
    var body: Data
    var deflate = true
    var symbolicLink = false
    var declaredSize: Int?
  }

  static func deflated(_ data: Data) -> Data {
    guard !data.isEmpty else { return Data() }
    var out = Data(count: data.count + 1024)
    let written = out.withUnsafeMutableBytes { dst in
      data.withUnsafeBytes { src in
        compression_encode_buffer(dst.bindMemory(to: UInt8.self).baseAddress!, dst.count, src.bindMemory(to: UInt8.self).baseAddress!, data.count, nil, COMPRESSION_ZLIB)
      }
    }
    return out.prefix(written)
  }

  static func zip(_ members: [Member], declaredCount: Int? = nil) -> Data {
    func le16(_ value: Int) -> [UInt8] { [UInt8(value & 0xff), UInt8((value >> 8) & 0xff)] }
    func le32(_ value: Int) -> [UInt8] { (0..<4).map { UInt8((value >> (8 * $0)) & 0xff) } }
    var file = Data()
    var directory = Data()
    for member in members {
      let stored = member.deflate ? deflated(member.body) : member.body
      let size = member.declaredSize ?? member.body.count
      let name = Array(member.name.utf8)
      let offset = file.count
      file.append(contentsOf: le32(0x0403_4B50) + le16(20) + le16(0x800) + le16(member.deflate ? 8 : 0) + le16(0) + le16(0) + le32(0))
      file.append(contentsOf: le32(stored.count) + le32(size) + le16(name.count) + le16(0) + name)
      file.append(stored)
      let madeBy = member.symbolicLink ? (3 << 8) | 20 : 20
      let external = member.symbolicLink ? 0o120777 << 16 : 0
      directory.append(contentsOf: le32(0x0201_4B50) + le16(madeBy) + le16(20) + le16(0x800) + le16(member.deflate ? 8 : 0) + le16(0) + le16(0) + le32(0))
      directory.append(contentsOf: le32(stored.count) + le32(size) + le16(name.count) + le16(0) + le16(0) + le16(0) + le16(0) + le32(external) + le32(offset) + name)
    }
    let count = declaredCount ?? members.count
    let start = file.count
    file.append(directory)
    file.append(contentsOf: le32(0x0605_4B50) + le16(0) + le16(0) + le16(count) + le16(count) + le32(directory.count) + le32(start) + le16(0))
    return file
  }

  func testOrdinaryEntriesReadBack() throws {
    let text = Data("<!DOCTYPE NETSCAPE-Bookmark-file-1>".utf8)
    let archive = try ZipArchive(Self.zip([Member(name: "Safari Export/Bookmarks.html", body: text), Member(name: "Safari Export/notes.txt", body: Data("plain".utf8), deflate: false)]))
    XCTAssertEqual(archive.entries.map(\.name), ["Safari Export/Bookmarks.html", "Safari Export/notes.txt"])
    XCTAssertEqual(try archive.extract(archive.entries[0]), text)
    XCTAssertEqual(try archive.extract(archive.entries[1]), Data("plain".utf8))
  }

  func testTraversingNamesAndLinksAreNeverListed() throws {
    let archive = try ZipArchive(Self.zip([
      Member(name: "../escape.csv", body: Data("a".utf8)),
      Member(name: "Safari Export/../../escape.csv", body: Data("a".utf8)),
      Member(name: "/etc/passwords.csv", body: Data("a".utf8)),
      Member(name: "Safari Export\\..\\escape.csv", body: Data("a".utf8)),
      Member(name: "Safari Export/Passwords.csv", body: Data("/Users/someone/secret".utf8), deflate: false, symbolicLink: true),
      Member(name: "Safari Export/History.json", body: Data("{}".utf8)),
    ]))
    XCTAssertEqual(archive.entries.map(\.name), ["Safari Export/History.json"])
  }

  func testMoreEntriesThanTheCapAreRefusedBeforeAnyAreRead() {
    var limits = ZipArchive.Limits.standard
    limits.entries = 3
    let members = (0..<4).map { Member(name: "f\($0).json", body: Data("{}".utf8)) }
    XCTAssertThrowsError(try ZipArchive(Self.zip(members), limits: limits)) { XCTAssertEqual($0 as? ImportError, .unsupported("The zip file has more than 3 entries")) }
    XCTAssertNoThrow(try ZipArchive(Self.zip(Array(members.prefix(3))), limits: limits))
    XCTAssertThrowsError(try ZipArchive(Self.zip([], declaredCount: 10_001))) { XCTAssertEqual($0 as? ImportError, .unsupported("The zip file has more than 10000 entries")) }
  }

  func testAnEntryDeclaredOverTheSizeCapIsRefused() {
    let lying = Member(name: "History.json", body: Data("{}".utf8), declaredSize: (1 << 30) + 1)
    XCTAssertThrowsError(try ZipArchive(Self.zip([lying]))) { XCTAssertEqual($0 as? ImportError, .unsupported("History.json in the zip file is over 1024 MB")) }
  }

  func testEntriesThatTogetherExpandPastTheCapAreRefused() {
    var limits = ZipArchive.Limits.standard
    limits.expanded = 1 << 20
    let members = [Member(name: "a.json", body: Data(count: 600 << 10), deflate: false), Member(name: "b.json", body: Data(count: 600 << 10), deflate: false)]
    XCTAssertThrowsError(try ZipArchive(Self.zip(members), limits: limits)) { XCTAssertEqual($0 as? ImportError, .unsupported("The zip file unpacks to more than 1 MB")) }
    XCTAssertNoThrow(try ZipArchive(Self.zip(Array(members.prefix(1))), limits: limits))
  }

  func testAnEntryThatInflatesPastTheRatioIsRefusedAndSmallOnesAreNot() throws {
    let bomb = Member(name: "History.json", body: Data(count: 8 << 20))
    XCTAssertThrowsError(try ZipArchive(Self.zip([bomb]))) { XCTAssertEqual($0 as? ImportError, .unsupported("History.json in the zip file unpacks to more than 200 times its size")) }
    let small = Member(name: "History.json", body: Data(repeating: 0x61, count: 2 << 20))
    let archive = try ZipArchive(Self.zip([small]))
    XCTAssertEqual(try archive.extract(archive.entries[0]).count, 2 << 20, "a highly compressible file under the floor reads")
  }

  func testAStoredEntryWhoseSizesDisagreeIsDamaged() {
    let member = Member(name: "notes.csv", body: Data("a,b".utf8), deflate: false, declaredSize: 99)
    XCTAssertThrowsError(try ZipArchive(Self.zip([member]))) { XCTAssertEqual($0 as? ImportError, .unreadable("Damaged zip entry")) }
  }

  func testADeflatedEntryThatInflatesShortIsDamaged() throws {
    let member = Member(name: "History.json", body: Data("{}".utf8), declaredSize: 64)
    let archive = try ZipArchive(Self.zip([member]))
    XCTAssertThrowsError(try archive.extract(archive.entries[0])) { XCTAssertEqual($0 as? ImportError, .unreadable("Couldn't inflate History.json")) }
  }
}
