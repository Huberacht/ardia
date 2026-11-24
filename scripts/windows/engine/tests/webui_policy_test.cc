#include "ardia/desktop/ac_desktop_telemetry_policy.h"
#include "ardia/win/webui/webui_policy.h"

#include <cassert>
#include <iostream>
#include <string>
#include <vector>

namespace {

using namespace ardia_win;

void TestDocumentNames() {
  assert(ValidWindowsDocumentName("telemetry.json"));
  assert(ValidWindowsDocumentName("rnw-migration-attempt.json"));
  assert(ValidWindowsDocumentName("rnw-migration-reported.json"));
  assert(ValidWindowsDocumentName("rnw-migration.json"));
  assert(ValidWindowsDocumentName("sync-state.nns"));
  assert(ValidWindowsDocumentName("perf-probe"));
  assert(ValidWindowsDocumentName("dev-console.log"));
  assert(ValidWindowsDocumentName("a_b-c.1.json"));
  assert(ValidWindowsDocumentName(std::string(kWindowsDocumentNameLimit, 'a')));

  assert(!ValidWindowsDocumentName(""));
  assert(!ValidWindowsDocumentName(std::string(kWindowsDocumentNameLimit + 1, 'a')));
  assert(!ValidWindowsDocumentName("."));
  assert(!ValidWindowsDocumentName(".."));
  assert(!ValidWindowsDocumentName("a..b.json"));
  assert(!ValidWindowsDocumentName(".hidden.json"));
  assert(!ValidWindowsDocumentName("trailing."));
  assert(!ValidWindowsDocumentName(" leading.json"));
  assert(!ValidWindowsDocumentName("trailing.json "));
  assert(!ValidWindowsDocumentName("has space.json"));
  assert(!ValidWindowsDocumentName("a/b.json"));
  assert(!ValidWindowsDocumentName("a\\b.json"));
  assert(!ValidWindowsDocumentName("..\\escape.json"));
  assert(!ValidWindowsDocumentName("../escape.json"));
  assert(!ValidWindowsDocumentName("foo:bar.json"));
  assert(!ValidWindowsDocumentName("foo.json:$DATA"));
  assert(!ValidWindowsDocumentName(std::string("a\0b.json", 8)));
  assert(!ValidWindowsDocumentName("a\nb.json"));
  assert(!ValidWindowsDocumentName("a\rb.json"));
  assert(!ValidWindowsDocumentName("a\tb.json"));
  assert(!ValidWindowsDocumentName("a*b.json"));
  assert(!ValidWindowsDocumentName("a?b.json"));

  for (const char* device : {
           "CON", "con", "Con.json", "CON.tar.gz", "PRN", "prn.txt", "AUX",
           "aux.json", "NUL", "nul.json", "COM0", "COM1", "com9.json", "LPT0",
           "LPT1", "lpt9.json", "CONIN$", "CONOUT$",
       }) {
    assert(!ValidWindowsDocumentName(device));
  }
  assert(ValidWindowsDocumentName("console.json"));
  assert(ValidWindowsDocumentName("com10.json"));
  assert(ValidWindowsDocumentName("lpt10.json"));
  assert(ValidWindowsDocumentName("null.json"));

  assert(ReservedWindowsDocumentName("session.json"));
  assert(ReservedWindowsDocumentName("SESSION.JSON"));
  assert(ReservedWindowsDocumentName("live.json"));
  assert(ReservedWindowsDocumentName("LIVE.JSON"));
  assert(ReservedWindowsDocumentName("live.canonical.json"));
  assert(ReservedWindowsDocumentName("Live.Canonical.Json"));
  assert(ReservedWindowsDocumentName("rnw-migration.lock"));
  assert(ReservedWindowsDocumentName("RNW-MIGRATION.LOCK"));
  assert(!ReservedWindowsDocumentName("rnw-migration-attempt.json"));
  assert(!ReservedWindowsDocumentName("rnw-migration-reported.json"));
  assert(!ReservedWindowsDocumentName("launch-guard.json"));

  assert(BootstrapDocumentEligible("rnw-migration-attempt.json"));
  assert(BootstrapDocumentEligible("telemetry.json"));
  assert(!BootstrapDocumentEligible("session.json"));
  assert(!BootstrapDocumentEligible("live.json"));
  assert(!BootstrapDocumentEligible("live.canonical.json"));
  assert(!BootstrapDocumentEligible("rnw-migration.lock"));
  assert(!BootstrapDocumentEligible("sync-state.nns"));
  assert(!BootstrapDocumentEligible("staging.tmp"));
  assert(!BootstrapDocumentEligible("staging.TMP"));
  assert(!BootstrapDocumentEligible("staging.partial"));
  assert(!BootstrapDocumentEligible("CON.json"));

  assert(WindowsDocumentLimit("telemetry.json") == kWindowsDocumentDefaultLimit);
  assert(WindowsDocumentLimit("sync-state.nns") == kWindowsSyncStateDocumentLimit);

  assert(ValidWindowsAssetPath("index.html"));
  assert(ValidWindowsAssetPath("assets/index-123.js"));
  assert(!ValidWindowsAssetPath(""));
  assert(!ValidWindowsAssetPath("/index.html"));
  assert(!ValidWindowsAssetPath("assets/"));
  assert(!ValidWindowsAssetPath("assets//index.js"));
  assert(!ValidWindowsAssetPath("../secret.json"));
  assert(!ValidWindowsAssetPath("assets/../secret.json"));
  assert(!ValidWindowsAssetPath("assets\\index.js"));
  assert(!ValidWindowsAssetPath("CON/index.html"));
  assert(!ValidWindowsAssetPath("assets/NUL.json"));
}

void TestCanonicalPathContainment() {
  assert(NormalizeWinFinalPath(L"\\\\?\\C:\\app\\ardia-ui") ==
         L"C:\\app\\ardia-ui");
  assert(NormalizeWinFinalPath(L"\\\\?\\C:\\app\\ardia-ui\\") ==
         L"C:\\app\\ardia-ui");
  assert(NormalizeWinFinalPath(L"\\\\?\\C:\\") == L"C:\\");
  assert(NormalizeWinFinalPath(L"\\\\?\\UNC\\server\\share\\ardia-ui\\") ==
         L"\\\\server\\share\\ardia-ui");
  assert(NormalizeWinFinalPath(L"\\\\?\\unc\\server\\share") ==
         L"\\\\server\\share");
  assert(NormalizeWinFinalPath(
             L"\\\\?\\Volume{01234567-89ab-cdef-0123-456789abcdef}\\ui\\") ==
         L"\\\\?\\Volume{01234567-89ab-cdef-0123-456789abcdef}\\ui");

  assert(!NormalizeWinFinalPath(L""));
  assert(!NormalizeWinFinalPath(L"relative\\path"));
  assert(!NormalizeWinFinalPath(L"\\rooted-without-drive"));
  assert(!NormalizeWinFinalPath(L"C:relative"));
  assert(!NormalizeWinFinalPath(L"\\\\?\\"));
  assert(!NormalizeWinFinalPath(L"\\\\?\\UNC\\"));
  assert(!NormalizeWinFinalPath(L"\\\\?\\UNC\\server"));
  assert(!NormalizeWinFinalPath(L"\\\\.\\PhysicalDrive0"));
  assert(!NormalizeWinFinalPath(L"\\\\server"));
  assert(!NormalizeWinFinalPath(L"C:\\app\\..\\secret"));
  assert(!NormalizeWinFinalPath(L"C:\\app\\.\\index.html"));
  assert(!NormalizeWinFinalPath(L"C:\\app\\\\index.html"));
  assert(!NormalizeWinFinalPath(std::wstring_view(L"C:\\app\0evil", 11)));

  assert(IsStrictlyWithinWinDirectory(L"\\\\?\\C:\\app\\ardia-ui",
                                      L"\\\\?\\C:\\app\\ardia-ui\\index.html"));
  assert(IsStrictlyWithinWinDirectory(
      L"\\\\?\\C:\\app\\ardia-ui\\",
      L"\\\\?\\c:\\APP\\ARDIA-UI\\assets\\app.js"));
  assert(IsStrictlyWithinWinDirectory(
      L"\\\\?\\UNC\\files\\ardia\\ui",
      L"\\\\?\\UNC\\FILES\\ARDIA\\UI\\assets\\app.js"));
  assert(IsStrictlyWithinWinDirectory(L"C:\\", L"C:\\index.html"));
  assert(IsStrictlyWithinWinDirectory(
      L"\\\\?\\Volume{11111111-1111-1111-1111-111111111111}\\",
      L"\\\\?\\Volume{11111111-1111-1111-1111-111111111111}\\a\\b.js"));

  assert(!IsStrictlyWithinWinDirectory(L"\\\\?\\C:\\app\\ardia-ui",
                                       L"\\\\?\\C:\\app\\ardia-ui"));
  assert(!IsStrictlyWithinWinDirectory(L"\\\\?\\C:\\app\\ardia-ui",
                                       L"\\\\?\\C:\\app\\ardia-ui\\"));
  assert(!IsStrictlyWithinWinDirectory(L"\\\\?\\C:\\app\\ardia-ui",
                                       L"\\\\?\\C:\\app\\ardia-ui-evil\\x.js"));
  assert(!IsStrictlyWithinWinDirectory(L"\\\\?\\C:\\app\\ardia-ui",
                                       L"\\\\?\\C:\\elsewhere\\secret.json"));
  assert(!IsStrictlyWithinWinDirectory(L"\\\\?\\C:\\app\\ardia-ui",
                                       L"\\\\?\\D:\\app\\ardia-ui\\index.html"));
  assert(!IsStrictlyWithinWinDirectory(L"\\\\?\\UNC\\srv\\share",
                                       L"\\\\?\\UNC\\srv\\share-evil\\x.js"));
  assert(!IsStrictlyWithinWinDirectory(L"C:\\", L"C:\\"));
  assert(!IsStrictlyWithinWinDirectory(L"", L"C:\\a"));
  assert(!IsStrictlyWithinWinDirectory(L"C:\\a", L""));

  assert(IsDirectChildOfWinDirectory(L"\\\\?\\C:\\data",
                                     L"\\\\?\\C:\\data\\telemetry.json"));
  assert(!IsDirectChildOfWinDirectory(L"\\\\?\\C:\\data",
                                      L"\\\\?\\C:\\data\\sub\\telemetry.json"));
  assert(!IsDirectChildOfWinDirectory(L"\\\\?\\C:\\data",
                                      L"\\\\?\\C:\\data-evil\\telemetry.json"));
  assert(!IsDirectChildOfWinDirectory(L"\\\\?\\C:\\data", L"\\\\?\\C:\\data"));
}

void TestStartupMigrationPolicy() {
  assert(ShouldRunStartupMigration({false, false, false, false}));
  assert(ShouldRunStartupMigration({true, false, false, false}));
  assert(ShouldRunStartupMigration({false, false, false, true}));
  assert(!ShouldRunStartupMigration({false, false, true, false}));
  assert(!ShouldRunStartupMigration({true, false, true, false}));
  assert(!ShouldRunStartupMigration({false, false, true, true}));
  assert(ShouldRunStartupMigration({true, false, true, true}));
  assert(!ShouldRunStartupMigration({false, true, false, false}));
  assert(!ShouldRunStartupMigration({true, true, false, false}));
  assert(!ShouldRunStartupMigration({true, true, true, true}));

  const std::optional<std::vector<std::wstring>> standard_args =
      BuildStartupMigrationArguments(false, L"", L"", false);
  assert(standard_args.has_value());
  assert(*standard_args == std::vector<std::wstring>({L"--from-rnw"}));

  const std::optional<std::vector<std::wstring>> test_args =
      BuildStartupMigrationArguments(false, L"", L"", true);
  assert(test_args.has_value());
  assert(*test_args ==
         std::vector<std::wstring>({L"--from-rnw", L"--test-instance"}));

  assert(!BuildStartupMigrationArguments(true, L"", L"", false).has_value());
  assert(!BuildStartupMigrationArguments(true, L"", L"C:\\webui", false)
              .has_value());
  assert(!BuildStartupMigrationArguments(true, L"C:\\rnw", L"", false)
              .has_value());
  assert(!BuildStartupMigrationArguments(false, L"C:\\rnw", L"", false)
              .has_value());
  assert(!BuildStartupMigrationArguments(false, L"", L"C:\\webui", false)
              .has_value());

  const std::optional<std::vector<std::wstring>> custom_args =
      BuildStartupMigrationArguments(true, L"C:\\rnw data", L"C:\\webui data",
                                     true);
  assert(custom_args.has_value());
  assert(*custom_args == std::vector<std::wstring>({
                             L"--from-rnw",
                             L"--rnw-data",
                             L"C:\\rnw data",
                             L"--webui-data",
                             L"C:\\webui data",
                             L"--test-instance",
                         }));

  assert(QuoteWinCommandArg(L"--from-rnw") == L"--from-rnw");
  assert(QuoteWinCommandArg(L"C:\\Program Files\\Ardia\\bin.exe") ==
         L"\"C:\\Program Files\\Ardia\\bin.exe\"");
  assert(QuoteWinCommandArg(L"C:\\dir with space\\") ==
         L"\"C:\\dir with space\\\\\"");
  assert(QuoteWinCommandArg(L"") == L"\"\"");
  assert(BuildWinCommandLine(L"C:\\Program Files\\Ardia\\ardia-webui-migrate.exe",
                             *custom_args) ==
         L"\"C:\\Program Files\\Ardia\\ardia-webui-migrate.exe\" --from-rnw "
         L"--rnw-data \"C:\\rnw data\" --webui-data \"C:\\webui data\" "
         L"--test-instance");
}

void TestWinRenameHelpers() {
  assert(ValidWinRenameLeafName(L"telemetry.json"));
  assert(ValidWinRenameLeafName(L"a"));
  assert(!ValidWinRenameLeafName(L""));
  assert(!ValidWinRenameLeafName(L"."));
  assert(!ValidWinRenameLeafName(L".."));
  assert(!ValidWinRenameLeafName(L"a\\b.json"));
  assert(!ValidWinRenameLeafName(L"a/b.json"));
  assert(!ValidWinRenameLeafName(L"a:b.json"));
  assert(!ValidWinRenameLeafName(std::wstring_view(L"a\0b", 3)));
  assert(!ValidWinRenameLeafName(
      std::wstring(kWindowsDocumentNameLimit + 1, L'a')));

  assert(WinFileRenameInfoBufferBytes(20, 24, 1) == 24);
  assert(WinFileRenameInfoBufferBytes(20, 24, 2) == 24);
  assert(WinFileRenameInfoBufferBytes(20, 24, 3) == 26);
  assert(WinFileRenameInfoBufferBytes(20, 24, 14) == 48);
}

void TestDesktopTelemetryPolicy() {
  namespace telemetry = ardia::desktop_telemetry_policy;
  const std::string valid_key = "ak_app_0123456789abcdef01234567";
  assert(telemetry::IngestKeyAcceptable(valid_key));
  assert(!telemetry::IngestKeyAcceptable(""));
  assert(!telemetry::IngestKeyAcceptable("bad_key"));
  assert(!telemetry::IngestKeyAcceptable("ak_app_0123456789ABCDEF01234567"));
  assert(!telemetry::IngestKeyAcceptable(valid_key + "\r\nX-Injected: 1"));
  assert(telemetry::BodyAcceptable("{\"resourceLogs\":[]}"));
  assert(!telemetry::BodyAcceptable(""));
  assert(!telemetry::BodyAcceptable("[]"));
  assert(!telemetry::BodyAcceptable("{" + std::string(telemetry::kMaxBodyBytes, 'a')));
  assert(telemetry::PostAcceptable("{\"ok\":true}", valid_key));
  assert(!telemetry::PostAcceptable("not-json", valid_key));
  assert(!telemetry::PostAcceptable("{}", "invalid"));
  assert(telemetry::AdmitPost(0));
  assert(telemetry::AdmitPost(telemetry::kMaxInFlight - 1));
  assert(!telemetry::AdmitPost(telemetry::kMaxInFlight));
  assert(!telemetry::AdmitPost(-1));
  assert(telemetry::ReportedStatus(true, 200) == 200);
  assert(telemetry::ReportedStatus(true, 503) == 503);
  assert(telemetry::ReportedStatus(true, 302) == 0);
  assert(telemetry::ReportedStatus(false, 200) == 0);
}

void TestMaximizeButtonStateMachine() {
  MaximizeButtonStateMachine machine;
  assert(machine.state() == (MaximizeButtonVisualState{false, false}));

  assert(!machine.OnNcMouseMove(false));
  assert(machine.OnNcMouseMove(true));
  assert(machine.state() == (MaximizeButtonVisualState{true, false}));
  assert(!machine.OnNcMouseMove(true));

  assert(machine.OnNcLeftButtonDown(true));
  assert(machine.state() == (MaximizeButtonVisualState{true, true}));
  assert(!machine.OnNcLeftButtonDown(true));

  assert(!machine.OnNcMouseMove(true));
  assert(machine.state() == (MaximizeButtonVisualState{true, true}));

  assert(machine.OnNcLeftButtonUp(true));
  assert(machine.state() == (MaximizeButtonVisualState{true, false}));
  assert(!machine.OnNcLeftButtonUp(true));

  assert(machine.OnNcMouseLeave());
  assert(machine.state() == (MaximizeButtonVisualState{false, false}));
  assert(!machine.OnNcMouseLeave());

  assert(machine.OnNcLeftButtonDown(true));
  assert(machine.OnNcMouseMove(false));
  assert(machine.state() == (MaximizeButtonVisualState{false, false}));

  assert(machine.OnNcMouseMove(true));
  assert(machine.OnNcLeftButtonDown(true));
  assert(machine.Reset());
  assert(machine.state() == (MaximizeButtonVisualState{false, false}));
  assert(!machine.Reset());
}

}

int main() {
  TestDocumentNames();
  TestCanonicalPathContainment();
  TestStartupMigrationPolicy();
  TestWinRenameHelpers();
  TestDesktopTelemetryPolicy();
  TestMaximizeButtonStateMachine();
  std::cout << "webui_policy_test: all assertions passed\n";
  return 0;
}
