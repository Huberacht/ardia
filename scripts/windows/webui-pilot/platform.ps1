. C:\pilot\lib.ps1
$ErrorActionPreference = 'Continue'
$results = New-Object System.Collections.Specialized.OrderedDictionary ([StringComparer]::Ordinal)
function Check([string]$name, [bool]$ok, [string]$detail) {
  $results[$name] = @{ ok = $ok; detail = $detail }
  Log ("{0} {1}: {2}" -f ($(if ($ok) { 'PASS' } else { 'FAIL' }), $name, $detail))
}
function Js([string]$value) { $value | ConvertTo-Json -Compress }
function Invoke-Host([string]$method, [string]$argsJson) {
  Cdp-Eval "__ardiaHost.invoke($(Js $method), $argsJson).then(r => JSON.stringify({ ok: true, r }), e => JSON.stringify({ ok: false, e: String(e && e.message || e) }))" | ConvertFrom-Json
}
function Engine-Call([string]$name) {
  Cdp-Eval "__ardiaHost.call ? __ardiaHost.call($(Js $name), 'default', '{}').then(r => JSON.stringify({ ok: true, r }), e => JSON.stringify({ ok: false, e: String(e && e.message || e) })) : JSON.stringify({ ok: false, e: 'no call' })" | ConvertFrom-Json
}
$RunKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
function Run-Value([string]$name) { (Get-ItemProperty -LiteralPath $RunKey -Name $name -ErrorAction SilentlyContinue).$name }
$Spawned = @('msedge', 'mshta', 'calc', 'CalculatorApp', 'msdt', 'explorer', 'SystemSettings', 'wscript', 'cscript')
function Spawned { @(Get-Process -Name $Spawned -ErrorAction SilentlyContinue | ForEach-Object Id) }
function Named([int[]]$ids) { @($ids | ForEach-Object { $p = Get-Process -Id $_ -ErrorAction SilentlyContinue; if ($p) { "$($p.Name)#$_ parent $((Get-CimInstance Win32_Process -Filter "ProcessId=$_" -ErrorAction SilentlyContinue).ParentProcessId)" } }) -join ', ' }

Stop-Engine
Start-Shell -Fresh | Out-Null
Wait-ShellReady 60 | Out-Null

$decorations = (Invoke-Host 'ArdiaShell.testWindowDecorations' '{}').r
Check 'mica-corners-dark-title' ($decorations.backdropSet -and $decorations.cornersSet -and $decorations.darkTitleSet -and $decorations.backdrop -eq 2 -and $decorations.darkTitle -eq $decorations.systemDark) ($decorations | ConvertTo-Json -Compress)

$secret = (Invoke-Host 'ArdiaShell.testSecretRoundTrip' '{}').r
$underData = $secret.directory -like "$Data*"
Check 'dpapi-secret-roundtrip' ($secret.opened -and $secret.kind -eq 'dpapi' -and $secret.probe -and $secret.saved -and $secret.same -and $secret.hidden -and $secret.boundToPurpose -and $secret.apartFromOtherInstances -and $secret.rejectsPathAccount -and $secret.deleted -and $underData) ($secret | ConvertTo-Json -Compress)
$rnwSync = Join-Path $env:LOCALAPPDATA 'Ardia\Sync'
$leftovers = @(Get-ChildItem -LiteralPath (Join-Path $Data 'Sync') -Filter 'sync-key-self-check-*' -ErrorAction SilentlyContinue).Count + @(Get-ChildItem -LiteralPath $rnwSync -Filter 'sync-key-self-check-*' -ErrorAction SilentlyContinue).Count
Check 'dpapi-leaves-nothing-and-skips-rnw' ($leftovers -eq 0) "self-check keys left: $leftovers"

$hostile = @(
  'javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'file:///C:/Windows/System32/calc.exe', 'file://host/share/x.exe',
  'ms-msdt:/id PCWDiagnostic', 'search-ms:query=calc', 'ms-settings:privacy', 'shell:startup', 'vbscript:msgbox(1)',
  'data:text/html,<script>1</script>', 'view-source:https://example.com', 'chrome://settings', 'mk:@MSITStore:x',
  'ms-officecmd:x', 'ms-appinstaller:?source=https://example.com/x.appinstaller', "https://example.com/`r`nx",
  'https://example.com/"x', 'https:', 'not a url', ('https://example.com/' + ('a' * 33000)), 'C:\Windows\System32\calc.exe',
  '\\host\share\x.exe'
)
$before = Spawned
$refused = 0
foreach ($url in $hostile) {
  $answer = Invoke-Host 'ArdiaApp.openExternalURL' "{ `"args`": [$(Js $url)] }"
  if ($answer.ok -and $answer.r -eq $false) { $refused++ } else { Log "open-external answered $($answer | ConvertTo-Json -Compress) for $($url.Substring(0, [Math]::Min(60, $url.Length)))" }
}
$shapes = @('{ "args": [] }', '{ "args": [5] }', '{ "args": ["https://example.com", "x"] }', '{ "args": [{ "href": "https://example.com" }] }')
$shapeRefused = @($shapes | Where-Object { -not (Invoke-Host 'ArdiaApp.openExternalURL' $_).ok }).Count
Hold 2000
$fresh = @(Spawned | Where-Object { $before -notcontains $_ })
Check 'open-external-refuses-hostile' (($refused -eq $hostile.Count) -and ($shapeRefused -eq $shapes.Count) -and ($fresh.Count -eq 0)) "$refused of $($hostile.Count) URLs refused, $shapeRefused of $($shapes.Count) bad shapes refused, new processes: $(Named $fresh)"
$valid = Invoke-Host 'ArdiaApp.openExternalURL' '{ "args": ["https://example.com/ardia-open-external"] }'
$opened = Wait-Until { @(Spawned | Where-Object { $before -notcontains $_ }).Count -gt 0 } 15 'a browser for the valid link' -NoThrow
Check 'open-external-valid-reaches-shell' ($valid.ok -and $valid.r -eq $true -and $opened) "answer $($valid | ConvertTo-Json -Compress)"
Get-Process -Name msedge -ErrorAction SilentlyContinue | Where-Object { $before -notcontains $_.Id } | Stop-Process -Force -ErrorAction SilentlyContinue

$rnwBefore = Run-Value 'Ardia'
$status0 = Invoke-Host 'ArdiaSystem.launchAtLoginStatus' '{ "args": [] }'
$on = Invoke-Host 'ArdiaSystem.setLaunchAtLogin' '{ "args": [true] }'
$stored = Run-Value 'Ardia WebUI'
$status1 = Invoke-Host 'ArdiaSystem.launchAtLoginStatus' '{ "args": [] }'
$off = Invoke-Host 'ArdiaSystem.setLaunchAtLogin' '{ "args": [false] }'
$status2 = Invoke-Host 'ArdiaSystem.launchAtLoginStatus' '{ "args": [] }'
$badToggle = Invoke-Host 'ArdiaSystem.setLaunchAtLogin' '{ "args": ["yes"] }'
$expected = '"' + "$App\chrome.exe" + '" --ardia-shell=webui'
Check 'login-item-toggles-run-key' ($on.ok -and $off.ok -and $stored -eq $expected -and $status1.r -eq 'enabled' -and $status2.r -eq 'notRegistered' -and -not $badToggle.ok -and (Run-Value 'Ardia WebUI') -eq $null -and (Run-Value 'Ardia') -eq $rnwBefore) "before $($status0.r), stored '$stored', after on $($status1.r), after off $($status2.r), RNW value unchanged: $((Run-Value 'Ardia') -eq $rnwBefore)"

$isDefault = Invoke-Host 'ArdiaSystem.isDefaultBrowser' '{ "args": [] }'
$badDefault = Invoke-Host 'ArdiaSystem.isDefaultBrowser' '{ "args": [1] }'
Check 'default-browser-check' ($isDefault.ok -and ($isDefault.r -is [bool]) -and -not $badDefault.ok) "answer $($isDefault | ConvertTo-Json -Compress)"

$power = Engine-Call 'engine.systemState'
$state = if ($power.ok -and $power.r -is [string]) { $power.r | ConvertFrom-Json } elseif ($power.ok) { $power.r } else { $null }
Check 'power-state' ($state -and $state.power -eq 'windows' -and $state.physicalMemory -gt 0 -and ($state.onBattery -is [bool])) "answer $($power | ConvertTo-Json -Compress -Depth 4)"

$identity = Cdp-Eval '__ardiaHost.invoke("ArdiaShell.windowIdentity", {})'
Check 'bridge-answers-after-platform-calls' ($identity -eq 'main') "windowIdentity '$identity'"

Stop-Engine
$results | ConvertTo-Json -Depth 4 | Set-Content "$Proof\platform-results.json"
Remove-PilotRun $RunRoot
"DONE platform"
