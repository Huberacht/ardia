#include "ardia/win/main.h"

#include <windows.h>

#include <share.h>
#include <stdio.h>

#include <memory>
#include <string>
#include <string_view>
#include <utility>

#include "ardia/core/ac_hooks.h"
#include "ardia/core/ac_launch_switches.h"
#include "ardia/win/api.h"
#include "ardia/win/external_apps.h"
#include "ardia/win/frame_view.h"
#include "ardia/win/hooks.h"
#include "ardia/win/host.h"
#include "ardia/win/kept_pages.h"
#include "ardia/win/launch_guard.h"
#include "ardia/win/renderer_efficiency.h"
#include "ardia/win/test_gate.h"
#include "ardia/win/webui/webui_mode.h"
#include "ardia/win/webui/webui_shell.h"
#include "ardia/win/webui/webui_window_policy.h"
#include "base/base_paths.h"
#include "base/base_paths_win.h"
#include "base/base_switches.h"
#include "base/command_line.h"
#include "base/files/file_path.h"
#include "base/files/file_util.h"
#include "base/functional/bind.h"
#include "base/location.h"
#include "base/logging.h"
#include "base/no_destructor.h"
#include "base/path_service.h"
#include "base/strings/utf_string_conversions.h"
#include "base/process/launch.h"
#include "base/process/process.h"
#include "base/task/sequenced_task_runner.h"
#include "base/time/time.h"
#include "base/values.h"
#include "chrome/browser/devtools/chrome_devtools_manager_delegate.h"
#include "chrome/install_static/user_data_dir.h"
#include "chrome/browser/chrome_browser_main.h"
#include "chrome/browser/chrome_browser_main_extra_parts.h"
#include "chrome/browser/lifetime/application_lifetime_desktop.h"
#include "chrome/browser/ui/browser_window/public/browser_window_interface.h"
#include "chrome/common/chrome_switches.h"
#include "components/keep_alive_registry/keep_alive_types.h"
#include "components/keep_alive_registry/scoped_keep_alive.h"
#include "components/url_formatter/url_fixer.h"
#include "content/public/common/content_switches.h"
#include "media/base/media_switches.h"
#include "url/gurl.h"

namespace base {
extern bool (*g_ardia_pre_translate_message)(const MSG& msg);
}

namespace ardia_win {

namespace {

int& RequestedExitCode() {
  static int exit_code = 0;
  return exit_code;
}

struct Gate {
  std::string refusal = "no scratch ARDIA_DATA_DIR";
  bool asked = false;
  std::string port;
};

Gate& TheGate() {
  static base::NoDestructor<Gate> gate;
  return *gate;
}

std::unique_ptr<ScopedKeepAlive>& KeepAlive() {
  static base::NoDestructor<std::unique_ptr<ScopedKeepAlive>> keep_alive;
  return *keep_alive;
}

std::wstring Environment(const wchar_t* name) {
  std::wstring value(32768, L'\0');
  DWORD length = ::GetEnvironmentVariableW(name, value.data(),
                                          static_cast<DWORD>(value.size()));
  if (length == 0 || length >= value.size()) {
    return std::wstring();
  }
  value.resize(length);
  return value;
}

bool Set(const std::wstring& value) {
  return !value.empty() && value != L"0";
}

void AddFeatures(base::CommandLine* command_line,
                 const char* switch_name,
                 std::string_view features) {
  std::string all = command_line->GetSwitchValueASCII(switch_name);
  if (!all.empty()) {
    all.push_back(',');
  }
  all.append(features);
  command_line->AppendSwitchASCII(switch_name, all);
}

constexpr const char* kSwitchesThatOpenTheProfile[] = {
    "allow-insecure-localhost",
    "auto-open-devtools-for-tabs",
    "custom-devtools-frontend",
    "devtools-flags",
    "disable-extensions-except",
    "disable-web-security",
    "enable-automation",
    "enable-ui-devtools",
    "extensions-on-chrome-urls",
    "extensions-on-extension-urls",
    "host-resolver-rules",
    "host-rules",
    "ignore-certificate-errors",
    "ignore-certificate-errors-spki-list",
    "load-apps",
    "load-extension",
    "log-net-log",
    "net-log-capture-mode",
    "proxy-pac-url",
    "proxy-server",
    "remote-allow-origins",
    "remote-debugging-address",
    "remote-debugging-io-pipes",
    "remote-debugging-pipe",
    "remote-debugging-port",
    "remote-debugging-socket-name",
    "remote-debugging-targets",
    "silent-debugger-extension-api",
    "ssl-key-log-file",
    "unsafely-treat-insecure-origin-as-secure",
    "webtransport-developer-mode",
};

bool BrowserProcess(const base::CommandLine& command_line) {
  return command_line.GetSwitchValueNative(switches::kProcessType).empty();
}

std::wstring ChromiumUserDataDir() {
  std::wstring user_data_dir;
  std::wstring invalid;
  if (!install_static::GetUserDataDirectory(&user_data_dir, &invalid) ||
      !invalid.empty()) {
    return std::wstring();
  }
  return user_data_dir;
}

constexpr const char* kWindowsSwitchesThatOpenTheProfile[] = {
    "browser-subprocess-path",
    "gpu-launcher",
    "no-sandbox",
    "renderer-cmd-prefix",
    "utility-cmd-prefix",
};

void KeepRealProfileClosed(base::CommandLine* command_line) {
  if (TheGate().refusal.empty()) {
    return;
  }
  for (const char* name : kSwitchesThatOpenTheProfile) {
    command_line->RemoveSwitch(name);
  }
  for (const char* name : kWindowsSwitchesThatOpenTheProfile) {
    command_line->RemoveSwitch(name);
  }
  ::SetEnvironmentVariableW(L"SSLKEYLOGFILE", nullptr);
  if (::GetEnvironmentVariableW(L"SSLKEYLOGFILE", nullptr, 0) != 0) {
    LOG(ERROR) << "Ardia engine: SSLKEYLOGFILE could not be cleared outside "
                  "a test instance; not starting";
    base::Process::TerminateCurrentProcessImmediately(1);
  }
}

void DecideTestGate(base::CommandLine* command_line) {
  for (const char* forbidden :
       {switches::kRemoteDebuggingPort, switches::kRemoteDebuggingPipe,
        "remote-allow-origins", kTestInstanceSwitch, ardiacore::kTestSwitch,
        ardiacore::kTraceSwitch, ardiacore::kDataDirSwitch}) {
    command_line->RemoveSwitch(forbidden);
  }
  std::wstring data_dir = Environment(L"ARDIA_DATA_DIR");
  while (!data_dir.empty() &&
         (data_dir.back() == L'\\' || data_dir.back() == L'/')) {
    data_dir.pop_back();
  }
  const std::wstring port = Environment(L"ARDIA_REMOTE_DEBUGGING_PORT");
  const std::wstring test = Environment(L"ARDIA_TEST");
  const std::wstring trace = Environment(L"ARDIA_TRACE");
  Gate& gate = TheGate();
  std::wstring refusal = TestGateRefusal(data_dir, ChromiumUserDataDir());
  if (refusal.empty()) {
    refusal = HoldScratchFolders(data_dir, ChromiumUserDataDir());
  }
  gate.refusal = base::WideToUTF8(refusal);
  gate.asked = !port.empty() || !test.empty() || !trace.empty();
  KeepRealProfileClosed(command_line);
  if (!gate.refusal.empty()) {
    return;
  }
  command_line->AppendSwitch(kTestInstanceSwitch);
  if (!port.empty()) {
    command_line->AppendSwitchNative(switches::kRemoteDebuggingPort, port);
    command_line->AppendSwitchASCII("remote-allow-origins", "*");
    gate.port = base::WideToUTF8(port);
  }
  if (!test.empty()) {
    command_line->AppendSwitchNative(ardiacore::kTestSwitch, test);
  }
  if (!trace.empty()) {
    command_line->AppendSwitchNative(ardiacore::kTraceSwitch, trace);
  }
}

void WriteLaunchLog(const std::string& line) {
  std::wstring path =
      base::CommandLine::ForCurrentProcess()->GetSwitchValueNative("log-file");
  if (path.empty()) {
    path = LaunchLogPath();
  }
  if (path.empty()) {
    return;
  }
  FILE* file = _wfsopen(path.c_str(), L"ab", _SH_DENYNO);
  if (!file) {
    return;
  }
  const std::string text = "engine 0 " + line + "\n";
  fwrite(text.data(), 1, text.size(), file);
  fclose(file);
}

void SaveLaunchGuardFacts(const LaunchGuardFacts& facts) {
  const std::wstring data_dir = AppDataDirectory();
  if (data_dir.empty()) {
    return;
  }
  const std::string json =
      "{\"waitedForPreviousMs\":" +
      std::to_string(facts.predecessor_wait_ms < 0 ? 0
                                                    : facts.predecessor_wait_ms) +
      ",\"unfinishedStartsBefore\":" +
      std::to_string(facts.unfinished_starts_before) +
      ",\"restoreStateSetAside\":" +
      (facts.recovered_to.empty() ? "false" : "true") +
      ",\"profileHeldByAnother\":" +
      (facts.profile_held_by_another ? "true" : "false") + "}\n";
  FILE* file = nullptr;
  if (_wfopen_s(&file, (data_dir + L"\\launch-guard.json").c_str(), L"wb") !=
          0 ||
      !file) {
    return;
  }
  fwrite(json.data(), 1, json.size(), file);
  fclose(file);
}

void NoteLaunchGuard() {
  const LaunchGuardFacts& facts = GuardFacts();
  SaveLaunchGuardFacts(facts);
  WriteLaunchLog("launch guard: waited " +
                 std::to_string(facts.predecessor_wait_ms < 0
                                    ? 0
                                    : facts.predecessor_wait_ms) +
                 " ms for a previous Ardia, " +
                 std::to_string(facts.unfinished_starts_before) +
                 " unfinished starts before this one, restore state " +
                 (facts.recovered_to.empty() ? "kept" : "set aside"));
}

void NoteTestGate() {
  const Gate& gate = TheGate();
  if (!gate.refusal.empty() && !gate.asked) {
    return;
  }
  const std::string facts =
      std::string("; ardiacore test instance: ") +
      (ardiacore::TestInstance() ? "yes" : "no") +
      "; reauth=granted honoured: " +
      (ardiacore::TestValue("reauth") == "granted" ? "yes" : "no");
  std::string line =
      gate.refusal.empty()
          ? "test gate: a test instance; remote debugging port: " +
                (gate.port.empty() ? std::string("none") : gate.port) + facts
          : "test gate: ARDIA_REMOTE_DEBUGGING_PORT, ARDIA_TEST and "
            "ARDIA_TRACE ignored: not a test instance (" +
                gate.refusal + ")" + facts;
  LOG(WARNING) << "Ardia engine " << line;
  WriteLaunchLog(line);
}

void ClaimGuardUntilOwned(int attempts_left) {
  ClaimGuard();
  if (OwnsGuard() || attempts_left <= 0) {
    return;
  }
  base::SequencedTaskRunner::GetCurrentDefault()->PostDelayedTask(
      FROM_HERE, base::BindOnce(&ClaimGuardUntilOwned, attempts_left - 1),
      base::Milliseconds(kClaimRetryMs));
}

class WebUIMainParts : public ChromeBrowserMainExtraParts {
 public:
  WebUIMainParts() = default;
  WebUIMainParts(const WebUIMainParts&) = delete;
  WebUIMainParts& operator=(const WebUIMainParts&) = delete;
  ~WebUIMainParts() override = default;

  void PreEarlyInitialization() override {
    KeepRealProfileClosed(base::CommandLine::ForCurrentProcess());
  }

  void PreBrowserStart() override {
    KeepAlive() = std::make_unique<ScopedKeepAlive>(
        KeepAliveOrigin::APP_CONTROLLER, KeepAliveRestartOption::DISABLED);
    RegisterWebUIShell();
  }

  void PostBrowserStart() override {
    NoteTestGate();
    NoteLaunchGuard();
    WriteLaunchLog("webui shell: started");
    ClaimGuardUntilOwned(kClaimAttempts);
    StartRendererEfficiency();
    base::g_ardia_pre_translate_message = &WebUIShellPreTranslate;
    OpenWebUIShell();
  }

  void PostMainMessageLoopRun() override {
    base::g_ardia_pre_translate_message = nullptr;
    CloseWebUIShell();
    MarkExiting();
    KeepAlive().reset();
  }
};

void AddWebUIMainParts(ChromeBrowserMainParts* main_parts) {
  main_parts->AddParts(std::make_unique<WebUIMainParts>());
}

base::ListValue WebUIRelaunchUrls(const base::CommandLine& command_line,
                             const base::FilePath& cur_dir) {
  base::ListValue urls;
  for (const base::CommandLine::StringType& argument :
       command_line.GetArgs()) {
    GURL url(base::WideToUTF8(argument));
    if (!url.is_valid()) {
      url = url_formatter::FixupRelativeFile(cur_dir,
                                             base::FilePath(argument));
    }
    if (url.is_valid() &&
        webui_window::RelaunchUrlAccepted(url.scheme(), url.spec().size(),
                                          urls.size())) {
      urls.Append(url.spec());
    }
  }
  return urls;
}

bool WebUIRelaunched(const base::CommandLine& command_line,
                     const base::FilePath& cur_dir) {
  ClearExiting();
  OpenWebUIShellWithUrls(WebUIRelaunchUrls(command_line, cur_dir));
  return true;
}

std::wstring LocalAppDataDirectory() {
  const std::wstring from_environment = Environment(L"LOCALAPPDATA");
  if (!from_environment.empty()) {
    return from_environment;
  }
  base::FilePath local;
  if (!base::PathService::Get(base::DIR_LOCAL_APP_DATA, &local)) {
    return std::wstring();
  }
  return local.value();
}

constexpr char kWebUIRelaunchedSwitch[] = "ardia-webui-relaunched";

std::wstring WebUIAppData() {
  return WebUIAppDataDirectory(Environment(L"ARDIA_DATA_DIR"),
                               LocalAppDataDirectory());
}

void RefuseReactNativeFolders(const std::wstring& app_data,
                              const std::wstring& user_data) {
  const std::wstring clash = ReactNativeFolderClash({app_data, user_data});
  if (clash.empty()) {
    return;
  }
  LOG(ERROR) << "Ardia engine: " << base::WideToUTF8(clash)
             << "; the WebUI shell is not starting";
  base::Process::TerminateCurrentProcessImmediately(1);
}

void RefuseShellModeDisagreement(bool webui) {
  const bool early = install_static::IsWebUIShellCommandLine(::GetCommandLineW());
  const bool reparsed = WebUIShellRequested(
      base::CommandLine::FromString(::GetCommandLineW()));
  if (webui == early && reparsed == early) {
    return;
  }
  LOG(ERROR) << "Ardia engine: install_static read the shell mode as "
             << (early ? "webui" : "a child process") << " and Chromium as "
             << (webui ? "webui" : "a child process") << "; not starting";
  base::Process::TerminateCurrentProcessImmediately(1);
}

void RelaunchIntoWebUIProfile() {
  const std::wstring app_data = WebUIAppData();
  const std::wstring user_data = WebUIUserDataDirectory(app_data);
  if (user_data.empty()) {
    base::Process::TerminateCurrentProcessImmediately(1);
  }
  RefuseReactNativeFolders(app_data, user_data);
  if (SameFolder(user_data, ChromiumUserDataDir())) {
    return;
  }
  base::CommandLine relaunch = base::CommandLine::FromString(::GetCommandLineW());
  base::FilePath program;
  if (!base::PathService::Get(base::FILE_EXE, &program)) {
    base::Process::TerminateCurrentProcessImmediately(1);
  }
  relaunch.SetProgram(program);
  if (relaunch.HasSwitch(kWebUIRelaunchedSwitch)) {
    LOG(ERROR) << "Ardia engine: the WebUI shell's profile folder was not "
                  "taken after a relaunch; not starting";
    base::Process::TerminateCurrentProcessImmediately(1);
  }
  relaunch.RemoveSwitch(switches::kUserDataDir);
  relaunch.AppendSwitchNative(switches::kUserDataDir, user_data);
  relaunch.AppendSwitch(kWebUIRelaunchedSwitch);
  base::LaunchOptions options;
  options.grant_foreground_privilege = true;
  const base::Process child = base::LaunchProcess(relaunch, options);
  base::Process::TerminateCurrentProcessImmediately(child.IsValid() ? 0 : 1);
}

void BeforeWebUIChromeMain(base::CommandLine* command_line) {
  command_line->RemoveSwitch(kWebUIRelaunchedSwitch);
  const std::wstring app_data = WebUIAppData();
  const std::wstring user_data = WebUIUserDataDirectory(app_data);
  if (user_data.empty() || !SameFolder(user_data, ChromiumUserDataDir())) {
    LOG(ERROR) << "Ardia engine: the WebUI shell has no profile folder of its "
                  "own; not starting";
    base::Process::TerminateCurrentProcessImmediately(1);
  }
  RefuseReactNativeFolders(app_data, user_data);
  SetAppDataDirectory(app_data);
  base::CreateDirectory(base::FilePath(app_data));
  RefuseReactNativeFolders(app_data, user_data);
  GuardBrowserLaunch(user_data, command_line);
  command_line->RemoveSwitch(switches::kUserDataDir);
  command_line->AppendSwitchNative(switches::kUserDataDir, user_data);
  command_line->RemoveSwitch(ardiacore::kDataDirSwitch);
  command_line->AppendSwitchNative(ardiacore::kDataDirSwitch, app_data);
  command_line->AppendSwitch(switches::kNoStartupWindow);
  command_line->AppendSwitch(switches::kNoFirstRun);
  command_line->AppendSwitch(switches::kNoDefaultBrowserCheck);
  command_line->AppendSwitch(switches::kHideCrashRestoreBubble);
  AddFeatures(command_line, switches::kDisableFeatures,
              "CalculateNativeWinOcclusion");
  if (Set(Environment(L"ARDIA_BACKGROUND"))) {
    command_line->AppendSwitch(ardiacore::kBackgroundSwitch);
    command_line->AppendSwitch(switches::kMuteAudio);
  }
  g_ardia_win_add_main_parts = &AddWebUIMainParts;
  g_ardia_win_relaunched = &WebUIRelaunched;
  InstallWebUIShellHooks();
}

}

void NoteForTest(const std::string& line) {
  if (ardiacore::TestInstance()) {
    WriteLaunchLog(line);
  }
}

void BeforeChromeMain() {
  base::CommandLine* command_line = base::CommandLine::ForCurrentProcess();
  if (!BrowserProcess(*command_line)) {
    return;
  }
  command_line->RemoveSwitch(switches::kProcessType);
  RefuseShellModeDisagreement(WebUIShellRequested(*command_line));
  RelaunchIntoWebUIProfile();
  DecideTestGate(command_line);
  BeforeWebUIChromeMain(command_line);
}

void AfterChromeMain(int exit_code) {
  if (!g_ardia_win_add_main_parts) {
    return;
  }
  base::Process::TerminateCurrentProcessImmediately(
      exit_code != 0 ? exit_code : RequestedExitCode());
}

const char* TestGateDecision() {
  return TheGate().refusal.c_str();
}

void QuitApp() {
  MarkExiting();
  MarkStartSettled();
  KeepAlive().reset();
  ChromeDevToolsManagerDelegate::AllowBrowserToClose();
  chrome::CloseAllBrowsersAndQuit();
}

void QuitAppWithExitCode(int exit_code) {
  RequestedExitCode() = exit_code;
  QuitApp();
}

}
