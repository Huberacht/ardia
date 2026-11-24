import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
const read = (path) => readFileSync(join(REPO, path), "utf8").replace(/\r\n/g, "\n");
const WORKFLOW = read(".github/workflows/windows.yml");
const SCRIPT = read("scripts/windows/installer/Ardia.iss");

function jobBlocks(text) {
  const blocks = {};
  for (const block of text.split(/\n  (?=[a-z0-9-]+:\n)/).slice(1)) blocks[block.match(/^[a-z0-9-]+/)[0]] = block;
  return blocks;
}

function triggerPaths(text, event) {
  const lines = text.split("\n");
  const eventAt = lines.indexOf(`  ${event}:`);
  const pathsAt = lines.findIndex((line, at) => at > eventAt && line === "    paths:");
  const paths = [];
  for (let at = pathsAt + 1; at < lines.length && lines[at].startsWith("      - "); at++) paths.push(JSON.parse(lines[at].slice(8)));
  return paths;
}

const steps = (block) => block.split(/\n      - /).slice(1);
const stepNamed = (block, name) => steps(block).find((step) => step.includes(`name: ${name}\n`));

test("the WebUI job runs beside the React Native jobs, gated like them, on a GitHub Windows runner", () => {
  const blocks = jobBlocks(WORKFLOW);
  const job = blocks.webui;
  assert.ok(job, "windows.yml has a webui job");
  assert.match(job, /\n    needs: \[gate, identity\]\n/);
  assert.ok(job.includes("    if: ${{ !cancelled() && needs.identity.result == 'success' && (needs.gate.result == 'skipped' || (needs.gate.result == 'success' && needs.gate.outputs.run == 'true')) }}\n"), "an unvouched pull request waits for vouch like the other builds");
  assert.ok(job.includes("    runs-on: windows-latest\n"));
  assert.ok(job.includes("    permissions:\n      contents: write\n"), "the job's token can read the engine's release, as the x64 job's does");
  assert.equal(stepNamed(job, "Fetch the engine"), stepNamed(blocks.x64, "Fetch the engine"), "the engine is fetched exactly as the x64 job fetches it");
  assert.ok(!/concurrency:/.test(job), "the job shares the workflow's concurrency group instead of naming its own");
  for (const name of ["app", "arm64-app", "x64", "x64-input", "x64-tour", "x64-tour-first-run", "x64-gate", "arm64", "arm64-gate"]) {
    assert.ok(blocks[name], `the React Native job ${name} is still there`);
    assert.ok(!blocks[name].includes("assemble-webui.ps1"), `${name} still assembles the React Native shell`);
  }
});

test("the React Native jobs package exactly as before the WebUI packaging", () => {
  const launch = jobBlocks(WORKFLOW).x64;
  assert.ok(launch.includes('run: scripts/windows/assemble.ps1 -App $env:APP -Engine "${{ runner.temp }}/engine" -Out "${{ runner.temp }}/Ardia" -Version $env:VERSION -Build $env:BUILD\n'));
  assert.ok(launch.includes('run: scripts/windows/make-installer.ps1 -Source "${{ runner.temp }}/Ardia" -Out "${{ runner.temp }}/installer" -Cpu $env:SLUG -Version $env:VERSION\n'));
  assert.ok(launch.includes('run: scripts/windows/installer-check.ps1 -Setup "${{ runner.temp }}/installer/Ardia-Setup-$env:SLUG.exe"\n'));
});

test("the WebUI job builds the UI and the migrator, assembles a shippable build and checks it", () => {
  const job = jobBlocks(WORKFLOW).webui;
  const order = [
    "Check the shell layouts, the WebUI assembly and the installer's refusals",
    "Check the pilot's waits, log and types on PowerShell 7",
    "Check the pilot's waits, log and types on Windows PowerShell",
    "Build the desktop UI for Windows",
    "Build the migrator",
    "Fetch the engine",
    "Assemble the shippable WebUI build",
    "Every DLL the WebUI build needs is in it or in a clean Windows 11",
    "Make the WebUI installer",
    "Install and uninstall the WebUI build",
    "Tour the WebUI build",
  ];
  const at = order.map((name) => job.indexOf(`name: ${name}\n`));
  assert.ok(at.every((index) => index > 0), "every WebUI step is there");
  assert.deepEqual([...at].sort((a, b) => a - b), at, "the steps run in order");
  assert.ok(stepNamed(job, "Check the shell layouts, the WebUI assembly and the installer's refusals").includes("run: scripts/windows/shell-layout.test.ps1"));
  assert.ok(stepNamed(job, "Build the desktop UI for Windows").includes("run: pnpm -C apps/desktop build:win"));
  assert.ok(stepNamed(job, "Check the pilot's waits, log and types on PowerShell 7").includes("shell: pwsh\n"));
  assert.ok(stepNamed(job, "Check the pilot's waits, log and types on Windows PowerShell").includes("shell: powershell\n"));
  assert.match(stepNamed(job, "Build the migrator"), /cargo build --locked --release -p ardia-shell-migration --bin ardia-webui-migrate/);
  assert.ok(job.includes("      MIGRATOR: packages/core-rs/target/release/ardia-webui-migrate.exe\n"));
  const assemble = stepNamed(job, "Assemble the shippable WebUI build");
  assert.match(assemble, /assemble-webui\.ps1 -Engine .* -Ui apps\/desktop\/dist\/win -Out .* -MigrateBin \$env:MIGRATOR -Shippable -Version \$env:VERSION -Build \$env:BUILD/);
  assert.ok(!assemble.includes("-TestBuild"), "the shippable build carries no test marker");
  assert.ok(stepNamed(job, "Fetch the engine").includes("github.event.pull_request.head.repo.full_name == github.repository"), "a fork's pull request never gets the engine token");
});

test("the WebUI installer and tour run on full runs only, and the tour never fails the run", () => {
  const job = jobBlocks(WORKFLOW).webui;
  assert.ok(stepNamed(job, "Make the WebUI installer").includes("env.FULL == 'true'"));
  assert.ok(stepNamed(job, "Make the WebUI installer").includes("-Shell webui"));
  assert.ok(stepNamed(job, "Install and uninstall the WebUI build").includes("-Shell webui"));
  const tour = stepNamed(job, "Tour the WebUI build");
  assert.ok(tour.includes("env.FULL == 'true'"));
  assert.ok(tour.includes("continue-on-error: true\n"));
  assert.ok(tour.includes("scripts/windows/webui-pilot/tour-webui.ps1"));
  assert.ok(tour.includes('"Ardia.test-build"'), "the tour runs a copy marked as a test build, never the shippable folder");
});

test("pushes to main and pull requests start Windows on the same paths, including the WebUI sources", () => {
  const pull = triggerPaths(WORKFLOW, "pull_request");
  assert.deepEqual(triggerPaths(WORKFLOW, "push"), pull);
  for (const path of ["apps/desktop/**", "packages/core-rs/crates/ardia-shell-migration/**", "scripts/windows/**"]) assert.ok(pull.includes(path), `${path} starts Windows`);
});

test("the installer stays the React Native shell's unless make-installer asks for the WebUI shell", () => {
  assert.match(SCRIPT, /^#ifndef Shell\n {2}#define Shell "rnw"\n#endif\n/);
  assert.match(SCRIPT, /#if Shell == "webui"\n {2}#define LaunchSwitch "--ardia-shell=webui"\n {2}#define OpenSuffix " --ardia-shell=webui"\n {2}#define ShellMarker "ardia-ui\\index\.html"\n#else\n {2}#define LaunchSwitch ""\n {2}#define OpenSuffix ""\n {2}#define ShellMarker "ArdiaApp\.dll"\n#endif\n/);
  assert.ok(SCRIPT.includes('ValueData: """{app}\\Ardia.exe""{#OpenSuffix} --single-argument %1"'));
  assert.ok(SCRIPT.includes('Name: "{autoprograms}\\Ardia"; Filename: "{app}\\Ardia.exe"; Parameters: "{#LaunchSwitch}"; IconFilename: "{app}\\Ardia.ico"; AppUserModelID: "Ardia.Browser"'));
  assert.equal((SCRIPT.match(/Parameters: "\{#LaunchSwitch\}"/g) || []).length, 4, "both shortcuts and both launches after setup carry the switch");
  const installer = read("scripts/windows/make-installer.ps1");
  assert.ok(installer.includes('"/DShell=$shellKind"'), "make-installer passes the shell it found");
  assert.ok(installer.includes('[ValidateSet("auto", "rnw", "webui")][string]$Shell = "auto"'));
});

test("switching shells removes only the other shell's own files, and only after this shell's files are installed", () => {
  assert.ok(!/\[InstallDelete\]|ssInstall\b/.test(SCRIPT), "nothing is deleted before the new files are copied");
  assert.ok(!SCRIPT.includes("RemoveReactNativeShell"), "no step empties the install folder");
  assert.match(SCRIPT, /#if Shell == "webui"\n(?: {2}#define \w+ .*\n)*? {2}#define ShellMarker "ardia-ui\\index\.html"\n/);
  assert.match(SCRIPT, /#else\n(?: {2}#define \w+ .*\n)*? {2}#define ShellMarker "ArdiaApp\.dll"\n/);
  assert.ok(SCRIPT.includes('#ifdef RetiredList\nSource: "{#RetiredList}"; DestName: "retired-shell.txt"; Flags: dontcopy\n#endif'));
  const cleanup = SCRIPT.slice(SCRIPT.indexOf("procedure RemoveRetiredShell;"));
  assert.ok(cleanup.includes("if not FileExists(Folder + '\\{#ShellMarker}') then"), "the cleanup waits for this shell's marker");
  assert.ok(cleanup.includes("LoadStringsFromFile(ExpandConstant('{tmp}\\retired-shell.txt'), Entries)"), "it removes only the listed entries");
  assert.ok(cleanup.includes("(Pos('..', Entry) > 0) or (Pos(':', Entry) > 0)"), "an entry can't leave the install folder");
  assert.ok(SCRIPT.includes("if CurStep = ssPostInstall then\n    RemoveRetiredShell;"));
  const layout = read("scripts/windows/shell-layout.ps1");
  assert.ok(layout.includes('webui = @("ardia-ui\\", "ardia-webui-migrate.exe")'));
  assert.ok(read("scripts/windows/make-installer.ps1").includes('Write-RetiredShellList $shellKind $retired'));
});
