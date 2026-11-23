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

$edgeWasRunning = [bool](Get-Process -Name msedge -ErrorAction SilentlyContinue)
Stop-Engine
Start-Shell -Fresh | Out-Null
Wait-ShellReady 60 | Out-Null

$decorations = (Invoke-Host 'ArdiaShell.testWindowDecorations' '{}').r
Check 'mica-corners-dark-title' ($decorations.backdropSet -and $decorations.cornersSet -and $decorations.darkTitleSet -and $decorations.backdrop -eq 2 -and $decorations.darkTitle -eq $decorations.systemDark) ($decorations | ConvertTo-Json -Compress)

$rnwSync = Join-Path $env:LOCALAPPDATA 'Ardia\Sync'
function Rnw-Keys { @(Get-ChildItem -LiteralPath $rnwSync -Filter 'sync-key-*' -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Name) $($_.Length) $($_.LastWriteTimeUtc.Ticks)" }) -join '|' }
$rnwKeysBefore = Rnw-Keys
$secret = (Invoke-Host 'ArdiaShell.testSecretRoundTrip' '{}').r
$underData = $secret.directory -like "$Data*"
Check 'dpapi-secret-roundtrip' ($secret.opened -and $secret.kind -eq 'dpapi' -and $secret.probe -and $secret.saved -and $secret.same -and $secret.hidden -and $secret.boundToPurpose -and $secret.apartFromOtherInstances -and $secret.rejectsPathAccount -and $secret.deleted -and $underData) ($secret | ConvertTo-Json -Compress)
Check 'dpapi-case-distinct-accounts' ($secret.caseIndependent -and $secret.caseFiles.lower -and $secret.caseFiles.upper -and $secret.caseFiles.lower.ToLowerInvariant() -ne $secret.caseFiles.upper.ToLowerInvariant()) ($secret.caseFiles | ConvertTo-Json -Compress)
$leftovers = @(Get-ChildItem -LiteralPath (Join-Path $Data 'Sync') -Filter 'sync-key-*' -ErrorAction SilentlyContinue).Count
Check 'dpapi-leaves-nothing-and-skips-rnw' (($leftovers -eq 0) -and ((Rnw-Keys) -eq $rnwKeysBefore)) "test keys left: $leftovers; RNW Sync keys unchanged: $((Rnw-Keys) -eq $rnwKeysBefore)"

$corpus = Get-Content -LiteralPath 'C:\pilot\hostile-corpus.json' -Raw -Encoding UTF8 | ConvertFrom-Json
function Sink-Calls { (Invoke-Host 'ArdiaShell.testOpenExternalSink' '{}').r.calls }
function Open-With([string]$argsExpression) {
  Cdp-Eval "(() => { try { return __ardiaHost.invoke('ArdiaApp.openExternalURL', { args: $argsExpression }).then(r => JSON.stringify({ ok: true, r }), e => JSON.stringify({ ok: false, e: String(e && e.message || e) })); } catch (e) { return JSON.stringify({ ok: false, e: 'threw ' + e.message }); } })()" | ConvertFrom-Json
}
$before = Spawned
$sinkBefore = Sink-Calls
$opened = @()
foreach ($case in $corpus.cases) {
  $answer = Open-With "[$($case.expression)]"
  if ($answer -and $answer.ok -and $answer.r -ne $false) { $opened += $case.id; Log "open-external answered $($answer | ConvertTo-Json -Compress) for $($case.id)" }
}
foreach ($shape in $corpus.shapes) {
  $answer = Open-With $shape.expression
  if ($answer -and $answer.ok -and $answer.r -eq $true) { $opened += $shape.id; Log "open-external answered $($answer | ConvertTo-Json -Compress) for $($shape.id)" }
}
Hold 2000
$sinkAfter = Sink-Calls
$fresh = @(Spawned | Where-Object { $before -notcontains $_ })
Check 'open-external-refuses-shared-corpus' (($opened.Count -eq 0) -and ($sinkAfter -eq $sinkBefore) -and ($fresh.Count -eq 0)) "$($corpus.cases.Count) corpus values and $($corpus.shapes.Count) bad shapes; opened: $($opened -join ', '); ShellExecuteExW calls $sinkBefore -> $sinkAfter; new processes: $(Named $fresh)"
$valid = Open-With "[$(Js $corpus.control)]"
$sinkControl = Sink-Calls
$launched = Wait-Until { @(Spawned | Where-Object { $before -notcontains $_ }).Count -gt 0 } 15 'a browser for the valid link' -NoThrow
Check 'open-external-control-reaches-sink' ($valid.ok -and $valid.r -eq $true -and $sinkControl -eq $sinkAfter + 1 -and $launched) "answer $($valid | ConvertTo-Json -Compress); ShellExecuteExW calls $sinkAfter -> $sinkControl"
if (-not $edgeWasRunning) { Get-Process -Name msedge -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue }

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
$failed = @($results.Keys | Where-Object { -not $results[$_].ok })
if ($failed.Count) {
  "FAILED platform: $($failed -join ', ')"
  exit 1
}
"DONE platform"
exit 0
