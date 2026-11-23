import ArdiaCoreRS
import Foundation

public enum RecoveryPhrase {
  public static let wordCount = 24
  static let entropyBytes = Int(ARDIA_ENTROPY_BYTES)

  public enum Problem: Error, Equatable {
    case wordCount(Int)
    case unknownWord(String)
    case checksum
  }

  public static func generateEntropy() -> Data {
    do {
      return try CoreCall.mapped { ardia_phrase_generate_entropy($0) }
    } catch {
      preconditionFailure("the system random source failed: \(error)")
    }
  }

  public static func words(for entropy: Data) -> [String] {
    precondition(entropy.count == entropyBytes)
    return CoreCall.text { out in CoreCall.bytes(entropy) { ardia_phrase_from_entropy($0, $1, out) } }.split(separator: " ").map(String.init)
  }

  public static func tokens(in text: String) -> [String] {
    text.lowercased().components(separatedBy: CharacterSet.lowercaseLetters.inverted).filter { !$0.isEmpty }
  }

  public static func entropy(from text: String) throws -> Data {
    do {
      return try CoreCall.data { out in CoreCall.bytes(text) { ardia_phrase_to_entropy($0, $1, out) } }
    } catch let refused as CoreCall.Refused {
      throw problem(refused, in: text)
    }
  }

  static func problem(_ refused: CoreCall.Refused, in text: String) -> Problem {
    switch refused.detail["code"] as? String {
    case "wordCount":
      return .wordCount((refused.detail["count"] as? Int) ?? tokens(in: text).count)
    case "unknownWord":
      let tokens = tokens(in: text)
      let index = refused.detail["index"] as? Int ?? -1
      return .unknownWord(tokens.indices.contains(index) ? tokens[index] : "")
    default:
      let count = tokens(in: text).count
      return count == wordCount ? .checksum : .wordCount(count)
    }
  }
}
