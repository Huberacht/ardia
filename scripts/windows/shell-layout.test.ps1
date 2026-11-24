$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "shell-layout.ps1")

$failures = @()

function Check([string]$Name, $Expected, $Actual) {
  if ("$Expected" -eq "$Actual") { Write-Host "pass: $Name" } else { $script:failures += "$Name`: expected '$Expected', got '$Actual'" }
}

function Check-Throws([string]$Name, [string]$Pattern, [scriptblock]$Action) {
  try {
    & $Action | Out-Null
    $script:failures += "$Name`: nothing was thrown"
  } catch {
    if ($_.Exception.Message -match $Pattern) { Write-Host "pass: $Name" } else { $script:failures += "$Name`: threw '$($_.Exception.Message)'" }
  }
}

function Touch([string]$Root, [string[]]$Names) {
  foreach ($name in $Names) {
    $path = Join-Path $Root $name
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $path) | Out-Null
    [System.IO.File]::WriteAllText($path, $name)
  }
}

function New-Folder([string]$Name) {
  $path = Join-Path $scratch $Name
  New-Item -ItemType Directory -Force -Path $path | Out-Null
  return $path
}

$scratch = Join-Path ([System.IO.Path]::GetTempPath()) ("ardia-shell-layout-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $scratch | Out-Null
try {
  $rnw = New-Folder "rnw"
  Touch $rnw "Ardia.exe", "ArdiaApp.dll", "chrome.dll"
  $webui = New-Folder "webui"
  Touch $webui "Ardia.exe", "chrome.dll", "ardia-ui\index.html", "ardia-ui\assets\app.js", "ardia-webui-migrate.exe"
  $mixed = New-Folder "mixed"
  Touch $mixed "Ardia.exe", "chrome.dll", "ArdiaApp.dll", "ardia-ui\index.html"
  $bare = New-Folder "bare"
  Touch $bare "chrome.exe", "chrome.dll"

  Check "a folder with ArdiaApp.dll is the React Native shell" "rnw" (Get-ShellLayout $rnw)
  Check "a folder with ardia-ui\index.html is the WebUI shell" "webui" (Get-ShellLayout $webui)
  Check "a folder with both is mixed" "mixed" (Get-ShellLayout $mixed)
  Check "a bare engine is neither" "none" (Get-ShellLayout $bare)
  Check "auto picks the WebUI shell from the folder" "webui" (Resolve-ShellLayout $webui "auto")
  Check "auto picks the React Native shell from the folder" "rnw" (Resolve-ShellLayout $rnw)
  Check-Throws "a mixed folder is refused" "both ArdiaApp.dll and ardia-ui" { Resolve-ShellLayout $mixed }
  Check-Throws "a bare engine is refused" "neither ArdiaApp.dll nor ardia-ui" { Resolve-ShellLayout $bare }
  Check-Throws "asking for the WebUI shell over a React Native folder is refused" "is the rnw shell, not the webui shell" { Resolve-ShellLayout $rnw "webui" }

  Check "the React Native shell launches with no switch" "" (Get-ShellLaunchSwitch "rnw")
  Check "the WebUI shell launches with --ardia-shell=webui" "--ardia-shell=webui" (Get-ShellLaunchSwitch "webui")
  Check "the React Native open command is the launcher alone" '"C:\A\Ardia.exe"' (Get-ShellOpenCommand "C:\A\Ardia.exe" "rnw")
  Check "the WebUI open command carries the switch" '"C:\A\Ardia.exe" --ardia-shell=webui' (Get-ShellOpenCommand "C:\A\Ardia.exe" "webui")
  Check "the React Native document command is unchanged" '"C:\A\Ardia.exe" --single-argument %1' (Get-ShellDocumentCommand "C:\A\Ardia.exe" "rnw")
  Check "the WebUI document command puts the switch before --single-argument" '"C:\A\Ardia.exe" --ardia-shell=webui --single-argument %1' (Get-ShellDocumentCommand "C:\A\Ardia.exe" "webui")
  Check "the React Native install ships ArdiaApp.dll" "Ardia.exe,ArdiaApp.dll,chrome.dll,Ardia.ico,Ardia.build.json,unins000.exe" ((Get-ShellInstalledFiles "rnw") -join ",")
  Check "the WebUI install ships the UI and the migrator" "Ardia.exe,chrome.dll,Ardia.ico,Ardia.build.json,unins000.exe,ardia-ui\index.html,ardia-webui-migrate.exe" ((Get-ShellInstalledFiles "webui") -join ",")

  Check "a complete WebUI folder has no problems" 0 (Get-ShellLayoutProblems $webui "webui").Count
  Check "a complete React Native folder has no problems" 0 (Get-ShellLayoutProblems $rnw "rnw").Count
  $noMigrator = New-Folder "no-migrator"
  Touch $noMigrator "Ardia.exe", "chrome.dll", "ardia-ui\index.html"
  Check "a WebUI folder without the migrator is a problem" "it has no ardia-webui-migrate.exe, so an upgrade from the React Native shell would start empty" ((Get-ShellLayoutProblems $noMigrator "webui") -join "|")
  $leftover = New-Folder "leftover"
  Touch $leftover "Ardia.exe", "chrome.exe", "chrome.dll", "ArdiaApp.dll", "ardia-ui\index.html", "ardia-webui-migrate.exe"
  Check "a WebUI folder with the React Native library or chrome.exe has two problems" 2 (Get-ShellLayoutProblems $leftover "webui").Count
  $rolledBack = New-Folder "rolled-back"
  Touch $rolledBack "Ardia.exe", "chrome.dll", "ArdiaApp.dll", "ardia-ui\index.html", "ardia-webui-migrate.exe"
  Check "a React Native folder that kept the WebUI files has two problems" 2 (Get-ShellLayoutProblems $rolledBack "rnw").Count
  $marked = New-Folder "marked"
  Touch $marked "Ardia.exe", "chrome.dll", "ardia-ui\index.html", "ardia-webui-migrate.exe", "sub\Ardia.test-build"
  Check "a test-build marker anywhere is a problem" 1 (Get-ShellLayoutProblems $marked "webui").Count
  Check "a test-build marker is allowed when asked" 0 (Get-ShellLayoutProblems $marked "webui" -AllowTestBuild).Count
  Check "an unknown shell is a problem" "'other' is not a shell: rnw or webui" ((Get-ShellLayoutProblems $webui "other") -join "|")

  $assemble = Join-Path $PSScriptRoot "assemble-webui.ps1"
  $engine = New-Folder "engine"
  Touch $engine "chrome.exe", "chrome.dll", "RUN.txt", "Ardia.test-build", "locales\en-US.pak"
  $ui = New-Folder "ui"
  Touch $ui "index.html", "assets\app.js"
  $migrator = Join-Path (New-Folder "migrator") "ardia-webui-migrate.exe"
  Touch (Split-Path -Parent $migrator) "ardia-webui-migrate.exe"

  $pilot = Join-Path $scratch "out-pilot"
  & $assemble -Engine $engine -Ui $ui -Out $pilot | Out-Null
  Check "a pilot assembly keeps chrome.exe" $true (Test-Path -LiteralPath (Join-Path $pilot "chrome.exe"))
  Check "a pilot assembly copies the UI as ardia-ui" $true (Test-Path -LiteralPath (Join-Path $pilot "ardia-ui\assets\app.js"))
  Check "a pilot assembly leaves out the engine's notes" $false (Test-Path -LiteralPath (Join-Path $pilot "RUN.txt"))
  Check "a pilot assembly without -TestBuild drops the engine's test marker" $false (Test-Path -LiteralPath (Join-Path $pilot "Ardia.test-build"))
  Check "a pilot assembly bundles no migrator unless asked" $false (Test-Path -LiteralPath (Join-Path $pilot "ardia-webui-migrate.exe"))
  Check "a pilot assembly copies the engine's folders" $true (Test-Path -LiteralPath (Join-Path $pilot "locales\en-US.pak"))

  $tested = Join-Path $scratch "out-test"
  & $assemble -Engine $engine -Ui $ui -Out $tested -MigrateBin $migrator -TestBuild | Out-Null
  Check "-TestBuild writes the marker" $true (Test-Path -LiteralPath (Join-Path $tested "Ardia.test-build"))
  Check "-MigrateBin bundles the migrator" $true (Test-Path -LiteralPath (Join-Path $tested "ardia-webui-migrate.exe"))

  Check-Throws "an assembly into a folder that is not empty is refused" "is not empty" { & $assemble -Engine $engine -Ui $ui -Out $pilot }
  Check-Throws "a shippable assembly without the migrator is refused" "needs -MigrateBin" { & $assemble -Engine $engine -Ui $ui -Out (Join-Path $scratch "out-a") -Shippable }
  Check-Throws "a shippable assembly that keeps chrome.exe is refused" "starts from Ardia.exe" { & $assemble -Engine $engine -Ui $ui -Out (Join-Path $scratch "out-b") -Shippable -LauncherName chrome.exe -MigrateBin $migrator }
  Check-Throws "a launcher name with a path is refused" "is not a plain .exe name" { & $assemble -Engine $engine -Ui $ui -Out (Join-Path $scratch "out-c") -LauncherName "..\Ardia.exe" }
  Check-Throws "a missing migrator is refused" "was not found" { & $assemble -Engine $engine -Ui $ui -Out (Join-Path $scratch "out-d") -MigrateBin (Join-Path $scratch "nothing.exe") }
  Check-Throws "a missing app icon is refused" "is not a file" { & $assemble -Engine $engine -Ui $ui -Out (Join-Path $scratch "out-e") -AppIcon (Join-Path $scratch "nothing.ico") }
  $withApp = New-Folder "engine-with-app"
  Touch $withApp "chrome.exe", "chrome.dll", "ArdiaApp.dll"
  Check-Throws "an engine that holds the React Native app is refused" "holds the React Native app" { & $assemble -Engine $withApp -Ui $ui -Out (Join-Path $scratch "out-f") }
  Check "nothing was written for a refused assembly" $false (Test-Path -LiteralPath (Join-Path $scratch "out-a"))

  $installer = Join-Path $PSScriptRoot "make-installer.ps1"
  Check-Throws "the installer refuses a WebUI build without the migrator" "is not a shippable WebUI build" { & $installer -Source $noMigrator -Out (Join-Path $scratch "setup") -Cpu x64 -Version 1.0.0 }
  Check-Throws "the installer refuses a folder that is both shells" "neither the React Native shell nor the WebUI shell" { & $installer -Source $mixed -Out (Join-Path $scratch "setup") -Cpu x64 -Version 1.0.0 }
  Check-Throws "the installer refuses a WebUI build asked for as React Native" "is the webui shell, not the rnw shell" { & $installer -Source $webui -Out (Join-Path $scratch "setup") -Cpu x64 -Version 1.0.0 -Shell rnw }
  Check-Throws "the installer refuses a WebUI build with a test marker" "Ardia.test-build marker" { & $installer -Source $marked -Out (Join-Path $scratch "setup") -Cpu x64 -Version 1.0.0 }

  $script = Get-Content -LiteralPath (Join-Path $PSScriptRoot "installer\Ardia.iss") -Raw
  Check "the installer script defaults to the React Native shell" $true ($script -match '#ifndef Shell\s+#define Shell "rnw"\s+#endif')
  Check "the React Native shell's launch switch is empty" $true ($script -match '#else\s+#define LaunchSwitch ""\s+#define OpenSuffix ""')
  Check "the WebUI installer clears a React Native install before copying" $true ($script -match "CurStep = ssInstall then\s+RemoveReactNativeShell")
  Check "the React Native installer removes the WebUI files on a rollback" $true ($script -match '#if Shell != "webui"\s+\[InstallDelete\]\s+Type: filesandordirs; Name: "\{app\}\\ardia-ui"')
} finally {
  Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue
}

if ($failures.Count) {
  $failures | ForEach-Object { Write-Host "::error::$_" }
  exit 1
}
Write-Host "The shell layouts, the WebUI assembly and the installer's refusals behave as the packaging expects."
