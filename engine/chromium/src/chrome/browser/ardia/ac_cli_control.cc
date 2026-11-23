// Copyright 2026 Ardia. Apache-2.0.

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>

#include <algorithm>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

#include "ardia/core/ac_content_hooks.h"
#include "ardia/core/ac_launch_switches.h"
#include "base/base64url.h"
#include "base/command_line.h"
#include "base/containers/span.h"
#include "base/files/file_path.h"
#include "base/files/file_util.h"
#include "base/files/scoped_file.h"
#include "base/functional/bind.h"
#include "base/functional/callback.h"
#include "base/json/json_writer.h"
#include "base/no_destructor.h"
#include "base/path_service.h"
#include "base/posix/eintr_wrapper.h"
#include "base/process/process_handle.h"
#include "base/rand_util.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/strcat.h"
#include "base/strings/string_split.h"
#include "base/strings/string_util.h"
#include "base/synchronization/lock.h"
#include "base/task/sequenced_task_runner.h"
#include "base/task/single_thread_task_runner.h"
#include "base/task/thread_pool.h"
#include "base/time/time.h"
#include "base/timer/timer.h"
#include "build/build_config.h"
#include "ardia/core/ac_host_visibility.h"
#include "ardia/core/ac_windowless_page.h"
#include "chrome/browser/ardia/ac_cli_owned_tabs.h"
#include "chrome/browser/ardia/ac_cli_token_policy.h"
#include "chrome/browser/ardia/ac_engine.h"
#include "chrome/browser/browser_process.h"
#include "chrome/browser/lifetime/termination_notification.h"
#include "chrome/common/chrome_paths.h"
#include "chrome/common/pref_names.h"
#include "components/prefs/pref_change_registrar.h"
#include "components/prefs/pref_service.h"
#include "content/public/browser/browser_thread.h"
#include "content/public/browser/devtools_agent_host.h"
#include "content/public/browser/devtools_socket_factory.h"
#include "content/public/browser/web_contents.h"
#include "content/public/common/content_switches.h"
#include "crypto/secure_util.h"
#include "net/base/net_errors.h"
#include "net/log/net_log_source.h"
#include "net/socket/tcp_server_socket.h"

#if BUILDFLAG(IS_MAC)
#include <membership.h>
#include <sys/acl.h>
#include <sys/mount.h>
#include <uuid/uuid.h>
#endif

namespace ardia {
namespace {

constexpr char kControlFileName[] = "ArdiaControl.json";
constexpr char kTopic[] = "cliControl";
constexpr int kBacklog = 10;
constexpr base::TimeDelta kStartDeadline = base::Seconds(5);
constexpr char kPolicyError[] =
    "Remote debugging is turned off by your administrator.";

base::Lock& PublishLock() {
  static base::NoDestructor<base::Lock> lock;
  return *lock;
}

uint64_t g_live_generation = 0;

void SetLiveGeneration(uint64_t generation) {
  base::AutoLock hold(PublishLock());
  g_live_generation = generation;
}

class LoopbackSocketFactory : public content::DevToolsSocketFactory {
 public:
  std::unique_ptr<net::ServerSocket> CreateForHttpServer() override {
    auto socket =
        std::make_unique<net::TCPServerSocket>(nullptr, net::NetLogSource());
    if (socket->ListenWithAddressAndPort("127.0.0.1", 0, kBacklog) !=
        net::OK) {
      return nullptr;
    }
    return socket;
  }

  std::unique_ptr<net::ServerSocket> CreateForTethering(
      std::string* name) override {
    return nullptr;
  }
};

base::FilePath ControlFilePath() {
  base::FilePath dir;
  if (!base::PathService::Get(chrome::DIR_USER_DATA, &dir)) {
    return base::FilePath();
  }
  return dir.Append(kControlFileName);
}

std::string ErrnoText() {
  return base::ToLowerASCII(strerror(errno));
}

#if BUILDFLAG(IS_MAC)
enum class AclState { kNone, kDenyOnly, kAllows, kUnknown };

AclState ExtendedAcl(int fd) {
  acl_t acl = acl_get_fd_np(fd, ACL_TYPE_EXTENDED);
  if (!acl) {
    return errno == ENOENT || errno == ENOTSUP ? AclState::kNone
                                               : AclState::kUnknown;
  }
  uuid_t owner;
  const bool owner_known = mbr_uid_to_uuid(geteuid(), owner) == 0;
  AclState state = AclState::kDenyOnly;
  acl_entry_t entry;
  for (int id = ACL_FIRST_ENTRY; acl_get_entry(acl, id, &entry) == 0;
       id = ACL_NEXT_ENTRY) {
    acl_tag_t tag;
    if (acl_get_tag_type(entry, &tag) != 0) {
      state = AclState::kAllows;
      break;
    }
    if (tag == ACL_EXTENDED_DENY) {
      continue;
    }
    void* qualifier = acl_get_qualifier(entry);
    const bool only_owner =
        tag == ACL_EXTENDED_ALLOW && qualifier && owner_known &&
        uuid_compare(*static_cast<uuid_t*>(qualifier), owner) == 0;
    if (qualifier) {
      acl_free(qualifier);
    }
    if (!only_owner) {
      state = AclState::kAllows;
      break;
    }
  }
  acl_free(acl);
  return state;
}
#endif

#if BUILDFLAG(IS_LINUX)
bool OthersBypassPermissions(int dir_fd) {
  std::string fdinfo;
  if (!base::ReadFileToString(
          base::FilePath(base::StrCat(
              {"/proc/self/fdinfo/", base::NumberToString(dir_fd)})),
          &fdinfo)) {
    return true;
  }
  std::string mount_id;
  for (std::string_view line : base::SplitStringPiece(
           fdinfo, "\n", base::TRIM_WHITESPACE, base::SPLIT_WANT_NONEMPTY)) {
    if (base::StartsWith(line, "mnt_id:")) {
      mount_id = std::string(base::TrimWhitespaceASCII(
          line.substr(strlen("mnt_id:")), base::TRIM_ALL));
    }
  }
  std::string mounts;
  if (mount_id.empty() ||
      !base::ReadFileToString(base::FilePath("/proc/self/mountinfo"),
                              &mounts)) {
    return true;
  }
  for (std::string_view line : base::SplitStringPiece(
           mounts, "\n", base::TRIM_WHITESPACE, base::SPLIT_WANT_NONEMPTY)) {
    const std::vector<std::string_view> fields = base::SplitStringPiece(
        line, " ", base::TRIM_WHITESPACE, base::SPLIT_WANT_NONEMPTY);
    if (fields.empty() || fields[0] != mount_id) {
      continue;
    }
    const auto dash = std::ranges::find(fields, std::string_view("-"));
    if (dash == fields.end() || fields.end() - dash < 4) {
      return true;
    }
    const std::string_view type = *(dash + 1);
    if (type != "fuse" && !base::StartsWith(type, "fuse.") &&
        type != "fuseblk") {
      return false;
    }
    const std::vector<std::string_view> options = base::SplitStringPiece(
        *(dash + 3), ",", base::TRIM_WHITESPACE, base::SPLIT_WANT_NONEMPTY);
    const auto has = [&options](std::string_view option) {
      return std::ranges::find(options, option) != options.end();
    };
    return has("allow_other") && !has("default_permissions");
  }
  return true;
}
#endif

std::string UnsafeControlFolder(int dir_fd, const base::FilePath& dir) {
  struct stat info;
  if (fstat(dir_fd, &info) != 0) {
    return base::StrCat({"Couldn't read ", dir.value(), ": ", ErrnoText()});
  }
  if (!S_ISDIR(info.st_mode)) {
    return base::StrCat({dir.value(), " isn't a folder."});
  }
  if (info.st_uid != geteuid()) {
    return base::StrCat({dir.value(), " belongs to another user."});
  }
  if (info.st_mode & (S_IWGRP | S_IWOTH)) {
    return base::StrCat({"Others can write to ", dir.value(), "."});
  }
#if BUILDFLAG(IS_LINUX)
  if (OthersBypassPermissions(dir_fd)) {
    return base::StrCat(
        {dir.value(), " is on a shared mount that doesn't check permissions "
                      "(allow_other without default_permissions), so other "
                      "users could read the control token there."});
  }
#endif
#if BUILDFLAG(IS_MAC)
  struct statfs volume;
  if (fstatfs(dir_fd, &volume) != 0) {
    return base::StrCat({"Couldn't read ", dir.value(), ": ", ErrnoText()});
  }
  if (volume.f_flags & MNT_IGNORE_OWNERSHIP) {
    return base::StrCat(
        {dir.value(), " is on a disk that ignores ownership, so anyone "
                      "could read the control token there."});
  }
  if (const AclState acl = ExtendedAcl(dir_fd);
      acl != AclState::kNone && acl != AclState::kDenyOnly) {
    return base::StrCat({dir.value(),
                         " has an access list that lets someone else in."});
  }
#endif
  return std::string();
}

bool OnlyOwnerCanRead(int fd) {
  if (fchmod(fd, S_IRUSR | S_IWUSR) != 0) {
    return false;
  }
#if BUILDFLAG(IS_MAC)
  if (ExtendedAcl(fd) != AclState::kNone) {
    acl_t empty = acl_init(0);
    if (!empty) {
      return false;
    }
    const bool cleared = acl_set_fd_np(fd, empty, ACL_TYPE_EXTENDED) == 0;
    acl_free(empty);
    if (!cleared || ExtendedAcl(fd) != AclState::kNone) {
      return false;
    }
  }
#endif
  struct stat info;
  return fstat(fd, &info) == 0 && S_ISREG(info.st_mode) &&
         info.st_uid == geteuid() &&
         (info.st_mode & 07777) == (S_IRUSR | S_IWUSR);
}

base::ScopedFD& PublishedFolder() {
  static base::NoDestructor<base::ScopedFD> folder;
  return *folder;
}

std::string WriteControlFile(const base::FilePath& path,
                             const std::string& contents,
                             uint64_t generation) {
  if (path.empty()) {
    return "Ardia has no data folder.";
  }
  const base::FilePath dir_path = path.DirName();
  base::ScopedFD dir(HANDLE_EINTR(
      open(dir_path.value().c_str(), O_RDONLY | O_DIRECTORY | O_CLOEXEC)));
  if (!dir.is_valid()) {
    return base::StrCat({"Couldn't open ", dir_path.value(), ": ", ErrnoText()});
  }
  if (std::string unsafe = UnsafeControlFolder(dir.get(), dir_path);
      !unsafe.empty()) {
    return unsafe;
  }
  const std::string name = path.BaseName().value();
  const std::string temp =
      "." + name + "." + base::HexEncode(base::RandBytesAsVector(8));
  const int fd = HANDLE_EINTR(
      openat(dir.get(), temp.c_str(),
             O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600));
  if (fd < 0) {
    return base::StrCat({"Couldn't write ", path.value(), ": ", ErrnoText()});
  }
  bool written = OnlyOwnerCanRead(fd);
  std::string error =
      written ? std::string() : "it couldn't be made readable only by you";
  if (written) {
    written = base::WriteFileDescriptor(fd, contents) && fsync(fd) == 0;
    error = written ? std::string() : ErrnoText();
  }
  if (IGNORE_EINTR(close(fd)) != 0 && written) {
    written = false;
    error = ErrnoText();
  }
  if (!written) {
    unlinkat(dir.get(), temp.c_str(), 0);
    return base::StrCat({"Couldn't write ", path.value(), ": ", error});
  }
  {
    base::AutoLock hold(PublishLock());
    if (g_live_generation != generation) {
      unlinkat(dir.get(), temp.c_str(), 0);
      return "The control server stopped.";
    }
    if (renameat(dir.get(), temp.c_str(), dir.get(), name.c_str()) != 0) {
      error = ErrnoText();
      unlinkat(dir.get(), temp.c_str(), 0);
      return base::StrCat({"Couldn't write ", path.value(), ": ", error});
    }
  }
  PublishedFolder() = std::move(dir);
  return std::string();
}

void DeleteStaleControlFile(const base::FilePath& path) {
  if (!path.empty() && unlink(path.value().c_str()) != 0 && errno != ENOENT &&
      errno != EISDIR && errno != EPERM) {
    PLOG(ERROR) << "[ardia] can't delete " << path;
  }
}

void DeleteControlFile(const base::FilePath& path) {
  base::ScopedFD published = std::move(PublishedFolder());
  if (path.empty() || !published.is_valid()) {
    return;
  }
  if (unlinkat(published.get(), path.BaseName().value().c_str(), 0) != 0 &&
      errno != ENOENT && errno != EISDIR && errno != EPERM) {
    PLOG(ERROR) << "[ardia] can't delete " << path;
  }
}

bool ServerStartedBySwitch() {
  return base::CommandLine::ForCurrentProcess()->HasSwitch(
      ::switches::kRemoteDebuggingPort);
}

class ControlServer {
 public:
  enum class State { kStopped, kStarting, kPublishing, kRunning, kStopping };

  static ControlServer& Get() {
    static base::NoDestructor<ControlServer> server;
    return *server;
  }

  ControlServer() {
    g_ardia_devtools_token_factory = &IsOurFactory;
    g_ardia_devtools_token_accepts = &Accepts;
    g_ardia_devtools_token_server = &ServerChanged;
    g_ardia_devtools_active_target = &ActiveTarget;
    g_ardia_devtools_token_client = &TokenClientFor;
    terminating_ = browser_shutdown::AddAppTerminatingCallback(
        base::BindOnce(&ControlServer::Quit, base::Unretained(this)));
    if (PrefService* local_state = LocalState()) {
      policy_.Init(local_state);
      policy_.Add(prefs::kDevToolsRemoteDebuggingAllowed,
                  base::BindRepeating(&ControlServer::PolicyChanged,
                                      base::Unretained(this)));
    }
    if (!ServerStartedBySwitch()) {
      FileRunner()->PostTask(
          FROM_HERE, base::BindOnce(&DeleteStaleControlFile, file_path_));
    }
  }

  void Enable(Reply reply) {
    if (ServerStartedBySwitch() || quitting_) {
      return reply.Send(Status());
    }
    if (!Allowed()) {
      error_ = kPolicyError;
      return reply.Send(Status());
    }
    if (state_ == State::kRunning) {
      return reply.Send(Status());
    }
    pending_.push_back(std::move(reply));
    if (Active()) {
      return;
    }
    if (PrefService* local_state = LocalState()) {
      local_state->ClearPref(prefs::kDevToolsRemoteDebuggingEnabled);
    }
    ++generation_;
    SetLiveGeneration(generation_);
    error_.clear();
    std::vector<uint8_t> secret = base::RandBytesAsVector(32);
    token_.clear();
    base::Base64UrlEncode(secret, base::Base64UrlEncodePolicy::OMIT_PADDING,
                          &token_);
    auto factory = std::make_unique<LoopbackSocketFactory>();
    factory_ = factory.get();
    state_ = State::kStarting;
    deadline_.Start(FROM_HERE, kStartDeadline,
                    base::BindOnce(&ControlServer::StartTimedOut,
                                   base::Unretained(this), generation_));
    content::DevToolsAgentHost::StartRemoteDebuggingServer(
        std::move(factory), base::FilePath(), base::FilePath(),
        content::DevToolsAgentHost::RemoteDebuggingServerMode::kDefault);
    Announce();
  }

  void Disable() {
    if (ServerStartedBySwitch()) {
      return;
    }
    if (state_ != State::kStopped) {
      error_.clear();
    }
    Stop();
  }

  base::DictValue Status() const {
    base::DictValue status;
    status.Set("dragsEnded",
               base::DictValue()
                   .Set("ownerGone", g_ardia_drags_ended[kArdiaDragEndOwnerGone])
                   .Set("debuggerUnowned",
                        g_ardia_drags_ended[kArdiaDragEndDebuggerUnowned])
                   .Set("nativeRefused",
                        g_ardia_drags_ended[kArdiaDragEndNativeRefused])
                   .Set("sourceGone",
                        g_ardia_drags_ended[kArdiaDragEndSourceGone]));
    const ardiacore::WindowlessPageTotals windowless =
        ardiacore::WindowlessPagesSoFar();
    status.Set("windowlessPages", base::DictValue()
                                      .Set("given", windowless.given)
                                      .Set("missed", windowless.missed));
    status.Set("tokenCommands", TokenCommandTotals());
    if (ardiacore::TestFlag("nativeDragRefused")) {
      status.Set("nativeDragsRefused", true);
    }
    if (ServerStartedBySwitch()) {
      status.Set("state", "external");
      return status;
    }
    switch (state_) {
      case State::kStopped:
      case State::kStopping:
        status.Set("state", "off");
        break;
      case State::kStarting:
      case State::kPublishing:
        status.Set("state", "starting");
        break;
      case State::kRunning:
        status.Set("state", "on");
        status.Set("port", port_);
        break;
    }
    status.Set("connections", static_cast<int>(connections_));
    status.Set("generation", static_cast<int>(generation_));
    status.Set("file", file_path_.value());
    if (!error_.empty()) {
      status.Set("reason", error_);
    }
    return status;
  }

 private:
  static PrefService* LocalState() {
    return g_browser_process ? g_browser_process->local_state() : nullptr;
  }

  static bool Allowed() {
    PrefService* local_state = LocalState();
    return local_state &&
           local_state->GetBoolean(prefs::kDevToolsRemoteDebuggingAllowed);
  }

  bool Active() const {
    return state_ == State::kStarting || state_ == State::kPublishing ||
           state_ == State::kRunning;
  }

  static bool IsOurFactory(const content::DevToolsSocketFactory* factory) {
    ControlServer& self = Get();
    return factory && factory == self.factory_ &&
           self.state_ == State::kStarting;
  }

  static std::unique_ptr<ArdiaDevToolsTokenClient> TokenClientFor(
      const content::DevToolsSocketFactory* factory,
      content::DevToolsAgentHostClient* client,
      content::DevToolsAgentHost* host) {
    ControlServer& self = Get();
    if (!factory || factory != self.factory_ ||
        self.state_ != State::kRunning) {
      return nullptr;
    }
    return CreateTokenClient(client, host);
  }

  static bool Accepts(const content::DevToolsSocketFactory* factory,
                      std::string_view token) {
    ControlServer& self = Get();
    if (!factory || factory != self.factory_ ||
        self.state_ != State::kRunning || self.token_.empty() ||
        token.size() != self.token_.size()) {
      return false;
    }
    return crypto::SecureMemEqual(base::as_byte_span(token),
                                  base::as_byte_span(self.token_));
  }

 public:
  void SetActiveTab(std::optional<int> tab_id) {
    active_.reset();
    if (!tab_id) {
      return;
    }
    if (content::WebContents* contents = TabWithId(*tab_id)) {
      active_ = contents->GetWeakPtr();
    }
  }

  static bool ActiveTarget(const content::DevToolsSocketFactory* factory,
                           std::string_view token,
                           std::string* target_id) {
    if (!Accepts(factory, token)) {
      return false;
    }
    target_id->clear();
    if (content::WebContents* contents = Get().active_.get()) {
      *target_id =
          content::DevToolsAgentHost::GetOrCreateFor(contents)->GetId();
    }
    return true;
  }

 private:
  static void ServerChanged(const content::DevToolsSocketFactory* factory,
                            std::string_view browser_path,
                            int port,
                            size_t connections) {
    Get().OnServerChanged(factory, browser_path, port, connections);
  }

  void OnServerChanged(const content::DevToolsSocketFactory* factory,
                       std::string_view browser_path,
                       int port,
                       size_t connections) {
    if (!factory || factory != factory_ || !Active()) {
      return;
    }
    if (port <= 0) {
      const bool failed_to_start = state_ == State::kStarting;
      error_ = failed_to_start ? "Couldn't listen on 127.0.0.1."
                               : "The control server stopped.";
      Reset();
      if (failed_to_start) {
        base::SingleThreadTaskRunner::GetCurrentDefault()->PostTask(
            FROM_HERE, base::BindOnce(&ControlServer::ClearFailedServer,
                                      base::Unretained(this), generation_));
      }
      Settle();
      return;
    }
    if (state_ == State::kStarting) {
      state_ = State::kPublishing;
      port_ = port;
      connections_ = 0;
      base::DictValue file;
      file.Set("port", port);
      file.Set("browser", std::string(browser_path));
      file.Set("token", token_);
      file.Set("pid", static_cast<int>(base::GetCurrentProcId()));
      file.Set("generation", static_cast<int>(generation_));
      FileRunner()->PostTaskAndReplyWithResult(
          FROM_HERE,
          base::BindOnce(&WriteControlFile, file_path_,
                         base::WriteJson(file).value_or("{}"), generation_),
          base::BindOnce(&ControlServer::Published, base::Unretained(this),
                         generation_));
      return;
    }
    if (state_ == State::kRunning && connections_ != connections) {
      connections_ = connections;
      Announce();
    }
  }

  void Published(uint64_t generation, const std::string& error) {
    if (generation != generation_ || state_ != State::kPublishing) {
      return;
    }
    if (!error.empty()) {
      error_ = error;
      Stop();
      return;
    }
    deadline_.Stop();
    state_ = State::kRunning;
    Settle();
  }

  void Stop() {
    if (Active()) {
      state_ = State::kStopping;
      token_.clear();
      factory_ = nullptr;
      SetLiveGeneration(0);
      content::DevToolsAgentHost::StopRemoteDebuggingServer();
    }
    Reset();
    Settle();
  }

  void Reset() {
    deadline_.Stop();
    state_ = State::kStopped;
    token_.clear();
    factory_ = nullptr;
    SetLiveGeneration(0);
    port_ = 0;
    connections_ = 0;
    FileRunner()->PostTask(FROM_HERE,
                           base::BindOnce(&DeleteControlFile, file_path_));
  }

  void Announce() {
    if (!quitting_) {
      Emit(kTopic, nullptr, Status());
    }
  }

  void Settle() {
    base::DictValue status = Status();
    std::vector<Reply> pending = std::move(pending_);
    pending_.clear();
    for (Reply& reply : pending) {
      reply.Send(status.Clone());
    }
    Announce();
  }

  void StartTimedOut(uint64_t generation) {
    if (generation != generation_ ||
        (state_ != State::kStarting && state_ != State::kPublishing)) {
      return;
    }
    error_ = "The control server didn't start.";
    Stop();
  }

  void ClearFailedServer(uint64_t generation) {
    if (generation == generation_ && state_ == State::kStopped) {
      content::DevToolsAgentHost::StopRemoteDebuggingServer();
    }
  }

  void PolicyChanged() {
    if (!Allowed() && Active()) {
      error_ = kPolicyError;
      Stop();
    }
  }

  void Quit() {
    quitting_ = true;
    policy_.RemoveAll();
    if (!ServerStartedBySwitch()) {
      Stop();
    }
  }

  scoped_refptr<base::SequencedTaskRunner> FileRunner() {
    if (!file_runner_) {
      file_runner_ = base::ThreadPool::CreateSequencedTaskRunner(
          {base::MayBlock(), base::TaskPriority::USER_BLOCKING,
           base::TaskShutdownBehavior::BLOCK_SHUTDOWN});
    }
    return file_runner_;
  }

  State state_ = State::kStopped;
  uint64_t generation_ = 0;
  std::string token_;
  raw_ptr<const content::DevToolsSocketFactory> factory_ = nullptr;
  int port_ = 0;
  size_t connections_ = 0;
  std::string error_;
  bool quitting_ = false;
  const base::FilePath file_path_ = ControlFilePath();
  std::vector<Reply> pending_;
  base::OneShotTimer deadline_;
  base::WeakPtr<content::WebContents> active_;
  PrefChangeRegistrar policy_;
  base::CallbackListSubscription terminating_;
  scoped_refptr<base::SequencedTaskRunner> file_runner_;
};

}
}

AC_ARGS_CALL(ac_cli_control) {
  ardia::Reply out = call.TakeReply();
  const base::DictValue& args = call.args();
  ardia::ControlServer& server = ardia::ControlServer::Get();
  if (const base::Value* active = args.Find("active")) {
    server.SetActiveTab(active->is_int() && active->GetInt() >= 0
                            ? std::optional<int>(active->GetInt())
                            : std::nullopt);
  }
  std::optional<bool> on = args.FindBool("on");
  if (on.value_or(false)) {
    return server.Enable(std::move(out));
  }
  if (on.has_value()) {
    server.Disable();
  }
  out.Send(server.Status());
}

AC_ARGS_CALL(ac_cli_owns_tab) {
  ardia::Reply out = call.TakeReply();
  std::optional<int> tab = call.args().FindInt("tab");
  content::WebContents* contents = tab ? ardia::TabWithId(*tab) : nullptr;
  out.Send(base::DictValue()
               .Set("owned", ardia::IsCliOwnedTab(contents))
               .Set("shown",
                    contents && ardiacore::TabWasInShownSlot(contents)));
}
