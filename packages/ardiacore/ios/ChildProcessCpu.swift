import Darwin
import Foundation

enum ChildProcessCpu {
  private struct Known {
    let started: UInt64
    let kind: String
  }

  private static let lock = NSLock()
  private static var known: [pid_t: Known] = [:]
  private static let ticksToNanos: Double = {
    var info = mach_timebase_info_data_t()
    mach_timebase_info(&info)
    return info.denom == 0 ? 1 : Double(info.numer) / Double(info.denom)
  }()

  static func sample() -> [[String: Any]] {
    lock.lock()
    defer { lock.unlock() }
    var pids = [pid_t](repeating: 0, count: 1024)
    let bytes = pids.withUnsafeMutableBytes { buffer in
      proc_listpids(UInt32(PROC_PPID_ONLY), UInt32(getpid()), buffer.baseAddress, Int32(buffer.count))
    }
    guard bytes > 0 else { return [] }
    let count = min(pids.count, Int(bytes) / MemoryLayout<pid_t>.size)
    var alive: [pid_t: Known] = [:]
    var rows: [[String: Any]] = []
    for pid in pids.prefix(count) where pid > 0 {
      var usage = rusage_info_v2()
      let read = withUnsafeMutablePointer(to: &usage) {
        $0.withMemoryRebound(to: rusage_info_t?.self, capacity: 1) { proc_pid_rusage(pid, RUSAGE_INFO_V2, $0) }
      }
      guard read == 0 else { continue }
      let started = usage.ri_proc_start_abstime
      let kind = known[pid].flatMap { $0.started == started ? $0.kind : nil } ?? kindOf(pid)
      alive[pid] = Known(started: started, kind: kind)
      guard kind != "other" else { continue }
      let cpuMs = Double(usage.ri_user_time &+ usage.ri_system_time) * ticksToNanos / 1_000_000
      rows.append(["pid": Int(pid), "started": Double(started), "kind": kind, "cpuMs": cpuMs])
    }
    known = alive
    return rows
  }

  private static func kindOf(_ pid: pid_t) -> String {
    var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, pid]
    var size = 0
    guard sysctl(&mib, 3, nil, &size, nil, 0) == 0, size > 0 else { return "other" }
    var args = [UInt8](repeating: 0, count: size)
    guard sysctl(&mib, 3, &args, &size, nil, 0) == 0 else { return "other" }
    let line = String(decoding: args.prefix(size).map { $0 == 0 ? 0x20 : $0 }, as: UTF8.self)
    guard line.contains(" --type=renderer") else { return "other" }
    return line.contains(" --extension-process") ? "extension" : "renderer"
  }
}
