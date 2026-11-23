import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const tool = join(root, "scripts/release/notarize.sh");
const FIRST = "11111111-2222-4333-8444-555555555555";
const SECOND = "66666666-7777-4888-9999-aaaaaaaaaaaa";

const XCRUN = `#!/usr/bin/env bash
set -u
stub="$NOTARY_STUB"
echo "$*" >> "$stub/calls"
next() { local f="$stub/$1"; [ -s "$f" ] || return 1; head -1 "$f"; tail -n +2 "$f" > "$f.rest"; mv "$f.rest" "$f"; }
case "$1 $2" in
  "notarytool submit")
    id="$(next submit)" || { echo "Error: upload cut off"; exit 1; }
    echo "Conducting pre-submission checks for $(basename "$3")"
    echo "Submission ID received"
    echo "  id: $id"
    printf 'In Progress\\n' > "$stub/status-$id"
    ;;
  "notarytool info")
    [ -f "$stub/status-$3" ] || { echo "Error: Submission does not exist or does not belong to your team."; exit 69; }
    echo "Successfully received submission info"
    echo "  createdDate: 2026-11-22T00:00:00.000Z"
    echo "  id: $3"
    echo "  name: notarize.zip"
    echo "  status: $(cat "$stub/status-$3")"
    ;;
  "notarytool wait")
    outcome="$(next "wait-$3")" || outcome=Accepted
    case "$outcome" in
      drop) echo "Error: The network connection was lost."; exit 1 ;;
      *) printf '%s\\n' "$outcome" > "$stub/status-$3"; echo "Current status: $outcome...Processing complete"; echo "  id: $3"; echo "  status: $outcome" ;;
    esac
    ;;
  "notarytool log") echo '{"status": "Invalid", "issues": [{"message": "The binary is not signed."}]}' ;;
  "stapler staple")
    [ -f "$stub/ticket" ] && grep -qxF "$(basename "$3")" "$stub/ticket" || { echo "Could not validate ticket for $3"; exit 65; }
    echo "The staple and validate action worked!"
    ;;
  *) echo "unexpected xcrun $*" >&2; exit 2 ;;
esac
`;

const CODESIGN = `#!/usr/bin/env bash
path="\${@: -1}"
if [ "$1" = --verify ]; then
  case "$3" in "-R=anchor apple generic and certificate leaf"*) ;; *) echo "error: invalid or corrupted code requirement(s)" >&2; exit 1 ;; esac
  [ -f "$NOTARY_STUB/dmg-team" ] && { echo "$path: test-requirement: code failed to satisfy specified code requirement(s)" >&2; exit 3; }
  exit 0
fi
hash="$NOTARY_STUB/cdhash"
[ -f "$path/stub-cdhash" ] && hash="$path/stub-cdhash"
team=U5L5T3NGVV
case "$path" in *.dmg) [ -f "$NOTARY_STUB/dmg-team" ] && team="$(cat "$NOTARY_STUB/dmg-team")"; echo "TeamIdentifier=$team" >&2; exit 0 ;; esac
[ -f "$hash" ] || { echo "$path: code object is not signed at all" >&2; exit 1; }
echo "CDHash=$(cat "$hash")" >&2
echo "TeamIdentifier=$team" >&2
`;

const HDIUTIL = `#!/usr/bin/env bash
case "$1" in
  attach) [ -f "$NOTARY_STUB/attach-fails" ] && { echo "hdiutil: attach failed - Resource temporarily unavailable" >&2; exit 1; }
    mnt="$(printf '%s\\n' "$@" | awk 'prev == "-mountpoint" { print } { prev = $0 }')"; cp -R "$NOTARY_STUB/volume/." "$mnt/" ;;
  detach) find "$2" -mindepth 1 -delete ;;
esac
`;

function volume(stub, cdhash, extra = []) {
  const dir = join(stub, "volume");
  mkdirSync(join(dir, "Ardia.app"), { recursive: true });
  writeFileSync(join(dir, "Ardia.app", "stub-cdhash"), cdhash);
  for (const name of [".DS_Store", ".VolumeIcon.icns", ".background.tiff", ...extra]) writeFileSync(join(dir, name), "");
  mkdirSync(join(dir, ".fseventsd"));
  spawnSync("ln", ["-s", "/Applications", join(dir, "Applications")]);
}

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "ac-notarize-"));
  const bin = join(dir, "bin");
  const stub = join(dir, "stub");
  for (const d of [bin, stub, join(dir, "dist")]) mkdirSync(d);
  writeFileSync(join(bin, "xcrun"), XCRUN);
  chmodSync(join(bin, "xcrun"), 0o755);
  writeFileSync(join(bin, "codesign"), CODESIGN);
  chmodSync(join(bin, "codesign"), 0o755);
  writeFileSync(join(bin, "hdiutil"), HDIUTIL);
  chmodSync(join(bin, "hdiutil"), 0o755);
  const dmg = join(dir, "dist", "Ardia-1.2.3.dmg");
  writeFileSync(dmg, "a disk image");
  const state = join(dir, "state");
  const set = (name, lines) => writeFileSync(join(stub, name), lines.map((l) => `${l}\n`).join(""));
  const calls = () => (existsSync(join(stub, "calls")) ? readFileSync(join(stub, "calls"), "utf8").trim().split("\n").map((l) => l.split(" ").slice(0, 2).join(" ")) : []);
  const notarize = (target = dmg, extra = {}, more = []) => {
    const result = spawnSync("bash", [tool, target, join(dir, "dist"), ...more], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        NOTARY_STUB: stub,
        NOTARY_STATE_DIR: state,
        NOTARY_RETRY_DELAY: "0",
        NOTARY_KEY: join(dir, "AuthKey.p8"),
        NOTARY_KEY_ID: "KEYID",
        NOTARY_ISSUER: "issuer",
        ...extra,
      },
    });
    return { ...result, output: result.stdout + result.stderr };
  };
  const records = () => (existsSync(state) ? Object.fromEntries(readdirSync(state).filter((f) => !f.startsWith(".") && !f.endsWith(".dmg")).map((f) => [f, readFileSync(join(state, f), "utf8").split("\n")[0]])) : {});
  const keptSha = (key) => readFileSync(join(state, key), "utf8").split("\n")[1];
  const recordLine = (key, n) => readFileSync(join(state, key), "utf8").split("\n")[n];
  const kept = (key) => {
    const path = join(state, `${key}.${keptSha(key)}.dmg`);
    return existsSync(path) ? readFileSync(path, "utf8") : undefined;
  };
  const images = () => (existsSync(state) ? readdirSync(state).filter((f) => f.endsWith(".dmg")).sort() : []);
  const plant = (key, id, content, recordedContent = content, complete = false) => {
    mkdirSync(state, { recursive: true });
    const digest = createHash("sha256").update(recordedContent).digest("hex");
    writeFileSync(join(state, `${key}.${digest}.dmg`), content);
    writeFileSync(join(state, key), `${id}\n${digest}\n${complete ? "complete\n" : ""}`);
    return join(state, `${key}.${digest}.dmg`);
  };
  return { dir, dmg, state, stub, set, calls, notarize, records, keptSha, recordLine, kept, images, plant, ticket: (name = "Ardia-1.2.3.dmg") => writeFileSync(join(stub, "ticket"), `${name}\n`) };
}

function dmgKey(s, app, env = {}) {
  const probe = scratch();
  writeFileSync(join(probe.stub, "cdhash"), readFileSync(join(s.stub, "cdhash"), "utf8"));
  probe.set("submit", [FIRST]);
  probe.ticket();
  const run = probe.notarize(probe.dmg, env, [app]);
  assert.equal(run.status, 0, run.output);
  return Object.keys(probe.records())[0];
}

function sha256(path) {
  const out = spawnSync("bash", ["-c", 'if command -v shasum >/dev/null; then shasum -a 256 "$1"; else sha256sum "$1"; fi', "sha", path], { encoding: "utf8" });
  return `sha256-${out.stdout.split(" ")[0]}`;
}

test("a first submission records its id under the file's sha256 before waiting, then staples", () => {
  const s = scratch();
  s.set("submit", [FIRST]);
  s.ticket();
  const run = s.notarize();
  assert.equal(run.status, 0, run.output);
  assert.deepEqual(s.calls(), ["notarytool submit", "notarytool wait", "stapler staple"]);
  assert.deepEqual(s.records(), { [sha256(s.dmg)]: FIRST });
  assert.match(readFileSync(join(s.dir, "dist", "notary-Ardia-1.2.3.dmg.log"), "utf8"), /status: Accepted/);
});

test("a retry after the wait gave up picks the same submission up and never uploads again", () => {
  const s = scratch();
  s.set("submit", [FIRST]);
  s.set(`wait-${FIRST}`, ["drop", "drop", "drop", "drop", "drop"]);
  const first = s.notarize();
  assert.notEqual(first.status, 0);
  assert.match(first.output, /kept failing while waiting on 11111111.*running this again picks it up/);
  assert.deepEqual(s.records(), { [sha256(s.dmg)]: FIRST });
  rmSync(join(s.dir, "dist"), { recursive: true });
  mkdirSync(join(s.dir, "dist"));
  writeFileSync(s.dmg, "a disk image");
  writeFileSync(join(s.stub, "calls"), "");
  s.ticket();
  const retry = s.notarize();
  assert.equal(retry.status, 0, retry.output);
  assert.match(retry.output, /still in Apple's queue; waiting on it instead of uploading again/);
  assert.deepEqual(s.calls().filter(Boolean), ["notarytool info", "notarytool wait", "stapler staple"]);
});

test("a submission Apple already accepted is stapled without a wait or an upload", () => {
  const s = scratch();
  mkdirSync(s.state);
  writeFileSync(join(s.state, sha256(s.dmg)), `${FIRST}\n`);
  writeFileSync(join(s.stub, `status-${FIRST}`), "Accepted\n");
  s.ticket();
  const run = s.notarize();
  assert.equal(run.status, 0, run.output);
  assert.deepEqual(s.calls(), ["notarytool info", "stapler staple"]);
});

test("a rejected submission fails with Apple's log and doesn't resubmit the same file", () => {
  const s = scratch();
  mkdirSync(s.state);
  writeFileSync(join(s.state, sha256(s.dmg)), `${FIRST}\n`);
  writeFileSync(join(s.stub, `status-${FIRST}`), "Invalid\n");
  const run = s.notarize();
  assert.notEqual(run.status, 0);
  assert.match(run.output, /The binary is not signed/);
  assert.match(run.output, /Apple rejected submission 11111111-2222-4333-8444-555555555555 of Ardia-1.2.3.dmg/);
  assert.deepEqual(s.calls(), ["notarytool info", "notarytool log"]);
});

test("a rejection while waiting fails with the log too", () => {
  const s = scratch();
  s.set("submit", [FIRST]);
  s.set(`wait-${FIRST}`, ["Rejected"]);
  const run = s.notarize();
  assert.notEqual(run.status, 0);
  assert.match(run.output, /Apple rejected submission/);
  assert.deepEqual(s.calls(), ["notarytool submit", "notarytool wait", "notarytool log"]);
});

test("an id Apple doesn't know, a record that isn't an id, or new bytes each submit fresh", () => {
  const unknown = scratch();
  mkdirSync(unknown.state);
  writeFileSync(join(unknown.state, sha256(unknown.dmg)), `${FIRST}\n`);
  unknown.set("submit", [SECOND]);
  unknown.ticket();
  const a = unknown.notarize();
  assert.equal(a.status, 0, a.output);
  assert.deepEqual(unknown.calls(), ["notarytool info", "notarytool submit", "notarytool wait", "stapler staple"]);
  assert.deepEqual(unknown.records(), { [sha256(unknown.dmg)]: SECOND });

  const tampered = scratch();
  mkdirSync(tampered.state);
  writeFileSync(join(tampered.state, sha256(tampered.dmg)), "$(touch /tmp/pwned)\n");
  tampered.set("submit", [SECOND]);
  tampered.ticket();
  const b = tampered.notarize();
  assert.equal(b.status, 0, b.output);
  assert.match(b.output, /isn't a submission id/);
  assert.deepEqual(tampered.calls(), ["notarytool submit", "notarytool wait", "stapler staple"]);

  const rebuilt = scratch();
  mkdirSync(rebuilt.state);
  writeFileSync(join(rebuilt.state, sha256(rebuilt.dmg)), `${FIRST}\n`);
  writeFileSync(join(rebuilt.stub, `status-${FIRST}`), "Accepted\n");
  writeFileSync(rebuilt.dmg, "a different disk image");
  rebuilt.set("submit", [SECOND]);
  rebuilt.ticket();
  const c = rebuilt.notarize();
  assert.equal(c.status, 0, c.output);
  assert.deepEqual(rebuilt.calls(), ["notarytool submit", "notarytool wait", "stapler staple"]);
  assert.equal(Object.keys(rebuilt.records()).length, 2);
});

test("an accepted id whose ticket stapler can't fetch stops with the record kept, never uploading again", () => {
  const s = scratch();
  mkdirSync(s.state);
  writeFileSync(join(s.state, sha256(s.dmg)), `${FIRST}\n`);
  writeFileSync(join(s.stub, `status-${FIRST}`), "Accepted\n");
  const run = s.notarize();
  assert.notEqual(run.status, 0);
  assert.match(run.output, /Apple accepted submission 11111111.*couldn't fetch its ticket.*delete .* to submit it fresh/);
  assert.deepEqual(s.calls(), ["notarytool info", ...Array(5).fill("stapler staple")]);
  assert.deepEqual(s.records(), { [sha256(s.dmg)]: FIRST });
});

test("a cut-off upload is submitted again, up to three times", () => {
  const s = scratch();
  s.set("submit", ["", "", FIRST]);
  s.ticket();
  const run = s.notarize();
  assert.equal(run.status, 0, run.output);
  assert.deepEqual(s.calls(), ["notarytool submit", "notarytool submit", "notarytool submit", "notarytool wait", "stapler staple"]);
});

test("an app Apple already has a ticket for is stapled with no upload at all", () => {
  const s = scratch();
  const app = join(s.dir, "dist", "Ardia.app");
  mkdirSync(join(app, "Contents"), { recursive: true });
  s.ticket("Ardia.app");
  const run = s.notarize(app);
  assert.equal(run.status, 0, run.output);
  assert.match(run.output, /already notarized .*nothing uploaded/);
  assert.deepEqual(s.calls(), ["stapler staple"]);
});

test("when notarytool can't answer about a recorded id, it stops and keeps the record instead of uploading again", () => {
  const s = scratch();
  mkdirSync(s.state);
  writeFileSync(join(s.state, sha256(s.dmg)), `${FIRST}\n`);
  writeFileSync(join(s.stub, `status-${FIRST}`), "In Progress\n");
  const xcrun = join(s.dir, "bin", "xcrun");
  writeFileSync(xcrun, readFileSync(xcrun, "utf8").replace('"notarytool info")', '"notarytool info")\n    echo "Error: HTTP status code: 503. Service Unavailable"; exit 1'));
  const run = s.notarize();
  assert.notEqual(run.status, 0);
  assert.match(run.output, /couldn't ask Apple about submission 11111111.*stays recorded/);
  assert.deepEqual(s.calls(), ["notarytool info", "notarytool info", "notarytool info"]);
  assert.deepEqual(s.records(), { [sha256(s.dmg)]: FIRST });
});

test("the wait stops at NOTARY_WAIT_SECONDS with the id recorded, so a job deadline can't lose it", () => {
  const s = scratch();
  s.set("submit", [FIRST]);
  s.set(`wait-${FIRST}`, ["drop"]);
  const xcrun = join(s.dir, "bin", "xcrun");
  writeFileSync(xcrun, readFileSync(xcrun, "utf8").replace('drop) echo', 'drop) sleep 4; echo'));
  const run = s.notarize(s.dmg, { NOTARY_WAIT_SECONDS: "3" });
  assert.notEqual(run.status, 0);
  assert.match(run.output, /hasn't finished 11111111.* within NOTARY_WAIT_SECONDS \(3 s\).*waits on it instead of uploading/);
  assert.deepEqual(s.records(), { [sha256(s.dmg)]: FIRST });
  assert.match(readFileSync(join(s.stub, "calls"), "utf8"), /notarytool wait 11111111-2222-4333-8444-555555555555 .*--timeout [1-3]$/m);
});

test("a symlinked state directory is refused", () => {
  const s = scratch();
  mkdirSync(join(s.dir, "elsewhere"));
  spawnSync("ln", ["-s", join(s.dir, "elsewhere"), s.state]);
  const run = s.notarize();
  assert.notEqual(run.status, 0);
  assert.match(run.output, /is a symlink/);
  assert.deepEqual(s.calls(), []);
});

test("an app signed again, its zip's bytes changed, resumes the pending submission by its code's CDHash", { skip: process.platform !== "darwin" && "ditto is macOS's" }, () => {
  const s = scratch();
  const app = join(s.dir, "dist", "Ardia.app");
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  writeFileSync(join(app, "Contents", "MacOS", "Ardia"), "signed at 10:00");
  writeFileSync(join(s.stub, "cdhash"), "c0c480061bc60ca0bdb4e8a609fabb4168eebd52");
  s.set("submit", [FIRST]);
  s.set(`wait-${FIRST}`, ["drop", "drop", "drop", "drop", "drop"]);
  const first = s.notarize(app);
  assert.notEqual(first.status, 0);
  assert.deepEqual(s.records(), { "cdhash-c0c480061bc60ca0bdb4e8a609fabb4168eebd52": FIRST });
  writeFileSync(join(app, "Contents", "MacOS", "Ardia"), "signed again at 10:40, same code");
  writeFileSync(join(s.stub, "calls"), "");
  const xcrun = join(s.dir, "bin", "xcrun");
  writeFileSync(xcrun, readFileSync(xcrun, "utf8").replace('"stapler staple")', '"stapler staple")\n    [ "$(cat "$stub/status-11111111-2222-4333-8444-555555555555")" = Accepted ] && { echo ok; exit 0; }'));
  const retry = s.notarize(app);
  assert.equal(retry.status, 0, retry.output);
  assert.deepEqual(s.calls().filter(Boolean), ["stapler staple", "notarytool info", "notarytool wait", "stapler staple"]);
  assert.ok(!existsSync(join(s.dir, "dist", "notarize.zip")));
});

test("a DMG packed again resumes the submission of the copy it kept, and swaps that copy in", () => {
  const s = scratch();
  const app = join(s.dir, "dist", "Ardia.app");
  mkdirSync(join(app, "Contents"), { recursive: true });
  writeFileSync(join(s.stub, "cdhash"), "c0c480061bc60ca0bdb4e8a609fabb4168eebd52");
  writeFileSync(s.dmg, "the first packing");
  s.set("submit", [FIRST]);
  s.set(`wait-${FIRST}`, ["drop", "drop", "drop", "drop", "drop"]);
  const first = s.notarize(s.dmg, {}, [app]);
  assert.notEqual(first.status, 0);
  const key = Object.keys(s.records())[0];
  assert.match(key, /^dmg-of-cdhash-c0c480061bc60ca0bdb4e8a609fabb4168eebd52-packing-[0-9a-f]{16}$/);
  assert.equal(s.records()[key], FIRST);
  assert.equal(s.kept(key), "the first packing");
  writeFileSync(s.dmg, "the second packing, other bytes");
  writeFileSync(join(s.stub, "calls"), "");
  volume(s.stub, "c0c480061bc60ca0bdb4e8a609fabb4168eebd52");
  s.ticket();
  const retry = s.notarize(s.dmg, {}, [app]);
  assert.equal(retry.status, 0, retry.output);
  assert.deepEqual(s.calls().filter(Boolean), ["notarytool info", "notarytool wait", "stapler staple"]);
  assert.equal(readFileSync(s.dmg, "utf8"), "the first packing");
  assert.equal(s.kept(key), "the first packing", "the submitted copy stays for a later retry");
  assert.equal(s.recordLine(key, 2), "complete");
});

test("a record path that is a symlink to a directory is replaced by the record itself", () => {
  const s = scratch();
  mkdirSync(s.state);
  mkdirSync(join(s.dir, "elsewhere"));
  spawnSync("ln", ["-s", join(s.dir, "elsewhere"), join(s.state, sha256(s.dmg))]);
  s.set("submit", [FIRST]);
  s.ticket();
  const run = s.notarize();
  assert.equal(run.status, 0, run.output);
  assert.deepEqual(s.records(), { [sha256(s.dmg)]: FIRST });
  assert.deepEqual(readdirSync(join(s.dir, "elsewhere")), []);
});

test("an app codesign can't read falls back to its zip's hash instead of stopping", { skip: process.platform !== "darwin" && "ditto is macOS's" }, () => {
  const s = scratch();
  const app = join(s.dir, "dist", "Ardia.app");
  mkdirSync(join(app, "Contents"), { recursive: true });
  s.set("submit", [FIRST]);
  const xcrun = join(s.dir, "bin", "xcrun");
  writeFileSync(xcrun, readFileSync(xcrun, "utf8").replace('"stapler staple")', '"stapler staple")\n    [ -f "$stub/status-11111111-2222-4333-8444-555555555555" ] && { echo ok; exit 0; }'));
  const run = s.notarize(app);
  assert.equal(run.status, 0, run.output);
  assert.match(Object.keys(s.records())[0], /^sha256-[0-9a-f]{64}$/);
});

test("a kept DMG that isn't this app, this team's signature or the usual volume is discarded and the new one submitted", () => {
  for (const [name, setup] of [
    ["another app", (s) => volume(s.stub, "7f53ab0b1b9c9ffe40361bbe96a84fc7a4df9e00")],
    ["another signer", (s) => { volume(s.stub, "c0c480061bc60ca0bdb4e8a609fabb4168eebd52"); writeFileSync(join(s.stub, "dmg-team"), "ABCDE12345"); }],
    ["an extra file", (s) => volume(s.stub, "c0c480061bc60ca0bdb4e8a609fabb4168eebd52", ["install-me.command"])],
  ]) {
    const s = scratch();
    const app = join(s.dir, "dist", "Ardia.app");
    mkdirSync(join(app, "Contents"), { recursive: true });
    writeFileSync(join(s.stub, "cdhash"), "c0c480061bc60ca0bdb4e8a609fabb4168eebd52");
    const key = dmgKey(s, app);
    s.plant(key, FIRST, "planted");
    writeFileSync(join(s.stub, `status-${FIRST}`), "Accepted\n");
    setup(s);
    s.set("submit", [SECOND]);
    s.ticket();
    const run = s.notarize(s.dmg, {}, [app]);
    assert.equal(run.status, 0, `${name}: ${run.output}`);
    assert.match(run.output, /isn't this app packed by this team/, name);
    assert.equal(readFileSync(s.dmg, "utf8"), "a disk image", name);
    assert.deepEqual(s.calls(), ["notarytool submit", "notarytool wait", "stapler staple"], name);
  }
});

test("an info status this script doesn't know stops with the record kept, never uploading again", () => {
  const s = scratch();
  mkdirSync(s.state);
  writeFileSync(join(s.state, sha256(s.dmg)), `${FIRST}\n`);
  writeFileSync(join(s.stub, `status-${FIRST}`), "Processing\n");
  const run = s.notarize();
  assert.notEqual(run.status, 0);
  assert.match(run.output, /Apple answered 'Processing' about submission 11111111.*nothing is uploaded again/);
  assert.deepEqual(s.calls(), ["notarytool info"]);
  assert.deepEqual(s.records(), { [sha256(s.dmg)]: FIRST });
});

test("a kept DMG that won't staple leaves this run's DMG in place and stops", () => {
  const s = scratch();
  const app = join(s.dir, "dist", "Ardia.app");
  mkdirSync(join(app, "Contents"), { recursive: true });
  writeFileSync(join(s.stub, "cdhash"), "c0c480061bc60ca0bdb4e8a609fabb4168eebd52");
  const key = dmgKey(s, app);
  s.plant(key, FIRST, "the earlier packing");
  writeFileSync(join(s.stub, `status-${FIRST}`), "Accepted\n");
  volume(s.stub, "c0c480061bc60ca0bdb4e8a609fabb4168eebd52");
  const run = s.notarize(s.dmg, {}, [app]);
  assert.notEqual(run.status, 0);
  assert.match(run.output, /couldn't fetch its ticket/);
  assert.equal(readFileSync(s.dmg, "utf8"), "a disk image");
  assert.equal(s.kept(key), "the earlier packing", "the kept copy stays for the next try");
  assert.deepEqual(s.calls().filter((c) => c !== "stapler staple"), ["notarytool info"]);
  assert.deepEqual(readdirSync(join(s.dir, "dist")).filter((n) => n.startsWith(".kept")), []);
});

test("the DMG's key changes with the packing settings, so an image packed another way is never reused", () => {
  const s = scratch();
  const app = join(s.dir, "dist", "Ardia.app");
  mkdirSync(join(app, "Contents"), { recursive: true });
  writeFileSync(join(s.stub, "cdhash"), "c0c480061bc60ca0bdb4e8a609fabb4168eebd52");
  const on = dmgKey(s, app);
  assert.equal(dmgKey(s, app, { ARDIA_DMG_CHUNK: "on" }), on);
  assert.notEqual(dmgKey(s, app, { ARDIA_DMG_CHUNK: "off" }), on);
});


test("a packing input that can't be hashed keys the DMG by its own bytes instead", () => {
  const real = spawnSync("bash", ["-c", "command -v shasum"], { encoding: "utf8" }).stdout.trim();
  if (!real) return;
  const s = scratch();
  const app = join(s.dir, "dist", "Ardia.app");
  mkdirSync(join(app, "Contents"), { recursive: true });
  writeFileSync(join(s.stub, "cdhash"), "c0c480061bc60ca0bdb4e8a609fabb4168eebd52");
  writeFileSync(join(s.dir, "bin", "shasum"), `#!/usr/bin/env bash\ncase "$*" in *background.tiff*) exit 1 ;; esac\nexec ${real} "$@"\n`);
  chmodSync(join(s.dir, "bin", "shasum"), 0o755);
  s.set("submit", [FIRST]);
  s.ticket();
  const run = s.notarize(s.dmg, {}, [app]);
  assert.equal(run.status, 0, run.output);
  assert.deepEqual(Object.keys(s.records()), [sha256(s.dmg)]);
});

test("a kept DMG hdiutil can't mount stops with the record and the copy kept, never uploading again", () => {
  const s = scratch();
  const app = join(s.dir, "dist", "Ardia.app");
  mkdirSync(join(app, "Contents"), { recursive: true });
  writeFileSync(join(s.stub, "cdhash"), "c0c480061bc60ca0bdb4e8a609fabb4168eebd52");
  writeFileSync(s.dmg, "the first packing");
  s.set("submit", [FIRST]);
  s.set(`wait-${FIRST}`, ["drop", "drop", "drop", "drop", "drop"]);
  assert.notEqual(s.notarize(s.dmg, {}, [app]).status, 0);
  const key = Object.keys(s.records())[0];
  writeFileSync(s.dmg, "the second packing, other bytes");
  writeFileSync(join(s.stub, "calls"), "");
  writeFileSync(join(s.stub, "attach-fails"), "");
  s.set("submit", [SECOND]);
  s.ticket();
  const retry = s.notarize(s.dmg, {}, [app]);
  assert.notEqual(retry.status, 0);
  assert.match(retry.output, /couldn't mount .*stay as they are/);
  assert.deepEqual(s.calls().filter(Boolean), []);
  assert.equal(s.records()[key], FIRST);
  assert.equal(s.kept(key), "the first packing");
});

function dmgScratch() {
  const s = scratch();
  const app = join(s.dir, "dist", "Ardia.app");
  mkdirSync(join(app, "Contents"), { recursive: true });
  writeFileSync(join(s.stub, "cdhash"), "c0c480061bc60ca0bdb4e8a609fabb4168eebd52");
  volume(s.stub, "c0c480061bc60ca0bdb4e8a609fabb4168eebd52");
  return { s, app, key: dmgKey(s, app) };
}

test("a kept copy whose sha256 isn't the one recorded with the id is never resumed: another run's image is never paired with this id", () => {
  const { s, app, key } = dmgScratch();
  s.plant(key, FIRST, "image B, written by a run whose upload failed", "image A, the one submission FIRST was made from");
  writeFileSync(join(s.stub, `status-${FIRST}`), "Accepted\n");
  s.set("submit", [SECOND]);
  s.ticket();
  const run = s.notarize(s.dmg, {}, [app]);
  assert.equal(run.status, 0, run.output);
  assert.match(run.output, /no kept copy is the file .* names for submission 11111111-2222-4333-8444-555555555555 \(missing, or its sha256 differs\)/);
  assert.deepEqual(s.calls(), ["notarytool submit", "notarytool wait", "stapler staple"]);
  assert.equal(readFileSync(s.dmg, "utf8"), "a disk image");
  assert.equal(s.records()[key], SECOND);
  assert.equal(s.keptSha(key), createHash("sha256").update("a disk image").digest("hex"));
});


test("the stapled DMG stays with its id and sha256, so a retry after a later release step failed staples it again without uploading", () => {
  const { s, app, key } = dmgScratch();
  s.set("submit", [FIRST]);
  s.ticket();
  const first = s.notarize(s.dmg, {}, [app]);
  assert.equal(first.status, 0, first.output);
  assert.equal(s.kept(key), "a disk image");
  assert.equal(s.recordLine(key, 2), "complete");
  writeFileSync(s.dmg, "packed again after the launch check failed");
  writeFileSync(join(s.stub, "calls"), "");
  const retry = s.notarize(s.dmg, {}, [app]);
  assert.equal(retry.status, 0, retry.output);
  assert.deepEqual(s.calls(), ["notarytool info", "stapler staple"]);
  assert.equal(readFileSync(s.dmg, "utf8"), "a disk image");
});

function holdLock(path) {
  const holder = spawn("perl", ["-MFcntl=:flock", "-e", 'open(my $fh, ">>", $ARGV[0]) or die; flock($fh, LOCK_EX) or die; print "held\\n"; $| = 1; sleep 60;', path], { stdio: ["ignore", "pipe", "inherit"] });
  return new Promise((resolve, reject) => {
    holder.stdout.once("data", () => resolve(holder));
    holder.once("exit", (code) => reject(new Error(`the lock holder exited (${code})`)));
  });
}

test("one notarize.sh at a time per state directory: a second waits NOTARY_LOCK_SECONDS and stops, and a killed holder frees the lock", async () => {
  const { s, app, key } = dmgScratch();
  mkdirSync(s.state, { recursive: true });
  const holder = await holdLock(join(s.state, ".lock"));
  s.set("submit", [FIRST]);
  s.ticket();
  const busy = s.notarize(s.dmg, { NOTARY_LOCK_SECONDS: "1" }, [app]);
  assert.notEqual(busy.status, 0);
  assert.match(busy.output, /another notarize.sh holds .*\.lock \(waited 1 s, NOTARY_LOCK_SECONDS\)/);
  assert.deepEqual(s.calls(), []);
  holder.kill("SIGKILL");
  await new Promise((resolve) => holder.once("exit", resolve));
  const after = s.notarize(s.dmg, { NOTARY_LOCK_SECONDS: "1" }, [app]);
  assert.equal(after.status, 0, after.output);
  assert.equal(s.records()[key], FIRST);
});

test("lock directories an older notarize.sh left behind block nothing", () => {
  const { s, app, key } = dmgScratch();
  mkdirSync(join(s.state, `${key}.lock`), { recursive: true });
  mkdirSync(join(s.state, `${key}.lock.stale.123`), { recursive: true });
  s.set("submit", [FIRST]);
  s.ticket();
  const run = s.notarize(s.dmg, {}, [app]);
  assert.equal(run.status, 0, run.output);
});

test("the bytes submitted are the bytes hashed: a DMG repacked during the upload never pairs its digest with another image", () => {
  const { s, app, key } = dmgScratch();
  const xcrun = join(s.dir, "bin", "xcrun");
  writeFileSync(xcrun, readFileSync(xcrun, "utf8").replace('"notarytool submit")', `"notarytool submit")\n    shasum -a 256 "$3" | cut -c1-64 > "$stub/submitted-sha"\n    printf 'repacked meanwhile' > "${s.dmg}"`));
  s.set("submit", [FIRST]);
  s.ticket();
  const run = s.notarize(s.dmg, {}, [app]);
  assert.equal(run.status, 0, run.output);
  const submitted = readFileSync(join(s.stub, "submitted-sha"), "utf8").trim();
  assert.equal(submitted, createHash("sha256").update("a disk image").digest("hex"));
  assert.equal(s.keptSha(key), submitted);
  assert.equal(s.kept(key), "a disk image");
  assert.equal(readFileSync(s.dmg, "utf8"), "a disk image", "the stapled copy of the submitted bytes replaces the repacked file");
});

test("a failure right after stapling keeps the accepted image and its record paired, so the retry staples it without uploading", () => {
  const real = spawnSync("bash", ["-c", "command -v mktemp"], { encoding: "utf8" }).stdout.trim();
  const { s, app, key } = dmgScratch();
  writeFileSync(join(s.dir, "bin", "mktemp"), `#!/usr/bin/env bash\ncase "$*" in *.record.*) [ -f "$NOTARY_STUB/fail-record" ] && exit 1 ;; esac\nexec ${real} "$@"\n`);
  chmodSync(join(s.dir, "bin", "mktemp"), 0o755);
  const xcrun = join(s.dir, "bin", "xcrun");
  writeFileSync(xcrun, readFileSync(xcrun, "utf8").replace('    echo "The staple and validate action worked!"', '    printf "+ticket" >> "$3"; [ -f "$stub/arm" ] && { rm "$stub/arm"; touch "$stub/fail-record"; }\n    echo "The staple and validate action worked!"'));
  s.set("submit", [FIRST]);
  s.ticket();
  writeFileSync(join(s.stub, "arm"), "");
  const crashed = s.notarize(s.dmg, {}, [app]);
  assert.notEqual(crashed.status, 0, "the record update after stapling failed");
  assert.equal(s.kept(key), "a disk image", "the submitted image is untouched by the staple");
  assert.equal(s.keptSha(key), createHash("sha256").update("a disk image").digest("hex"));
  rmSync(join(s.stub, "fail-record"));
  writeFileSync(s.dmg, "packed again for the retry");
  writeFileSync(join(s.stub, "calls"), "");
  const retry = s.notarize(s.dmg, {}, [app]);
  assert.equal(retry.status, 0, retry.output);
  assert.deepEqual(s.calls(), ["notarytool info", "stapler staple"]);
  assert.equal(readFileSync(s.dmg, "utf8"), "a disk image+ticket");
});

test("pruning removes only old images of accepted, stapled submissions and strays, never a pending one's", () => {
  const { s, app } = dmgScratch();
  const pending = s.plant("dmg-of-cdhash-aaaa-packing-0000000000000000", FIRST, "an image Apple is still processing");
  const done = s.plant("dmg-of-cdhash-bbbb-packing-1111111111111111", SECOND, "an image stapled last week", undefined, true);
  const stray = join(s.state, `dmg-of-cdhash-cccc-packing-2222222222222222.${"0".repeat(64)}.dmg`);
  writeFileSync(stray, "an image no record names");
  const fresh = s.plant("dmg-of-cdhash-dddd-packing-3333333333333333", SECOND, "an image stapled today", undefined, true);
  for (const path of [pending, done, stray]) spawnSync("touch", ["-t", "202001010000", path]);
  s.set("submit", [FIRST]);
  s.ticket();
  const run = s.notarize(s.dmg, {}, [app]);
  assert.equal(run.status, 0, run.output);
  assert.ok(existsSync(pending), "a pending submission's only copy stays");
  assert.ok(!existsSync(done), "an old stapled image goes");
  assert.ok(!existsSync(stray), "an old image no record names goes");
  assert.ok(existsSync(fresh), "a recent stapled image stays");
});

test("a record the previous version wrote, with its copy at <key>.dmg, still resumes", () => {
  const { s, app, key } = dmgScratch();
  mkdirSync(s.state, { recursive: true });
  writeFileSync(join(s.state, `${key}.dmg`), "the earlier packing");
  writeFileSync(join(s.state, key), `${FIRST}\n${createHash("sha256").update("the earlier packing").digest("hex")}\n`);
  writeFileSync(join(s.stub, `status-${FIRST}`), "Accepted\n");
  s.ticket();
  const run = s.notarize(s.dmg, {}, [app]);
  assert.equal(run.status, 0, run.output);
  assert.deepEqual(s.calls(), ["notarytool info", "stapler staple"]);
  assert.equal(readFileSync(s.dmg, "utf8"), "the earlier packing");
  assert.equal(s.recordLine(key, 2), "complete");
});
