$ShellLayout = @{
  Launcher = "Ardia.exe"
  Engine = "chrome.dll"
  EngineLauncher = "chrome.exe"
  RnwLibrary = "ArdiaApp.dll"
  UiFolder = "ardia-ui"
  UiEntry = "ardia-ui\index.html"
  Migrator = "ardia-webui-migrate.exe"
  TestMarker = "Ardia.test-build"
  WebUISwitch = "--ardia-shell=webui"
  AppUserModelId = "Ardia.Browser"
}

function Get-ShellLayout([string]$root) {
  $rnw = Test-Path -LiteralPath (Join-Path $root $ShellLayout.RnwLibrary) -PathType Leaf
  $webui = Test-Path -LiteralPath (Join-Path $root $ShellLayout.UiEntry) -PathType Leaf
  if ($rnw -and $webui) { return "mixed" }
  if ($rnw) { return "rnw" }
  if ($webui) { return "webui" }
  return "none"
}

function Resolve-ShellLayout([string]$root, [string]$requested = "auto") {
  $found = Get-ShellLayout $root
  if (@("rnw", "webui") -notcontains $found) {
    $why = if ($found -eq "mixed") { "both $($ShellLayout.RnwLibrary) and $($ShellLayout.UiEntry)" } else { "neither $($ShellLayout.RnwLibrary) nor $($ShellLayout.UiEntry)" }
    throw "'$root' holds $why, so it is neither the React Native shell nor the WebUI shell"
  }
  if ($requested -and $requested -ne "auto" -and $requested -ne $found) { throw "'$root' is the $found shell, not the $requested shell asked for" }
  return $found
}

function Get-ShellLaunchSwitch([string]$shell) {
  if ($shell -eq "webui") { return $ShellLayout.WebUISwitch }
  return ""
}

function Get-ShellOpenCommand([string]$exe, [string]$shell) {
  $switch = Get-ShellLaunchSwitch $shell
  if ($switch) { return "`"$exe`" $switch" }
  return "`"$exe`""
}

function Get-ShellDocumentCommand([string]$exe, [string]$shell) {
  $switch = Get-ShellLaunchSwitch $shell
  if ($switch) { return "`"$exe`" $switch --single-argument %1" }
  return "`"$exe`" --single-argument %1"
}

function Get-ShellInstalledFiles([string]$shell) {
  if ($shell -eq "webui") { return @($ShellLayout.Launcher, $ShellLayout.Engine, "Ardia.ico", "Ardia.build.json", "unins000.exe", $ShellLayout.UiEntry, $ShellLayout.Migrator) }
  return @($ShellLayout.Launcher, $ShellLayout.RnwLibrary, $ShellLayout.Engine, "Ardia.ico", "Ardia.build.json", "unins000.exe")
}

function Find-TestMarkers([string]$root) {
  return @(Get-ChildItem -LiteralPath $root -Recurse -File -Force -Filter $ShellLayout.TestMarker -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
}

function Get-ShellLayoutProblems([string]$root, [string]$shell, [switch]$AllowTestBuild) {
  $problems = @()
  if (-not (Test-Path -LiteralPath $root -PathType Container)) { return ,@("'$root' is not a folder") }
  foreach ($name in $ShellLayout.Launcher, $ShellLayout.Engine) {
    if (-not (Test-Path -LiteralPath (Join-Path $root $name) -PathType Leaf)) { $problems += "it has no $name" }
  }
  if ($shell -eq "webui") {
    if (-not (Test-Path -LiteralPath (Join-Path $root $ShellLayout.UiEntry) -PathType Leaf)) { $problems += "it has no $($ShellLayout.UiEntry)" }
    if (-not (Test-Path -LiteralPath (Join-Path $root $ShellLayout.Migrator) -PathType Leaf)) { $problems += "it has no $($ShellLayout.Migrator), so an upgrade from the React Native shell would start empty" }
    if (Test-Path -LiteralPath (Join-Path $root $ShellLayout.RnwLibrary)) { $problems += "it still holds the React Native shell's $($ShellLayout.RnwLibrary)" }
    if (Test-Path -LiteralPath (Join-Path $root $ShellLayout.EngineLauncher)) { $problems += "it still holds $($ShellLayout.EngineLauncher) beside $($ShellLayout.Launcher)" }
  } elseif ($shell -eq "rnw") {
    if (-not (Test-Path -LiteralPath (Join-Path $root $ShellLayout.RnwLibrary) -PathType Leaf)) { $problems += "it has no $($ShellLayout.RnwLibrary)" }
    if (Test-Path -LiteralPath (Join-Path $root $ShellLayout.UiFolder)) { $problems += "it still holds the WebUI shell's $($ShellLayout.UiFolder) folder" }
    if (Test-Path -LiteralPath (Join-Path $root $ShellLayout.Migrator)) { $problems += "it still holds the WebUI shell's $($ShellLayout.Migrator)" }
  } else {
    $problems += "'$shell' is not a shell: rnw or webui"
  }
  if (-not $AllowTestBuild) {
    foreach ($marker in (Find-TestMarkers $root)) { $problems += "it carries a test-build marker at $marker, so it would read test keys" }
  }
  return ,$problems
}
