#include "ardia/win/webui/webui_updates.h"

#include <windows.h>

#include <bcrypt.h>

#include <algorithm>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "ardia/core/ac_launch_switches.h"
#include "ardia/win/launch_guard.h"
#include "ardia/win/webui/webui_policy.h"
#include "ardia/win/webui/webui_update_policy.h"
#include "base/command_line.h"
#include "base/files/file_path.h"
#include "base/files/file_util.h"
#include "base/functional/bind.h"
#include "base/json/json_reader.h"
#include "base/logging.h"
#include "base/memory/scoped_refptr.h"
#include "base/memory/weak_ptr.h"
#include "base/no_destructor.h"
#include "base/path_service.h"
#include "base/strings/utf_string_conversions.h"
#include "base/task/sequenced_task_runner.h"
#include "base/task/thread_pool.h"
#include "base/threading/scoped_blocking_call.h"
#include "base/time/time.h"
#include "base/values.h"
#include "base/win/scoped_handle.h"
#include "chrome/browser/browser_process.h"
#include "chrome/browser/net/system_network_context_manager.h"
#include "net/base/load_flags.h"
#include "net/base/net_errors.h"
#include "net/http/http_request_headers.h"
#include "net/http/http_response_headers.h"
#include "net/traffic_annotation/network_traffic_annotation.h"
#include "net/url_request/redirect_info.h"
#include "services/network/public/cpp/resource_request.h"
#include "services/network/public/cpp/shared_url_loader_factory.h"
#include "services/network/public/cpp/simple_url_loader.h"
#include "services/network/public/mojom/fetch_api.mojom.h"
#include "services/network/public/mojom/url_response_head.mojom.h"
#include "url/gurl.h"

namespace ardia_win::webui {

namespace {

namespace policy = webui_update;

constexpr net::NetworkTrafficAnnotationTag kUpdateTrafficAnnotation =
    net::DefineNetworkTrafficAnnotation("ardia_windows_update_download", R"(
      semantics {
        sender: "Ardia Windows self-update"
        description:
          "Downloads Ardia's signed Windows update feed from its GitHub "
          "release: windows-update.json, its Ed25519 signature "
          "windows-update.json.sig and, when the verified feed offers a "
          "newer build for this CPU, that build's installer, so Ardia can "
          "install it when the user restarts to update."
        trigger:
          "Check for Updates, or an automatic check while automatic update "
          "checks are on, and a download the user accepted or automatic "
          "downloads allowed."
        user_data {
          type: NONE
        }
        data: "None. GETs of public release assets."
        destination: OTHER
        destination_other:
          "github.com and GitHub's release asset hosts "
          "(objects.githubusercontent.com, "
          "release-assets.githubusercontent.com)."
        last_reviewed: "2026-11-24"
      }
      policy {
        cookies_allowed: NO
        setting: "Settings > General > Updates."
        policy_exception_justification: "Not implemented."
      })");

constexpr base::TaskTraits kFileTraits = {base::MayBlock(), base::TaskPriority::USER_VISIBLE,
                                          base::TaskShutdownBehavior::SKIP_ON_SHUTDOWN};

std::string_view Cpu() {
#if defined(_M_ARM64)
  return "arm64";
#else
  return "x64";
#endif
}

struct Identity {
  std::string version;
  uint64_t build = 0;
};

struct Installation {
  std::optional<Identity> identity;
  std::string kind = std::string(policy::kUnsupportedKind);
  base::FilePath verifier;
  base::FilePath key;
  base::FilePath app_data;
  policy::Feed feed = policy::ReleaseFeed();
  bool test_feed = false;
};

std::wstring EnvironmentText(const wchar_t* name) {
  wchar_t buffer[policy::kInstanceLimit + 1] = {};
  const DWORD length = ::GetEnvironmentVariableW(name, buffer, static_cast<DWORD>(std::size(buffer)));
  if (length == 0 || length >= std::size(buffer)) {
    return std::wstring();
  }
  return std::wstring(buffer, length);
}

std::optional<std::string> TestInstanceValue(std::string_view key) {
  if (!ardiacore::TestInstance()) {
    return std::nullopt;
  }
  return policy::InstanceValue(base::WideToUTF8(EnvironmentText(L"ARDIA_INSTANCE")), key);
}

std::optional<std::wstring> DosPath(const std::wstring& final_path) {
  constexpr std::wstring_view kLongPrefix = L"\\\\?\\";
  constexpr std::wstring_view kNetworkPrefix = L"\\\\?\\UNC\\";
  std::wstring path = final_path;
  if (path.starts_with(kNetworkPrefix) || (path.starts_with(L"\\\\") && !path.starts_with(kLongPrefix))) {
    return std::nullopt;
  }
  if (path.starts_with(kLongPrefix)) {
    path.erase(0, kLongPrefix.size());
  }
  if (path.size() < 3 || path[1] != L':' || path[2] != L'\\') {
    return std::nullopt;
  }
  return path;
}

std::optional<std::wstring> FinalPathOf(HANDLE handle) {
  constexpr DWORD kFlags = VOLUME_NAME_DOS | FILE_NAME_NORMALIZED;
  const DWORD size = ::GetFinalPathNameByHandleW(handle, nullptr, 0, kFlags);
  if (size == 0) {
    return std::nullopt;
  }
  std::wstring value(size, L'\0');
  const DWORD written = ::GetFinalPathNameByHandleW(handle, value.data(), size, kFlags);
  if (written == 0 || written >= size) {
    return std::nullopt;
  }
  value.resize(written);
  if (!NormalizeWinFinalPath(value)) {
    return std::nullopt;
  }
  return DosPath(value);
}

struct FileFacts {
  uint64_t size = 0;
  DWORD links = 0;
  std::wstring final_path;
};

std::optional<FileFacts> RegularFileFacts(HANDLE handle) {
  if (::GetFileType(handle) != FILE_TYPE_DISK) {
    return std::nullopt;
  }
  BY_HANDLE_FILE_INFORMATION info{};
  if (!::GetFileInformationByHandle(handle, &info) ||
      (info.dwFileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0) {
    return std::nullopt;
  }
  const std::optional<std::wstring> final_path = FinalPathOf(handle);
  if (!final_path) {
    return std::nullopt;
  }
  return FileFacts{(static_cast<uint64_t>(info.nFileSizeHigh) << 32) | info.nFileSizeLow, info.nNumberOfLinks,
                   *final_path};
}

base::win::ScopedHandle OpenWithoutFollowing(const std::wstring& path, DWORD access, DWORD share) {
  return base::win::ScopedHandle(::CreateFileW(path.c_str(), access, share, nullptr, OPEN_EXISTING,
                                               FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_SEQUENTIAL_SCAN, nullptr));
}

bool IsRegularFile(const base::FilePath& path) {
  base::win::ScopedHandle file = OpenWithoutFollowing(path.value(), FILE_READ_ATTRIBUTES,
                                                      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE);
  return file.is_valid() && RegularFileFacts(file.get()).has_value();
}

std::optional<std::wstring> DirectoryFinalPath(const std::wstring& path, bool follow) {
  base::win::ScopedHandle directory(::CreateFileW(
      path.c_str(), FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
      FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | (follow ? 0 : FILE_FLAG_OPEN_REPARSE_POINT), nullptr));
  if (!directory.is_valid()) {
    return std::nullopt;
  }
  BY_HANDLE_FILE_INFORMATION info{};
  if (!::GetFileInformationByHandle(directory.get(), &info) ||
      (info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0 ||
      (!follow && (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0)) {
    return std::nullopt;
  }
  return FinalPathOf(directory.get());
}

std::optional<std::wstring> RealChildDirectory(const std::wstring& parent_final, const std::wstring& leaf) {
  const std::wstring path = parent_final + L"\\" + leaf;
  if (!::CreateDirectoryW(path.c_str(), nullptr) && ::GetLastError() != ERROR_ALREADY_EXISTS) {
    return std::nullopt;
  }
  const std::optional<std::wstring> final_path = DirectoryFinalPath(path, false);
  if (!final_path || !IsDirectChildOfWinDirectory(parent_final, *final_path)) {
    return std::nullopt;
  }
  return final_path;
}

std::optional<std::wstring> UpdatesFolder(const base::FilePath& app_data) {
  if (app_data.empty()) {
    return std::nullopt;
  }
  const std::optional<std::wstring> root = DirectoryFinalPath(app_data.value(), true);
  if (!root) {
    return std::nullopt;
  }
  return RealChildDirectory(*root, policy::kUpdatesFolder);
}

std::optional<std::wstring> WriteNewFile(const std::wstring& folder, const std::wstring& leaf,
                                         const std::string& bytes) {
  const std::wstring path = folder + L"\\" + leaf;
  base::win::ScopedHandle file(::CreateFileW(path.c_str(), GENERIC_WRITE | GENERIC_READ, 0, nullptr, CREATE_NEW,
                                             FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, nullptr));
  if (!file.is_valid()) {
    return std::nullopt;
  }
  size_t written = 0;
  while (written < bytes.size()) {
    const DWORD chunk = static_cast<DWORD>(std::min<size_t>(bytes.size() - written, 64 * 1024));
    DWORD stored = 0;
    if (!::WriteFile(file.get(), bytes.data() + written, chunk, &stored, nullptr) || stored != chunk) {
      return std::nullopt;
    }
    written += stored;
  }
  if (!::FlushFileBuffers(file.get())) {
    return std::nullopt;
  }
  const std::optional<FileFacts> facts = RegularFileFacts(file.get());
  if (!facts || facts->links != 1 || facts->size != bytes.size() ||
      !IsDirectChildOfWinDirectory(folder, facts->final_path)) {
    return std::nullopt;
  }
  return facts->final_path;
}

class Scratch {
 public:
  explicit Scratch(const std::wstring& updates) {
    static std::atomic<uint64_t> sequence{0};
    for (int attempt = 0; attempt < 8 && folder_.empty(); ++attempt) {
      const std::wstring leaf = base::UTF8ToWide(policy::ScratchName(::GetCurrentProcessId(), ++sequence));
      const std::wstring path = updates + L"\\" + leaf;
      if (!::CreateDirectoryW(path.c_str(), nullptr)) {
        if (::GetLastError() == ERROR_ALREADY_EXISTS) {
          continue;
        }
        return;
      }
      const std::optional<std::wstring> final_path = DirectoryFinalPath(path, false);
      if (!final_path || !IsDirectChildOfWinDirectory(updates, *final_path)) {
        ::RemoveDirectoryW(path.c_str());
        return;
      }
      folder_ = *final_path;
    }
  }
  Scratch(const Scratch&) = delete;
  Scratch& operator=(const Scratch&) = delete;
  ~Scratch() {
    if (folder_.empty()) {
      return;
    }
    for (const std::wstring& file : files_) {
      ::DeleteFileW(file.c_str());
    }
    ::RemoveDirectoryW(folder_.c_str());
  }

  bool ok() const { return !folder_.empty(); }

  std::optional<std::wstring> Write(const std::wstring& leaf, const std::string& bytes) {
    if (!ok()) {
      return std::nullopt;
    }
    std::optional<std::wstring> written = WriteNewFile(folder_, leaf, bytes);
    files_.push_back(folder_ + L"\\" + leaf);
    return written;
  }

 private:
  std::wstring folder_;
  std::vector<std::wstring> files_;
};

struct ChildRun {
  bool exited = false;
  int exit_code = -1;
  std::string output;
};

ChildRun RunHidden(const std::wstring& application, std::wstring command, uint32_t timeout_ms) {
  base::ScopedBlockingCall blocking(FROM_HERE, base::BlockingType::WILL_BLOCK);
  ChildRun run;
  SECURITY_ATTRIBUTES inherit{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
  HANDLE read_end = nullptr;
  HANDLE write_end = nullptr;
  if (!::CreatePipe(&read_end, &write_end, &inherit, 0)) {
    return run;
  }
  base::win::ScopedHandle output_read(read_end);
  base::win::ScopedHandle output_write(write_end);
  ::SetHandleInformation(output_read.get(), HANDLE_FLAG_INHERIT, 0);
  base::win::ScopedHandle null_device(::CreateFileW(L"NUL", GENERIC_READ | GENERIC_WRITE,
                                                    FILE_SHARE_READ | FILE_SHARE_WRITE, &inherit, OPEN_EXISTING,
                                                    FILE_ATTRIBUTE_NORMAL, nullptr));
  if (!null_device.is_valid()) {
    return run;
  }
  HANDLE inherited[] = {output_write.get(), null_device.get()};
  SIZE_T attribute_bytes = 0;
  ::InitializeProcThreadAttributeList(nullptr, 1, 0, &attribute_bytes);
  std::vector<uint8_t> attribute_storage(attribute_bytes);
  auto* attributes = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(attribute_storage.data());
  if (!::InitializeProcThreadAttributeList(attributes, 1, 0, &attribute_bytes)) {
    return run;
  }
  if (!::UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited, sizeof(inherited),
                                   nullptr, nullptr)) {
    ::DeleteProcThreadAttributeList(attributes);
    return run;
  }
  STARTUPINFOEXW startup{};
  startup.StartupInfo.cb = sizeof(startup);
  startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
  startup.StartupInfo.hStdInput = null_device.get();
  startup.StartupInfo.hStdOutput = output_write.get();
  startup.StartupInfo.hStdError = null_device.get();
  startup.lpAttributeList = attributes;
  PROCESS_INFORMATION process{};
  const BOOL started = ::CreateProcessW(application.c_str(), command.data(), nullptr, nullptr, TRUE,
                                        CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT, nullptr, nullptr,
                                        &startup.StartupInfo, &process);
  ::DeleteProcThreadAttributeList(attributes);
  output_write.Close();
  null_device.Close();
  if (!started) {
    return run;
  }
  base::win::ScopedHandle process_handle(process.hProcess);
  base::win::ScopedHandle thread_handle(process.hThread);
  const ULONGLONG deadline = ::GetTickCount64() + timeout_ms;
  const auto drain = [&] {
    DWORD available = 0;
    while (::PeekNamedPipe(output_read.get(), nullptr, 0, nullptr, &available, nullptr) && available > 0) {
      char buffer[1024];
      DWORD read = 0;
      if (!::ReadFile(output_read.get(), buffer, std::min<DWORD>(available, sizeof(buffer)), &read, nullptr) ||
          read == 0) {
        break;
      }
      if (run.output.size() < policy::kVerifierOutputLimit) {
        run.output.append(buffer, std::min<size_t>(read, policy::kVerifierOutputLimit - run.output.size()));
      }
    }
  };
  bool timed_out = false;
  for (;;) {
    drain();
    if (::WaitForSingleObject(process_handle.get(), 50) == WAIT_OBJECT_0) {
      drain();
      break;
    }
    if (::GetTickCount64() >= deadline) {
      timed_out = true;
      ::TerminateProcess(process_handle.get(), 1);
      ::WaitForSingleObject(process_handle.get(), 2000);
      break;
    }
  }
  DWORD exit_code = 1;
  if (!timed_out && ::GetExitCodeProcess(process_handle.get(), &exit_code)) {
    run.exited = true;
    run.exit_code = static_cast<int>(exit_code);
  }
  return run;
}

class Sha256 {
 public:
  Sha256() {
    if (::BCryptOpenAlgorithmProvider(&algorithm_, BCRYPT_SHA256_ALGORITHM, nullptr, 0) != 0) {
      algorithm_ = nullptr;
      return;
    }
    if (::BCryptCreateHash(algorithm_, &hash_, nullptr, 0, nullptr, 0, 0) != 0) {
      hash_ = nullptr;
    }
  }
  Sha256(const Sha256&) = delete;
  Sha256& operator=(const Sha256&) = delete;
  ~Sha256() {
    if (hash_) {
      ::BCryptDestroyHash(hash_);
    }
    if (algorithm_) {
      ::BCryptCloseAlgorithmProvider(algorithm_, 0);
    }
  }

  bool Add(const uint8_t* bytes, ULONG count) {
    return hash_ && ::BCryptHashData(hash_, const_cast<PUCHAR>(bytes), count, 0) == 0;
  }

  std::string Hex() {
    uint8_t digest[32] = {};
    if (!hash_ || ::BCryptFinishHash(hash_, digest, sizeof(digest), 0) != 0) {
      return std::string();
    }
    return policy::HexLower(digest, sizeof(digest));
  }

 private:
  BCRYPT_ALG_HANDLE algorithm_ = nullptr;
  BCRYPT_HASH_HANDLE hash_ = nullptr;
};

std::string HashOf(HANDLE file) {
  LARGE_INTEGER start{};
  if (!::SetFilePointerEx(file, start, nullptr, FILE_BEGIN)) {
    return std::string();
  }
  Sha256 hash;
  std::vector<uint8_t> buffer(256 * 1024);
  for (;;) {
    DWORD read = 0;
    if (!::ReadFile(file, buffer.data(), static_cast<DWORD>(buffer.size()), &read, nullptr)) {
      return std::string();
    }
    if (read == 0) {
      return hash.Hex();
    }
    if (!hash.Add(buffer.data(), read)) {
      return std::string();
    }
  }
}

std::optional<Identity> ReadIdentity(const base::FilePath& file) {
  if (!IsRegularFile(file)) {
    return std::nullopt;
  }
  std::string text;
  if (!base::ReadFileToStringWithMaxSize(file, &text, policy::kBuildFileLimit)) {
    return std::nullopt;
  }
  const std::optional<base::Value> value = base::JSONReader::Read(text, base::JSON_PARSE_RFC);
  if (!value || !value->is_dict()) {
    return std::nullopt;
  }
  const std::string* version = value->GetDict().FindString("version");
  const base::Value* build = value->GetDict().Find("build");
  if (!version || !policy::ValidVersion(*version) || !build) {
    return std::nullopt;
  }
  double number = 0;
  if (build->is_int()) {
    number = build->GetInt();
  } else if (build->is_double()) {
    number = build->GetDouble();
  } else {
    return std::nullopt;
  }
  if (!std::isfinite(number) || number < 1 || number > static_cast<double>(policy::kLargestBuild) ||
      std::floor(number) != number) {
    return std::nullopt;
  }
  return Identity{*version, static_cast<uint64_t>(number)};
}

Installation ReadInstallation(base::FilePath app_data) {
  base::ScopedBlockingCall blocking(FROM_HERE, base::BlockingType::MAY_BLOCK);
  Installation found;
  found.app_data = std::move(app_data);
  base::FilePath exe_directory;
  if (!base::PathService::Get(base::DIR_EXE, &exe_directory)) {
    return found;
  }
  found.identity = ReadIdentity(exe_directory.Append(policy::kBuildFileName));
  found.verifier = exe_directory.Append(policy::kVerifierName);
  found.key = exe_directory.Append(policy::kKeyName);
  if (const std::optional<std::string> feed = TestInstanceValue("updateFeed")) {
    if (const std::optional<policy::Feed> test = policy::TestFeed(*feed)) {
      found.feed = *test;
      found.test_feed = true;
    } else {
      LOG(WARNING) << "Ardia updates: the test instance's updateFeed is not an allowed feed address";
    }
  }
  if (const std::optional<std::string> key = TestInstanceValue("updateKey")) {
    const base::FilePath override_key(base::UTF8ToWide(*key));
    if (override_key.IsAbsolute()) {
      found.key = override_key;
    }
  }
  const policy::Installation facts{found.identity.has_value(), IsRegularFile(found.verifier),
                                   IsRegularFile(found.key),
                                   IsRegularFile(exe_directory.Append(policy::kUninstallerName))};
  found.kind = std::string(policy::InstallKind(facts));
  return found;
}

struct Verified {
  policy::VerifierAnswer answer;
  std::string manifest;
  std::string signature;
};

policy::VerifierAnswer RunVerifier(const Installation& installation,
                                   const std::wstring& updates,
                                   const std::string& manifest,
                                   const std::string& signature,
                                   uint64_t current_build,
                                   const std::wstring& package) {
  policy::VerifierAnswer refused;
  refused.reason = std::string(policy::kMissingReason);
  if (!IsRegularFile(installation.verifier) || !IsRegularFile(installation.key)) {
    return refused;
  }
  Scratch scratch(updates);
  const std::optional<std::wstring> manifest_path = scratch.Write(policy::kManifestFileName, manifest);
  const std::optional<std::wstring> signature_path = scratch.Write(policy::kSignatureFileName, signature);
  if (!manifest_path || !signature_path) {
    return refused;
  }
  const policy::VerifierPaths paths{installation.verifier.value(), installation.key.value(), *manifest_path,
                                    *signature_path, package};
  const std::optional<std::wstring> command =
      policy::VerifierCommand(paths, installation.feed.published_under, Cpu(), current_build);
  if (!command) {
    refused.reason = std::string(policy::kVerifierReason);
    return refused;
  }
  const ChildRun run = RunHidden(installation.verifier.value(), *command,
                                 package.empty() ? policy::kManifestCheckTimeoutMs : policy::kPackageCheckTimeoutMs);
  return policy::ReadVerifierAnswer(run.exited, run.exit_code, run.output, current_build,
                                    installation.feed.published_under);
}

Verified VerifyManifest(Installation installation, std::string manifest, std::string signature) {
  base::ScopedBlockingCall blocking(FROM_HERE, base::BlockingType::MAY_BLOCK);
  Verified verified;
  verified.manifest = std::move(manifest);
  verified.signature = std::move(signature);
  const std::optional<std::wstring> updates = UpdatesFolder(installation.app_data);
  if (!updates || !installation.identity) {
    verified.answer.reason = std::string(policy::kMissingReason);
    return verified;
  }
  verified.answer = RunVerifier(installation, *updates, verified.manifest, verified.signature,
                                installation.identity->build, std::wstring());
  return verified;
}

struct Prepared {
  std::wstring updates;
  bool complete = false;
  std::string reason;
};

bool MatchesOffer(const std::wstring& path, const std::wstring& updates, const policy::Offer& offer,
                  base::win::ScopedHandle* held) {
  base::win::ScopedHandle file = OpenWithoutFollowing(path, GENERIC_READ, FILE_SHARE_READ);
  if (!file.is_valid()) {
    return false;
  }
  const std::optional<FileFacts> facts = RegularFileFacts(file.get());
  if (!facts || facts->links != 1 || facts->size != offer.bytes ||
      !IsDirectChildOfWinDirectory(updates, facts->final_path) || HashOf(file.get()) != offer.sha256) {
    return false;
  }
  if (held) {
    *held = std::move(file);
  }
  return true;
}

Prepared PrepareInstallerFolder(base::FilePath app_data, policy::Offer offer) {
  base::ScopedBlockingCall blocking(FROM_HERE, base::BlockingType::MAY_BLOCK);
  Prepared prepared;
  const std::optional<std::wstring> updates = UpdatesFolder(app_data);
  if (!updates) {
    prepared.reason = std::string(policy::kDiskReason);
    return prepared;
  }
  prepared.updates = *updates;
  const std::wstring target = base::UTF8ToWide(policy::InstallerFileName(offer.sha256));
  WIN32_FIND_DATAW found{};
  const std::wstring pattern = *updates + L"\\*";
  HANDLE search = ::FindFirstFileExW(pattern.c_str(), FindExInfoBasic, &found, FindExSearchNameMatch, nullptr, 0);
  if (search != INVALID_HANDLE_VALUE) {
    do {
      const std::wstring name(found.cFileName);
      if ((found.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) != 0 || name == target ||
          !policy::IsInstallerLeftover(base::WideToUTF8(name))) {
        continue;
      }
      ::DeleteFileW((*updates + L"\\" + name).c_str());
    } while (::FindNextFileW(search, &found));
    ::FindClose(search);
  }
  const std::wstring target_path = *updates + L"\\" + target;
  if (MatchesOffer(target_path, *updates, offer, nullptr)) {
    prepared.complete = true;
    return prepared;
  }
  ::DeleteFileW(target_path.c_str());
  return prepared;
}

std::string FinishInstaller(Installation installation, std::wstring updates, policy::Offer offer,
                            std::string manifest, std::string signature, bool already_there) {
  base::ScopedBlockingCall blocking(FROM_HERE, base::BlockingType::MAY_BLOCK);
  const std::wstring target = updates + L"\\" + base::UTF8ToWide(policy::InstallerFileName(offer.sha256));
  if (!already_there) {
    const std::wstring partial = updates + L"\\" + base::UTF8ToWide(policy::PartialFileName(offer.sha256));
    const bool matches = MatchesOffer(partial, updates, offer, nullptr);
    if (!matches) {
      ::DeleteFileW(partial.c_str());
      return std::string(policy::kChecksumReason);
    }
    if (!::MoveFileExW(partial.c_str(), target.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
      ::DeleteFileW(partial.c_str());
      return std::string(policy::kDiskReason);
    }
  }
  if (!installation.identity) {
    return std::string(policy::kMissingReason);
  }
  const policy::VerifierAnswer answer =
      RunVerifier(installation, updates, manifest, signature, installation.identity->build, target);
  if (answer.verdict != policy::Verdict::kOk || !policy::SameOffer(answer.offer, offer)) {
    ::DeleteFileW(target.c_str());
    return answer.reason.empty() ? std::string(policy::kChecksumReason) : answer.reason;
  }
  return std::string();
}

std::string LaunchInstaller(base::FilePath app_data, policy::Offer offer) {
  base::ScopedBlockingCall blocking(FROM_HERE, base::BlockingType::MAY_BLOCK);
  const std::optional<std::wstring> updates = UpdatesFolder(app_data);
  if (!updates) {
    return std::string(policy::kMissingReason);
  }
  const std::wstring target = *updates + L"\\" + base::UTF8ToWide(policy::InstallerFileName(offer.sha256));
  base::win::ScopedHandle held;
  if (!MatchesOffer(target, *updates, offer, &held)) {
    return std::string(policy::kChecksumReason);
  }
  const std::optional<FileFacts> facts = RegularFileFacts(held.get());
  if (!facts) {
    return std::string(policy::kMissingReason);
  }
  std::optional<std::wstring> command = policy::InstallerCommand(facts->final_path);
  if (!command) {
    return std::string(policy::kInstallReason);
  }
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  PROCESS_INFORMATION process{};
  if (!::CreateProcessW(facts->final_path.c_str(), command->data(), nullptr, nullptr, FALSE, 0, nullptr, nullptr,
                        &startup, &process)) {
    return std::string(policy::kInstallReason);
  }
  ::CloseHandle(process.hThread);
  ::CloseHandle(process.hProcess);
  return std::string();
}

scoped_refptr<network::SharedURLLoaderFactory> LoaderFactory() {
  if (!g_browser_process || g_browser_process->IsShuttingDown()) {
    return nullptr;
  }
  SystemNetworkContextManager* manager = g_browser_process->system_network_context_manager();
  return manager ? manager->GetSharedURLLoaderFactory() : nullptr;
}

struct Fetched {
  std::optional<std::string> body;
  bool saved = false;
  int status = 0;
  bool too_large = false;
  bool refused = false;
};

class Fetch {
 public:
  using Done = base::OnceCallback<void(Fetched)>;

  Fetch(const std::string& url, bool release, Done done) : release_(release), done_(std::move(done)) {
    auto request = std::make_unique<network::ResourceRequest>();
    request->url = GURL(url);
    request->method = "GET";
    request->credentials_mode = network::mojom::CredentialsMode::kOmit;
    request->redirect_mode = network::mojom::RedirectMode::kFollow;
    request->load_flags = net::LOAD_DISABLE_CACHE | net::LOAD_BYPASS_CACHE;
    request->headers.SetHeader(net::HttpRequestHeaders::kAccept, "application/octet-stream");
    loader_ = network::SimpleURLLoader::Create(std::move(request), kUpdateTrafficAnnotation);
    loader_->SetOnRedirectCallback(base::BindRepeating(&Fetch::OnRedirect, weak_factory_.GetWeakPtr()));
  }
  Fetch(const Fetch&) = delete;
  Fetch& operator=(const Fetch&) = delete;

  void ToString(size_t limit) {
    scoped_refptr<network::SharedURLLoaderFactory> factory = LoaderFactory();
    if (!factory) {
      return Finish(Fetched{});
    }
    loader_->SetTimeoutDuration(base::Seconds(policy::kSmallFileTimeoutSeconds));
    loader_->DownloadToString(factory.get(), base::BindOnce(&Fetch::OnString, weak_factory_.GetWeakPtr()), limit);
  }

  void ToFile(const base::FilePath& path, uint64_t limit) {
    scoped_refptr<network::SharedURLLoaderFactory> factory = LoaderFactory();
    if (!factory) {
      return Finish(Fetched{});
    }
    loader_->SetTimeoutDuration(base::Seconds(policy::kInstallerTimeoutSeconds));
    loader_->DownloadToFile(factory.get(), base::BindOnce(&Fetch::OnFile, weak_factory_.GetWeakPtr()), path,
                            static_cast<int64_t>(limit));
  }

 private:
  void OnRedirect(const GURL& url_before_redirect,
                  const net::RedirectInfo& redirect_info,
                  const network::mojom::URLResponseHead& response_head,
                  std::vector<std::string>* removed_headers) {
    const GURL& target = redirect_info.new_url;
    if (policy::AllowedRedirect(target.scheme(), target.host(), target.EffectiveIntPort(), release_)) {
      return;
    }
    LOG(WARNING) << "Ardia updates: refused a redirect to " << target.host();
    loader_.reset();
    Fetched refused;
    refused.refused = true;
    base::SequencedTaskRunner::GetCurrentDefault()->PostTask(
        FROM_HERE, base::BindOnce(&Fetch::Finish, weak_factory_.GetWeakPtr(), std::move(refused)));
  }

  Fetched Outcome() const {
    Fetched fetched;
    if (!loader_) {
      return fetched;
    }
    const network::mojom::URLResponseHead* head = loader_->ResponseInfo();
    const net::HttpResponseHeaders* headers = head ? head->headers.get() : nullptr;
    fetched.status = headers ? headers->response_code() : 0;
    fetched.too_large = loader_->NetError() == net::ERR_INSUFFICIENT_RESOURCES;
    return fetched;
  }

  void OnString(std::optional<std::string> body) {
    Fetched fetched = Outcome();
    if (fetched.status == 200 && loader_ && loader_->NetError() == net::OK) {
      fetched.body = std::move(body);
    }
    Finish(std::move(fetched));
  }

  void OnFile(base::FilePath path) {
    Fetched fetched = Outcome();
    fetched.saved = !path.empty() && fetched.status == 200 && loader_ && loader_->NetError() == net::OK;
    Finish(std::move(fetched));
  }

  void Finish(Fetched fetched) {
    weak_factory_.InvalidateWeakPtrs();
    loader_.reset();
    if (done_) {
      std::move(done_).Run(std::move(fetched));
    }
  }

  const bool release_;
  Done done_;
  std::unique_ptr<network::SimpleURLLoader> loader_;
  base::WeakPtrFactory<Fetch> weak_factory_{this};
};

base::Value Nullable(const std::string& text) {
  return text.empty() ? base::Value() : base::Value(text);
}

base::Value CheckFailure(std::string_view reason, std::string_view message) {
  return base::Value(base::DictValue().Set("status", "failed").Set("reason", reason).Set("message", message));
}

std::string_view FetchFailure(const Fetched& fetched) {
  if (fetched.too_large) {
    return policy::kTooLargeReason;
  }
  return policy::kNetworkReason;
}

class Service {
 public:
  static Service& Get() {
    static base::NoDestructor<Service> service;
    return *service;
  }

  void InstallKind(UpdateReply done) {
    WithInstallation(base::BindOnce(
        [](UpdateReply done, const Installation& installation) {
          std::move(done).Run(true, base::Value(installation.kind));
        },
        std::move(done)));
  }

  void Status(UpdateReply done) {
    WithInstallation(base::BindOnce(&Service::AnswerStatus, weak_factory_.GetWeakPtr(), std::move(done)));
  }

  void Check(UpdateReply done) {
    WithInstallation(base::BindOnce(&Service::CheckWith, weak_factory_.GetWeakPtr(), std::move(done)));
  }

  void Update(uint64_t build, UpdateReply done) {
    WithInstallation(base::BindOnce(&Service::UpdateWith, weak_factory_.GetWeakPtr(), build, std::move(done)));
  }

  bool Claim(int run) { return policy::ClaimOutcome(state_, run); }

  void Restart(UpdateReply done, base::OnceClosure quit) {
    if (!policy::ReadyToInstall(state_) || !installation_ || installation_->kind != policy::kInstallerKind) {
      return std::move(done).Run(true, base::Value(false));
    }
    if (ardiacore::BackgroundInstance()) {
      LOG(WARNING) << "Ardia updates: a background instance never runs the installer";
      return std::move(done).Run(true, base::Value(false));
    }
    const int run = state_.run;
    base::ThreadPool::PostTaskAndReplyWithResult(
        FROM_HERE, kFileTraits, base::BindOnce(&LaunchInstaller, installation_->app_data, *state_.offer),
        base::BindOnce(&Service::Launched, weak_factory_.GetWeakPtr(), run, std::move(done), std::move(quit)));
  }

 private:
  friend class base::NoDestructor<Service>;
  Service() = default;

  void WithInstallation(base::OnceCallback<void(const Installation&)> use) {
    if (installation_) {
      return std::move(use).Run(*installation_);
    }
    waiting_.push_back(std::move(use));
    if (waiting_.size() > 1) {
      return;
    }
    base::ThreadPool::PostTaskAndReplyWithResult(
        FROM_HERE, kFileTraits, base::BindOnce(&ReadInstallation, base::FilePath(AppDataDirectory())),
        base::BindOnce(&Service::InstallationRead, weak_factory_.GetWeakPtr()));
  }

  void InstallationRead(Installation installation) {
    installation_ = std::move(installation);
    std::vector<base::OnceCallback<void(const Installation&)>> waiting = std::move(waiting_);
    waiting_.clear();
    for (auto& use : waiting) {
      std::move(use).Run(*installation_);
    }
  }

  void AnswerStatus(UpdateReply done, const Installation& installation) {
    base::DictValue status;
    status.Set("phase", policy::PhaseName(state_.phase));
    status.Set("kind", installation.kind);
    status.Set("reason", Nullable(state_.reason));
    status.Set("run", state_.run);
    status.Set("version", state_.offer ? base::Value(state_.offer->version) : base::Value());
    status.Set("build", state_.offer ? base::Value(static_cast<double>(state_.offer->build)) : base::Value());
    status.Set("bytes", state_.offer ? base::Value(static_cast<double>(state_.offer->bytes)) : base::Value());
    if (installation.identity) {
      status.Set("current", base::DictValue()
                                .Set("version", installation.identity->version)
                                .Set("build", static_cast<double>(installation.identity->build)));
    } else {
      status.Set("current", base::Value());
    }
    status.Set("background", ardiacore::BackgroundInstance());
    status.Set("isolated", base::CommandLine::ForCurrentProcess()->HasSwitch(ardiacore::kDataDirSwitch));
    status.Set("testFeed", installation.test_feed);
    std::move(done).Run(true, base::Value(std::move(status)));
  }

  void CheckWith(UpdateReply done, const Installation& installation) {
    if (installation.kind == policy::kUnsupportedKind || !installation.identity) {
      return std::move(done).Run(
          true, CheckFailure(policy::kMissingReason, "this copy of Ardia has no update verifier, key or build file"));
    }
    const std::optional<int> check = policy::BeginCheck(state_);
    if (!check) {
      return std::move(done).Run(true, base::Value(base::DictValue().Set("status", "busy")));
    }
    check_reply_ = std::move(done);
    fetch_ = std::make_unique<Fetch>(installation.feed.manifest, installation.feed.release,
                                     base::BindOnce(&Service::ManifestFetched, weak_factory_.GetWeakPtr(), *check));
    fetch_->ToString(policy::kManifestLimit);
  }

  void ManifestFetched(int check, Fetched fetched) {
    fetch_.reset();
    if (!fetched.body) {
      if (fetched.status == 404 && installation_->feed.release) {
        return FinishCheck(check, policy::Verdict::kUpToDate, policy::Offer{},
                           base::Value(base::DictValue().Set("status", "notPublished")), "");
      }
      const std::string_view reason = FetchFailure(fetched);
      return FinishCheck(check, policy::Verdict::kFailed, policy::Offer{},
                         CheckFailure(reason, reason == policy::kTooLargeReason ? "the update feed is too large"
                                                                                : "the update feed could not be fetched"),
                         reason);
    }
    pending_manifest_ = std::move(*fetched.body);
    fetch_ = std::make_unique<Fetch>(installation_->feed.signature, installation_->feed.release,
                                     base::BindOnce(&Service::SignatureFetched, weak_factory_.GetWeakPtr(), check));
    fetch_->ToString(policy::kSignatureBytes);
  }

  void SignatureFetched(int check, Fetched fetched) {
    fetch_.reset();
    if (!fetched.body || fetched.body->size() != policy::kSignatureBytes) {
      const bool signature = fetched.body || fetched.too_large || fetched.status == 404;
      const std::string_view reason = signature ? policy::kSignatureReason : policy::kNetworkReason;
      return FinishCheck(check, policy::Verdict::kFailed, policy::Offer{},
                         CheckFailure(reason, signature ? "the update signature is missing or invalid"
                                                        : "the update signature could not be fetched"),
                         reason);
    }
    base::ThreadPool::PostTaskAndReplyWithResult(
        FROM_HERE, kFileTraits,
        base::BindOnce(&VerifyManifest, *installation_, std::move(pending_manifest_), std::move(*fetched.body)),
        base::BindOnce(&Service::ManifestVerified, weak_factory_.GetWeakPtr(), check));
    pending_manifest_.clear();
  }

  void ManifestVerified(int check, Verified verified) {
    const policy::VerifierAnswer& answer = verified.answer;
    if (answer.verdict == policy::Verdict::kOk) {
      manifest_ = std::move(verified.manifest);
      signature_ = std::move(verified.signature);
      return FinishCheck(check, answer.verdict, answer.offer,
                         base::Value(base::DictValue()
                                         .Set("status", "ok")
                                         .Set("version", answer.offer.version)
                                         .Set("build", static_cast<double>(answer.offer.build))
                                         .Set("bytes", static_cast<double>(answer.offer.bytes))),
                         "");
    }
    if (answer.verdict == policy::Verdict::kUpToDate) {
      return FinishCheck(check, answer.verdict, policy::Offer{},
                         base::Value(base::DictValue().Set("status", "upToDate")), "");
    }
    return FinishCheck(check, answer.verdict, policy::Offer{},
                       CheckFailure(answer.reason, "the update feed did not pass verification"), answer.reason);
  }

  void FinishCheck(int check, policy::Verdict verdict, const policy::Offer& offer, base::Value reply,
                   std::string_view reason) {
    policy::CheckFinished(state_, check, verdict, offer, reason);
    if (verdict != policy::Verdict::kOk) {
      manifest_.clear();
      signature_.clear();
    }
    if (check_reply_) {
      std::move(check_reply_).Run(true, std::move(reply));
    }
  }

  void UpdateWith(uint64_t build, UpdateReply done, const Installation& installation) {
    if (installation.kind != policy::kInstallerKind) {
      return AnswerStatus(std::move(done), installation);
    }
    const std::optional<int> run = policy::BeginDownload(state_, build);
    if (run) {
      base::ThreadPool::PostTaskAndReplyWithResult(
          FROM_HERE, kFileTraits, base::BindOnce(&PrepareInstallerFolder, installation.app_data, *state_.offer),
          base::BindOnce(&Service::FolderPrepared, weak_factory_.GetWeakPtr(), *run));
    }
    AnswerStatus(std::move(done), installation);
  }

  void FolderPrepared(int run, Prepared prepared) {
    if (state_.run != run || !state_.offer) {
      return;
    }
    if (!prepared.reason.empty()) {
      return policy::DownloadFinished(state_, run, false, prepared.reason);
    }
    if (prepared.complete) {
      return Downloaded(run, prepared.updates, true, Fetched{});
    }
    const base::FilePath partial(prepared.updates + L"\\" +
                                 base::UTF8ToWide(policy::PartialFileName(state_.offer->sha256)));
    fetch_ = std::make_unique<Fetch>(state_.offer->url, installation_->feed.release,
                                     base::BindOnce(&Service::Downloaded, weak_factory_.GetWeakPtr(), run,
                                                    prepared.updates, false));
    fetch_->ToFile(partial, state_.offer->bytes);
  }

  void Downloaded(int run, std::wstring updates, bool already_there, Fetched fetched) {
    fetch_.reset();
    if (state_.run != run || !state_.offer) {
      return;
    }
    if (!already_there && !fetched.saved) {
      return policy::DownloadFinished(state_, run, false, FetchFailure(fetched));
    }
    base::ThreadPool::PostTaskAndReplyWithResult(
        FROM_HERE, kFileTraits,
        base::BindOnce(&FinishInstaller, *installation_, std::move(updates), *state_.offer, manifest_, signature_,
                       already_there),
        base::BindOnce(&Service::InstallerChecked, weak_factory_.GetWeakPtr(), run));
  }

  void InstallerChecked(int run, std::string reason) {
    policy::DownloadFinished(state_, run, reason.empty(), reason);
  }

  void Launched(int run, UpdateReply done, base::OnceClosure quit, std::string reason) {
    if (!reason.empty()) {
      LOG(WARNING) << "Ardia updates: the installer did not start: " << reason;
      policy::InstallRefused(state_, run, reason);
      return std::move(done).Run(true, base::Value(false));
    }
    std::move(done).Run(true, base::Value(true));
    base::SequencedTaskRunner::GetCurrentDefault()->PostTask(FROM_HERE, std::move(quit));
  }

  std::optional<Installation> installation_;
  std::vector<base::OnceCallback<void(const Installation&)>> waiting_;
  policy::UpdateState state_;
  std::unique_ptr<Fetch> fetch_;
  UpdateReply check_reply_;
  std::string pending_manifest_;
  std::string manifest_;
  std::string signature_;
  base::WeakPtrFactory<Service> weak_factory_{this};
};

std::optional<int> RunArgument(const base::ListValue& args) {
  if (args.size() != 1) {
    return std::nullopt;
  }
  if (args[0].is_int()) {
    return args[0].GetInt();
  }
  if (!args[0].is_double()) {
    return std::nullopt;
  }
  const double value = args[0].GetDouble();
  if (!std::isfinite(value) || value < 0 || value > 1e9 || std::floor(value) != value) {
    return std::nullopt;
  }
  return static_cast<int>(value);
}

std::optional<uint64_t> BuildArgument(const base::ListValue& args) {
  if (args.size() != 1) {
    return std::nullopt;
  }
  double value = 0;
  if (args[0].is_int()) {
    value = args[0].GetInt();
  } else if (args[0].is_double()) {
    value = args[0].GetDouble();
  } else {
    return std::nullopt;
  }
  if (!std::isfinite(value) || std::floor(value) != value || value < 1 ||
      value > static_cast<double>(policy::kLargestBuild)) {
    return std::nullopt;
  }
  return static_cast<uint64_t>(value);
}

}

bool HandlesUpdateCall(std::string_view method) {
  return std::ranges::any_of(kUpdateCapabilities, [method](std::string_view listed) { return listed == method; });
}

void InvokeUpdates(std::string_view method, const base::ListValue& args, UpdateReply done, base::OnceClosure quit) {
  if (method == "ArdiaUpdates.installKind") {
    if (!args.empty()) {
      return std::move(done).Run(false, base::Value("installKind takes no arguments"));
    }
    return Service::Get().InstallKind(std::move(done));
  }
  if (method == "ArdiaUpdates.status") {
    if (!args.empty()) {
      return std::move(done).Run(false, base::Value("status takes no arguments"));
    }
    return Service::Get().Status(std::move(done));
  }
  if (method == "ArdiaUpdates.check") {
    if (!args.empty()) {
      return std::move(done).Run(false, base::Value("check takes no arguments"));
    }
    return Service::Get().Check(std::move(done));
  }
  if (method == "ArdiaUpdates.update") {
    const std::optional<uint64_t> build = BuildArgument(args);
    if (!build) {
      return std::move(done).Run(false, base::Value("update takes a build number"));
    }
    return Service::Get().Update(*build, std::move(done));
  }
  if (method == "ArdiaUpdates.claimOutcome") {
    const std::optional<int> run = RunArgument(args);
    if (!run) {
      return std::move(done).Run(false, base::Value("claimOutcome takes a run number"));
    }
    return std::move(done).Run(true, base::Value(Service::Get().Claim(*run)));
  }
  if (method == "ArdiaUpdates.restart") {
    if (!args.empty()) {
      return std::move(done).Run(false, base::Value("restart takes no arguments"));
    }
    return Service::Get().Restart(std::move(done), std::move(quit));
  }
  std::move(done).Run(false, base::Value("Unknown update method"));
}

}
