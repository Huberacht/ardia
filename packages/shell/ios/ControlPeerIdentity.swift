import Darwin
import Foundation
import Security

struct ControlPeerIdentity {
  let token: audit_token_t

  var pid: Int32 { ControlPeer.pid(of: token) }

  static func of(_ fd: Int32) -> ControlPeerIdentity? {
    ControlPeer.auditToken(of: fd).map(ControlPeerIdentity.init(token:))
  }

  func identity() -> [String: Any] {
    let started = DispatchTime.now().uptimeNanoseconds
    var found = signature()
    found["lookupMs"] = Double(DispatchTime.now().uptimeNanoseconds - started) / 1_000_000
    return found
  }

  private func signature() -> [String: Any] {
    var found: [String: Any] = ["pid": Int(pid), "signed": false, "valid": false, "adhoc": false, "platform": false]
    var token = self.token
    let audit = Data(bytes: &token, count: MemoryLayout<audit_token_t>.size)
    var guest: SecCode?
    guard SecCodeCopyGuestWithAttributes(nil, [kSecGuestAttributeAudit: audit] as CFDictionary, [], &guest) == errSecSuccess, let code = guest else { return found }
    found["valid"] = SecCodeCheckValidity(code, [], nil) == errSecSuccess
    var staticCode: SecStaticCode?
    guard SecCodeCopyStaticCode(code, [], &staticCode) == errSecSuccess, let on = staticCode else { return found }
    var location: CFURL?
    if SecCodeCopyPath(on, [], &location) == errSecSuccess, let url = location as URL? {
      found["path"] = url.path
      found["name"] = Self.displayName(url)
    }
    var details: CFDictionary?
    guard SecCodeCopySigningInformation(on, SecCSFlags(rawValue: kSecCSSigningInformation), &details) == errSecSuccess, let info = details as? [String: Any] else { return found }
    if let identifier = info[kSecCodeInfoIdentifier as String] as? String { found["identifier"] = identifier }
    if let team = info[kSecCodeInfoTeamIdentifier as String] as? String { found["teamId"] = team }
    let flags = (info[kSecCodeInfoFlags as String] as? NSNumber)?.uint32Value ?? 0
    let adhoc = flags & SecCodeSignatureFlags.adhoc.rawValue != 0
    found["adhoc"] = adhoc
    found["platform"] = (info[kSecCodeInfoPlatformIdentifier as String] as? NSNumber).map { $0.intValue != 0 } ?? false
    if let certificates = info[kSecCodeInfoCertificates as String] as? [SecCertificate], let leaf = certificates.first {
      found["signer"] = SecCertificateCopySubjectSummary(leaf) as String? ?? ""
      found["signed"] = !adhoc && (found["valid"] as? Bool ?? false)
    }
    return found
  }

  private static func displayName(_ url: URL) -> String {
    var bundle = url
    while bundle.pathComponents.count > 1 {
      if bundle.pathExtension == "app" { return bundle.deletingPathExtension().lastPathComponent }
      bundle = bundle.deletingLastPathComponent()
    }
    return url.lastPathComponent
  }
}
