. C:\pilot\lib.ps1
$ErrorActionPreference = 'Continue'
$results = New-Object System.Collections.Specialized.OrderedDictionary ([StringComparer]::Ordinal)
function Check([string]$name, [bool]$ok, [string]$detail) {
  $results[$name] = @{ ok = $ok; detail = $detail }
  Log ("{0} {1}: {2}" -f ($(if ($ok) { 'PASS' } else { 'FAIL' }), $name, $detail))
}
function PagesCreated { (Shell-Lines-Matching 'page \d+ created').Count }
function PageTargets { @(Cdp-List | Where-Object { $_.type -eq 'page' -and $_.url -notlike 'chrome://ardia/*' } | ForEach-Object { $_.url }) }
function Js([string]$value) { $value | ConvertTo-Json -Compress }
function Invoke-Host([string]$method, [string]$argsJson) {
  Cdp-Eval "__ardiaHost.invoke($(Js $method), $argsJson).then(r => JSON.stringify({ ok: true, r }), e => JSON.stringify({ ok: false, e: String(e && e.message || e) }))"
}
function Profiles { @(Get-ChildItem -LiteralPath "$Data\Chromium" -Directory -Filter 'Ardia *' -ErrorAction SilentlyContinue | ForEach-Object Name) }

Stop-Engine
Start-Shell -Fresh | Out-Null
Wait-ShellReady 60 | Out-Null

$made = Invoke-Host 'tab.create' '{ "key": "bridge-ok", "claim": "bridge-claim", "profile": "default", "url": "file:///C:/pilot/form.html?bridge" }' | ConvertFrom-Json
$control = $made.r.browserId
Wait-Until { ((PageTargets) -contains 'file:///C:/pilot/form.html?bridge') -and (PagesCreated) -ge 1 } 15 'the control page' -NoThrow | Out-Null
$targets = PageTargets
Check 'valid-create-reaches-the-sink' ($made.ok -and $control -and ($targets -contains 'file:///C:/pilot/form.html?bridge')) "tab.create answered $($made | ConvertTo-Json -Compress -Depth 6); pages: $($targets -join ' | ')"
$baseCreated = PagesCreated
$baseProfiles = (Profiles) -join '|'

$payload = '{ method: "tab.create", args: { key: "K", claim: "C", profile: "default", url: "file:///C:/pilot/form.html?malformed-K" } }'
$malformed = [ordered]@{
  'no-arguments'        = 'chrome.send("ardiaRequest", [])'
  'one-argument'        = 'chrome.send("ardiaRequest", ["m-one"])'
  'four-arguments'      = "chrome.send(`"ardiaRequest`", [`"m-four`", `"host.invoke`", $($payload -replace 'K', 'four'), `"extra`"])"
  'numeric-id'          = "chrome.send(`"ardiaRequest`", [7, `"host.invoke`", $($payload -replace 'K', 'numeric')])"
  'empty-id'            = "chrome.send(`"ardiaRequest`", [`"`", `"host.invoke`", $($payload -replace 'K', 'empty')])"
  'oversized-id'        = "chrome.send(`"ardiaRequest`", [`"x`".repeat(300), `"host.invoke`", $($payload -replace 'K', 'oversized')])"
  'operation-not-text'  = "chrome.send(`"ardiaRequest`", [`"m-op`", 5, $($payload -replace 'K', 'op')])"
  'payload-not-object'  = 'chrome.send("ardiaRequest", ["m-payload", "host.invoke", "tab.create"])'
  'payload-is-array'    = "chrome.send(`"ardiaRequest`", [`"m-array`", `"host.invoke`", [$($payload -replace 'K', 'array')]])"
  'host-args-not-object' = 'chrome.send("ardiaRequest", ["m-args", "host.invoke", { method: "tab.create", args: "file:///C:/pilot/form.html?malformed-args" }])'
  'unknown-operation'   = "chrome.send(`"ardiaRequest`", [`"m-unknown`", `"engine.raw`", $($payload -replace 'K', 'unknown')])"
  'unknown-method'      = 'chrome.send("ardiaRequest", ["m-method", "host.invoke", { method: "tab.createEverything", args: { url: "file:///C:/pilot/form.html?malformed-method" } }])'
  'key-missing'         = 'chrome.send("ardiaRequest", ["m-key", "host.invoke", { method: "tab.create", args: { claim: "C", profile: "default", url: "file:///C:/pilot/form.html?malformed-key" } }])'
  'key-oversized'       = 'chrome.send("ardiaRequest", ["m-bigkey", "host.invoke", { method: "tab.create", args: { key: "k".repeat(300), claim: "C", profile: "default", url: "file:///C:/pilot/form.html?malformed-bigkey" } }])'
  'url-not-text'        = 'chrome.send("ardiaRequest", ["m-urltype", "host.invoke", { method: "tab.create", args: { key: "urltype", claim: "C", profile: "default", url: { href: "file:///C:/pilot/form.html?malformed-urltype" } } }])'
}
foreach ($case in $malformed.GetEnumerator()) {
  $sent = Cdp-Eval "(() => { try { $($case.Value); return 'sent'; } catch (e) { return 'threw ' + e.message; } })()"
  Log "malformed $($case.Key): $sent"
}
$identity = Cdp-Eval '__ardiaHost.invoke("ArdiaShell.windowIdentity", {})'
$quiet = Never { (@(PageTargets | Where-Object { $_ -like '*malformed*' }).Count -gt 0) -or ((PagesCreated) -ne $baseCreated) } 2
$targets = PageTargets
$created = PagesCreated
$leaked = @($targets | Where-Object { $_ -like '*malformed*' })
Check 'malformed-requests-make-no-page' ($quiet -and ($created -eq $baseCreated) -and ($leaked.Count -eq 0) -and ($targets.Count -eq 1)) "$($malformed.Count) malformed requests, then a later request answered; pages created $baseCreated -> $created; pages: $($targets -join ' | ')"
Check 'bridge-answers-after-malformed-requests' ($identity -eq 'main') "ArdiaShell.windowIdentity answered '$identity'"
$refusals = [ordered]@{
  'key-missing'   = '{ "claim": "C", "profile": "default", "url": "file:///C:/pilot/form.html?refused-key" }'
  'key-oversized' = "{ `"key`": $(Js ('k' * 300)), `"claim`": `"C`", `"profile`": `"default`", `"url`": `"file:///C:/pilot/form.html?refused-bigkey`" }"
  'claim-missing' = '{ "key": "refused-claim", "profile": "default", "url": "file:///C:/pilot/form.html?refused-claim" }'
  'url-not-text'  = '{ "key": "refused-urltype", "claim": "C", "profile": "default", "url": { "href": "file:///C:/pilot/form.html?refused-urltype" } }'
  'url-is-list'   = '{ "key": "refused-urllist", "claim": "C", "profile": "default", "url": ["file:///C:/pilot/form.html?refused-urllist"] }'
  'private-profile' = '{ "key": "refused-private", "claim": "C", "profile": "@default", "url": "file:///C:/pilot/form.html?refused-private" }'
}
$refusedCount = 0
foreach ($case in $refusals.GetEnumerator()) {
  $answer = Invoke-Host 'tab.create' $case.Value | ConvertFrom-Json
  Log "refusal $($case.Key) -> $($answer | ConvertTo-Json -Compress -Depth 6)"
  if (-not $answer.ok) { $refusedCount++ }
}
$quiet = Never { @(PageTargets | Where-Object { $_ -like '*refused*' }).Count -gt 0 } 2
$targets = PageTargets
Check 'bad-create-arguments-refused' ($quiet -and ($refusedCount -eq $refusals.Count) -and ((PagesCreated) -eq $baseCreated) -and (@($targets | Where-Object { $_ -like '*refused*' }).Count -eq 0)) "$refusedCount of $($refusals.Count) refused with an answer; pages: $($targets -join ' | ')"

$reserved = @(
  'javascript:alert(1)', 'JavaScript:alert(1)', 'chrome://ardia/', 'CHROME://ARDIA/index.html', 'chrome://ardia./',
  'ardia://ardia/', 'ArDiA://ardia/', 'view-source:chrome://ardia/', 'view-source:javascript:alert(1)',
  'view-source:view-source:chrome://ardia/', 'http://[not a host', 'not a url at all'
)
$n = 0
foreach ($url in $reserved) {
  $n++
  $answer = Invoke-Host 'tab.create' "{ `"key`": `"reserved-$n`", `"claim`": `"reserved-claim`", `"profile`": `"reservedprofile`", `"url`": $(Js $url) }" | ConvertFrom-Json
  Log "reserved tab.create $url -> $($answer | ConvertTo-Json -Compress -Depth 6)"
  $results["reserved-create $url"] = @{ ok = (-not $answer.ok); detail = "$($answer.e)" }
}
$quiet = Never { (Test-Path -LiteralPath "$Data\Chromium\Ardia reservedprofile") -or ((PageTargets).Count -ne 1) } 2
$targets = PageTargets
$refusedAll = @($reserved | Where-Object { $results["reserved-create $_"].ok }).Count
$reservedProfile = Test-Path -LiteralPath "$Data\Chromium\Ardia reservedprofile"
Check 'reserved-tab-urls-refused' ($quiet -and ($refusedAll -eq $reserved.Count) -and ((PagesCreated) -eq $baseCreated) -and ($targets.Count -eq 1)) "$refusedAll of $($reserved.Count) refused; pages: $($targets -join ' | ')"
Check 'reserved-url-loads-no-profile' ((-not $reservedProfile) -and (((Profiles) -join '|') -eq $baseProfiles)) "Ardia reservedprofile on disk: $reservedProfile; profile folders $baseProfiles -> $((Profiles) -join '|')"

$navigations = @('javascript:document.title="owned"', 'chrome://ardia/', 'ArDiA://ardia/', 'view-source:chrome://ardia/', '')
foreach ($url in $navigations) {
  $answer = Invoke-Host 'tab.command' "{ `"id`": $control, `"claim`": `"bridge-claim`", `"command`": `"loadUrl`", `"args`": [$(Js $url)] }" | ConvertFrom-Json
  Log "reserved loadUrl '$url' -> $($answer | ConvertTo-Json -Compress -Depth 6)"
  $results["reserved-load '$url'"] = @{ ok = (-not $answer.ok); detail = "$($answer.e)" }
}
$wrongClaim = Invoke-Host 'tab.command' "{ `"id`": $control, `"claim`": `"someone-else`", `"command`": `"loadUrl`", `"args`": [`"file:///C:/pilot/form.html?stolen`"] }" | ConvertFrom-Json
$noArgs = Invoke-Host 'tab.command' "{ `"id`": $control, `"claim`": `"bridge-claim`", `"command`": `"loadUrl`", `"args`": `"file:///C:/pilot/form.html?scalar`" }" | ConvertFrom-Json
$quiet = Never { (PageTargets) -notcontains 'file:///C:/pilot/form.html?bridge' } 2
$targets = PageTargets
$title = Cdp-Eval 'document.title' 'file:///C:/pilot/form.html'
$refusedLoads = @($navigations | Where-Object { $results["reserved-load '$_'"].ok }).Count
Check 'reserved-navigation-refused' ($quiet -and ($refusedLoads -eq $navigations.Count) -and ($targets -contains 'file:///C:/pilot/form.html?bridge') -and ($title -ne 'owned')) "$refusedLoads of $($navigations.Count) refused; page still at $($targets -join ' | '), title '$title'"
Check 'wrong-claim-cannot-navigate' ((-not $wrongClaim.ok) -and ($targets -notcontains 'file:///C:/pilot/form.html?stolen')) "answer $($wrongClaim | ConvertTo-Json -Compress)"
Check 'loadurl-without-a-list-does-nothing' ($targets -notcontains 'file:///C:/pilot/form.html?scalar') "answer $($noArgs | ConvertTo-Json -Compress); pages: $($targets -join ' | ')"

$load = Invoke-Host 'tab.command' "{ `"id`": $control, `"claim`": `"bridge-claim`", `"command`": `"loadUrl`", `"args`": [`"file:///C:/pilot/form.html?loaded`"] }" | ConvertFrom-Json
Wait-Until { (PageTargets) -contains 'file:///C:/pilot/form.html?loaded' } 15 'the page to load the new URL' -NoThrow | Out-Null
$targets = PageTargets
Check 'valid-navigation-reaches-the-sink' ($load.ok -and ($targets -contains 'file:///C:/pilot/form.html?loaded')) "answer $($load | ConvertTo-Json -Compress); pages: $($targets -join ' | ')"
$second = Invoke-Host 'tab.create' '{ "key": "bridge-second", "claim": "bridge-claim-2", "profile": "default", "url": "file:///C:/pilot/form.html?second" }' | ConvertFrom-Json
Wait-Until { ((PageTargets) -contains 'file:///C:/pilot/form.html?second') -and (PagesCreated) -eq $baseCreated + 1 } 15 'the second page' -NoThrow | Out-Null
$targets = PageTargets
Check 'valid-create-after-hostile-input' ($second.ok -and ($targets -contains 'file:///C:/pilot/form.html?second') -and ((PagesCreated) -eq $baseCreated + 1)) "pages: $($targets -join ' | ')"

function Invoke-HostExpr([string]$method, [string]$argsExpression) {
  Cdp-Eval "(() => { try { return __ardiaHost.invoke($(Js $method), { args: $argsExpression }).then(r => JSON.stringify({ ok: true, r }), e => JSON.stringify({ ok: false, e: String(e && e.message || e) })); } catch (e) { return JSON.stringify({ ok: false, e: 'threw ' + e.message }); } })()" | ConvertFrom-Json
}
function Folder-Snapshot([string]$root) {
  @(Get-ChildItem -LiteralPath $root -Force -ErrorAction SilentlyContinue | Sort-Object Name | ForEach-Object {
    if ($_.PSIsContainer) { "D:$($_.Name)" } else { "F:$($_.Name):$($_.Length):$($_.LastWriteTimeUtc.Ticks)" }
  }) -join '|'
}

$outsideCanary = Join-Path $RunRoot 'outside-canary.json'
Set-Content -LiteralPath $outsideCanary '{"canary":"untouched"}' -NoNewline
$canaryBefore = Get-Content -LiteralPath $outsideCanary -Raw
$runBefore = Folder-Snapshot $RunRoot
$dataBefore = Folder-Snapshot $Data

$corpus = Get-Content -LiteralPath 'C:\pilot\hostile-corpus.json' -Raw -Encoding UTF8 | ConvertFrom-Json
$docHostileNames = @(
  '', '.', '..', '../outside-canary.json', '..\\outside-canary.json', 'a/b.json', 'a\\b.json',
  '.hidden.json', 'trailing.', ' leading.json', 'trailing.json ', 'foo:bar.json', 'foo.json:$DATA',
  'CON', 'CON.json', 'PRN.txt', 'AUX', 'NUL.json', 'COM1', 'COM9.json', 'LPT1', 'LPT9.txt',
  'session.json', 'SESSION.JSON', 'live.json', 'LIVE.JSON', 'live.canonical.json', 'Live.Canonical.Json',
  'rnw-migration.lock', 'RNW-MIGRATION.LOCK', ('a' * 129)
)
$docUnrefused = @()
foreach ($case in $corpus.cases) {
  $readAns = Invoke-HostExpr 'ArdiaShell.readDocument' "[$($case.expression)]"
  if ($readAns.ok -ne $false) { $docUnrefused += "read:$($case.id)" }
  $writeAns = Invoke-HostExpr 'ArdiaShell.writeDocument' "[$($case.expression), `"x`"]"
  if ($writeAns.ok -ne $false) { $docUnrefused += "write:$($case.id)" }
  $removeAns = Invoke-HostExpr 'ArdiaShell.removeDocument' "[$($case.expression)]"
  if ($removeAns.ok -ne $false) { $docUnrefused += "remove:$($case.id)" }
}
foreach ($name in $docHostileNames) {
  $expr = Js $name
  $readAns = Invoke-HostExpr 'ArdiaShell.readDocument' "[$expr]"
  if ($readAns.ok -ne $false) { $docUnrefused += "read:$name" }
  $writeAns = Invoke-HostExpr 'ArdiaShell.writeDocument' "[$expr, `"x`"]"
  if ($writeAns.ok -ne $false) { $docUnrefused += "write:$name" }
  $removeAns = Invoke-HostExpr 'ArdiaShell.removeDocument' "[$expr]"
  if ($removeAns.ok -ne $false) { $docUnrefused += "remove:$name" }
}
foreach ($shape in @('[]', '["a.json", "b", "extra"]', '"a.json"', '{ "0": "a.json" }')) {
  $readAns = Invoke-HostExpr 'ArdiaShell.readDocument' $shape
  if ($readAns.ok -ne $false) { $docUnrefused += "read-shape:$shape" }
  $removeAns = Invoke-HostExpr 'ArdiaShell.removeDocument' $shape
  if ($removeAns.ok -ne $false) { $docUnrefused += "remove-shape:$shape" }
}
foreach ($shape in @('[]', '["a.json"]', '["a.json", 123]', '["a.json", "x", "extra"]')) {
  $writeAns = Invoke-HostExpr 'ArdiaShell.writeDocument' $shape
  if ($writeAns.ok -ne $false) { $docUnrefused += "write-shape:$shape" }
}
$oversized = Invoke-HostExpr 'ArdiaShell.writeDocument' '["oversized-doc.json", "x".repeat(8 * 1024 * 1024 + 1)]'
if ($oversized.ok -ne $false) { $docUnrefused += 'write:oversized' }

$canaryAfterHostile = Get-Content -LiteralPath $outsideCanary -Raw
$runAfterHostile = Folder-Snapshot $RunRoot
$dataAfterHostile = Folder-Snapshot $Data
Check 'documents-refuse-hostile-corpus' (($docUnrefused.Count -eq 0) -and ($canaryAfterHostile -eq $canaryBefore) -and ($runAfterHostile -eq $runBefore) -and ($dataAfterHostile -eq $dataBefore)) "unrefused: $($docUnrefused -join ', '); outside canary intact: $($canaryAfterHostile -eq $canaryBefore); data unchanged: $($dataAfterHostile -eq $dataBefore)"

$linkPath = Join-Path $Data 'escape-link.json'
cmd /c mklink "$linkPath" "$outsideCanary" | Out-Null
$linkItem = Get-Item -LiteralPath $linkPath -Force -ErrorAction SilentlyContinue
$linkRead = Invoke-HostExpr 'ArdiaShell.readDocument' '["escape-link.json"]'
$linkWrite = Invoke-HostExpr 'ArdiaShell.writeDocument' '["escape-link.json", "{\"pwned\":true}"]'
$linkRemove = Invoke-HostExpr 'ArdiaShell.removeDocument' '["escape-link.json"]'
$canaryAfterLink = Get-Content -LiteralPath $outsideCanary -Raw
$linkStillExists = Test-Path -LiteralPath $linkPath
if ($linkStillExists) { Remove-Item -LiteralPath $linkPath -Force }
Check 'documents-refuse-reparse-point' ([bool]($linkItem -and $linkItem.LinkType) -and ($linkRead.ok -eq $false) -and ($linkWrite.ok -eq $false) -and ($linkRemove.ok -eq $false) -and ($canaryAfterLink -eq $canaryBefore) -and $linkStillExists) "link read/write/remove ok=$($linkRead.ok)/$($linkWrite.ok)/$($linkRemove.ok); outside canary intact: $($canaryAfterLink -eq $canaryBefore)"

$docAbsent = Invoke-HostExpr 'ArdiaShell.readDocument' '["pilot-roundtrip.json"]'
$docWritten = Invoke-HostExpr 'ArdiaShell.writeDocument' '["pilot-roundtrip.json", "{\"ok\":true}"]'
$docRead = Invoke-HostExpr 'ArdiaShell.readDocument' '["pilot-roundtrip.json"]'
$docDisk = Get-Content -LiteralPath (Join-Path $Data 'pilot-roundtrip.json') -Raw -ErrorAction SilentlyContinue
$docRemoved = Invoke-HostExpr 'ArdiaShell.removeDocument' '["pilot-roundtrip.json"]'
$docGone = Invoke-HostExpr 'ArdiaShell.readDocument' '["pilot-roundtrip.json"]'
Check 'documents-valid-roundtrip' (($docAbsent.ok -eq $true) -and ($null -eq $docAbsent.r) -and ($docWritten.ok -eq $true) -and ($docRead.ok -eq $true) -and ($docRead.r -eq '{"ok":true}') -and ($docDisk -eq '{"ok":true}') -and ($docRemoved.ok -eq $true) -and ($docGone.ok -eq $true) -and ($null -eq $docGone.r) -and (-not (Test-Path -LiteralPath (Join-Path $Data 'pilot-roundtrip.json')))) "absent=$($docAbsent.r), read=$($docRead.r), gone=$($docGone.r)"

Stop-Engine
$results | ConvertTo-Json -Depth 4 | Set-Content "$Proof\bridge-results.json"
Remove-PilotRun $RunRoot
"DONE bridge"
